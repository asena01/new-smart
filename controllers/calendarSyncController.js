import Hotel from '../models/Hotel.js';
import Booking from '../models/Booking.js';
import ExternalRoomBlock from '../models/ExternalRoomBlock.js';
import RoomCalendar from '../models/RoomCalendar.js';
import { buildIcs } from '../utils/icalUtils.js';
import { canManageHotel } from '../utils/staffAuth.js';
import { getExternalStays } from '../utils/externalBlocks.js';
import { addFeedToRoom, getOrCreateCalendar, newExportToken, syncRoomCalendar } from '../services/calendarSyncService.js';

async function resolveHostRoom(req, res) {
  const hotel = await Hotel.findOne({ hostId: req.user.userId });
  if (!hotel) {
    res.status(404).json({ message: 'Hotel not found' });
    return null;
  }
  const room = hotel.rooms.id(req.params.roomId);
  if (!room) {
    res.status(404).json({ message: 'Room not found' });
    return null;
  }
  return { hotel, room };
}

// Feed URLs carry a private token in their query string, so the host UI only ever gets the
// hostname back — enough to recognize which feed is which without exposing the secret.
function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function serializeFeed(feed) {
  return {
    _id: feed._id,
    name: feed.name,
    host: hostnameOf(feed.url),
    lastSyncedAt: feed.lastSyncedAt,
    lastError: feed.lastError,
    eventCount: feed.eventCount,
    conflictCount: feed.conflictCount,
  };
}

async function serializeCalendar(calendar) {
  const blocks = await ExternalRoomBlock.find({ hotelId: calendar.hotelId, roomObjectId: calendar.roomObjectId })
    .sort({ startDate: 1 })
    .limit(100)
    .lean();

  return {
    exportToken: calendar.exportToken,
    feeds: calendar.feeds.map(serializeFeed),
    blocks: blocks.map(block => ({
      source: block.source,
      startDate: block.startDate,
      endDate: block.endDate,
      conflictBookingReference: block.conflictBookingReference,
    })),
  };
}

export const getRoomCalendar = async (req, res) => {
  try {
    const resolved = await resolveHostRoom(req, res);
    if (!resolved) return;
    const calendar = await getOrCreateCalendar(resolved.hotel._id, resolved.room._id);
    res.json(await serializeCalendar(calendar));
  } catch (error) {
    console.error('Error loading room calendar:', error);
    res.status(500).json({ message: 'Failed to load calendar sync settings' });
  }
};

export const addFeed = async (req, res) => {
  try {
    const resolved = await resolveHostRoom(req, res);
    if (!resolved) return;

    const result = await addFeedToRoom(resolved.hotel, resolved.room, req.body.name, req.body.url);
    if (!result.ok) return res.status(result.status).json({ message: result.message });

    res.status(201).json(await serializeCalendar(result.calendar));
  } catch (error) {
    console.error('Error adding calendar feed:', error);
    res.status(500).json({ message: 'Failed to add the calendar link' });
  }
};

export const removeFeed = async (req, res) => {
  try {
    const resolved = await resolveHostRoom(req, res);
    if (!resolved) return;

    const calendar = await getOrCreateCalendar(resolved.hotel._id, resolved.room._id);
    const feed = calendar.feeds.id(req.params.feedId);
    if (!feed) return res.status(404).json({ message: 'Calendar link not found' });

    await ExternalRoomBlock.deleteMany({ feedId: feed._id });
    feed.deleteOne();
    await calendar.save();
    res.json(await serializeCalendar(calendar));
  } catch (error) {
    console.error('Error removing calendar feed:', error);
    res.status(500).json({ message: 'Failed to remove the calendar link' });
  }
};

export const syncNow = async (req, res) => {
  try {
    const resolved = await resolveHostRoom(req, res);
    if (!resolved) return;

    const calendar = await getOrCreateCalendar(resolved.hotel._id, resolved.room._id);
    await syncRoomCalendar(calendar, resolved.room.roomNumber);
    res.json(await serializeCalendar(calendar));
  } catch (error) {
    console.error('Error syncing room calendar:', error);
    res.status(500).json({ message: 'Failed to sync the calendar' });
  }
};

// Issues a new export link and invalidates the old one — for when the link was shared with the
// wrong party or posted somewhere it shouldn't have been. Platforms already subscribed to the
// old link will need the new one.
export const rotateExportToken = async (req, res) => {
  try {
    const resolved = await resolveHostRoom(req, res);
    if (!resolved) return;

    const calendar = await getOrCreateCalendar(resolved.hotel._id, resolved.room._id);
    calendar.exportToken = newExportToken();
    await calendar.save();
    res.json(await serializeCalendar(calendar));
  } catch (error) {
    console.error('Error rotating export token:', error);
    res.status(500).json({ message: 'Failed to create a new export link' });
  }
};

// Public by design — other platforms fetch this without logging in. The unguessable token in
// the URL is the credential, so every miss returns the same plain 404.
export const exportCalendar = async (req, res) => {
  try {
    const token = String(req.params.token || '').replace(/\.ics$/i, '');
    const calendar = await RoomCalendar.findOne({ exportToken: token });
    if (!calendar) return res.status(404).send('Not found');

    const hotel = await Hotel.findById(calendar.hotelId).select('name rooms');
    const room = hotel?.rooms.id(calendar.roomObjectId);
    if (!room) return res.status(404).send('Not found');

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const bookings = await Booking.find({
      hotelId: calendar.hotelId,
      roomId: room.roomNumber,
      status: { $ne: 'cancelled' },
      checkOutDate: { $gt: since },
    }).select('checkInDate checkOutDate');

    // Only this platform's own bookings — never the stays imported from other calendars, which
    // would bounce a platform's own reservations back to it as if they were new ones.
    const events = bookings.map(booking => ({
      uid: `booking-${booking._id}@finsmarthotels.com`,
      start: booking.checkInDate,
      end: booking.checkOutDate,
    }));

    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="room-calendar.ics"',
      'Cache-Control': 'private, max-age=300',
    });
    res.send(buildIcs(`${hotel.name} - Room ${room.roomNumber}`, events));
  } catch (error) {
    console.error('Error exporting room calendar:', error);
    res.status(500).send('Error');
  }
};

// Stays imported from other platforms for the front desk and bookings pages. Same access rule as
// the bookings list itself: the host, an admin, or staff granted canManageReservations.
export const getHotelStays = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const hotel = await Hotel.findById(hotelId).select('rooms location policies');
    if (!hotel) return res.status(404).json({ message: 'Hotel not found' });
    if (!(await canManageHotel(req, hotelId, 'canManageReservations'))) {
      return res.status(403).json({ message: "Not authorized to view this hotel's bookings" });
    }

    const { today, stays } = await getExternalStays(hotel);
    res.json({ today, stays });
  } catch (error) {
    console.error('Error loading imported stays:', error);
    res.status(500).json({ message: 'Failed to load stays from other platforms' });
  }
};

// ---- Hotel-wide ---------------------------------------------------------------------------

async function resolveHostHotel(req, res) {
  const hotel = await Hotel.findOne({ hostId: req.user.userId });
  if (!hotel) {
    res.status(404).json({ message: 'Hotel not found' });
    return null;
  }
  return hotel;
}

// Every room of the hotel with the calendar links connected to it, so the whole picture is one
// request. Rooms that never had a link simply have an empty list — nothing is created here.
async function serializeHotelCalendars(hotel) {
  const calendars = await RoomCalendar.find({ hotelId: hotel._id });
  const byRoom = new Map(calendars.map(calendar => [String(calendar.roomObjectId), calendar]));

  return {
    rooms: hotel.rooms.map(room => {
      const calendar = byRoom.get(String(room._id));
      return {
        roomId: room._id,
        roomNumber: room.roomNumber,
        type: room.type,
        feeds: calendar ? calendar.feeds.map(serializeFeed) : [],
      };
    }),
  };
}

export const getHotelCalendars = async (req, res) => {
  try {
    const hotel = await resolveHostHotel(req, res);
    if (!hotel) return;
    res.json(await serializeHotelCalendars(hotel));
  } catch (error) {
    console.error('Error loading hotel calendars:', error);
    res.status(500).json({ message: 'Failed to load calendar sync' });
  }
};

// Refreshes every connected link in the hotel now, one room at a time (each is an outbound
// request to a third party). The background job does the same thing every 30 minutes; this is
// for when the host wants the answer immediately.
export const syncHotelCalendars = async (req, res) => {
  try {
    const hotel = await resolveHostHotel(req, res);
    if (!hotel) return;

    const calendars = await RoomCalendar.find({ hotelId: hotel._id, 'feeds.0': { $exists: true } });
    for (const calendar of calendars) {
      const room = hotel.rooms.id(calendar.roomObjectId);
      if (!room) continue;
      await syncRoomCalendar(calendar, room.roomNumber);
    }
    res.json(await serializeHotelCalendars(hotel));
  } catch (error) {
    console.error('Error syncing hotel calendars:', error);
    res.status(500).json({ message: 'Failed to sync the calendars' });
  }
};

const MAX_BULK_ITEMS = 30;

// Adds several links in one go, each to its own room. One bad row never blocks the others —
// every row gets its own result so the host can fix just the ones that failed.
export const addHotelFeeds = async (req, res) => {
  try {
    const hotel = await resolveHostHotel(req, res);
    if (!hotel) return;

    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (items.length === 0) return res.status(400).json({ message: 'Add at least one calendar link' });
    if (items.length > MAX_BULK_ITEMS) return res.status(400).json({ message: `Add at most ${MAX_BULK_ITEMS} links at a time` });

    const results = [];
    for (const item of items) {
      const room = hotel.rooms.id(item?.roomId);
      if (!room) {
        results.push({ roomId: item?.roomId, ok: false, message: 'Choose a room' });
        continue;
      }
      const result = await addFeedToRoom(hotel, room, item.name, item.url);
      results.push({ roomId: String(room._id), ok: result.ok, message: result.ok ? null : result.message });
    }

    res.json({ results, ...(await serializeHotelCalendars(hotel)) });
  } catch (error) {
    console.error('Error adding hotel calendar feeds:', error);
    res.status(500).json({ message: 'Failed to add the calendar links' });
  }
};

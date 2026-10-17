import crypto from 'crypto';
import Booking from '../models/Booking.js';
import Hotel from '../models/Hotel.js';
import RoomCalendar from '../models/RoomCalendar.js';
import ExternalRoomBlock from '../models/ExternalRoomBlock.js';
import { fetchFeedEvents, normalizeFeedUrl } from '../utils/icalUtils.js';
import { runInTransaction } from '../utils/transactionUtils.js';
import { createNotification } from '../utils/notificationUtils.js';

function toUtcDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function newExportToken() {
  return crypto.randomBytes(32).toString('hex');
}

export async function getOrCreateCalendar(hotelId, roomObjectId) {
  const existing = await RoomCalendar.findOne({ hotelId, roomObjectId });
  if (existing) return existing;
  try {
    return await RoomCalendar.create({ hotelId, roomObjectId, exportToken: newExportToken(), feeds: [] });
  } catch (error) {
    // Two first requests for the same room can race to create it; the unique index makes the
    // loser fail, and the winner's document is the one to use.
    if (error.code === 11000) return RoomCalendar.findOne({ hotelId, roomObjectId });
    throw error;
  }
}

function friendlyError(error) {
  if (error.code === 'ECONNABORTED') return 'The calendar link took too long to respond';
  if (error.code === 'ENOTFOUND') return "The calendar link's address could not be found";
  if (error.response?.status) return `The calendar provider returned an error (HTTP ${error.response.status})`;
  if (/maxContentLength|maxBodyLength/.test(error.message || '')) return 'The calendar file is too large';
  return error.message || 'The calendar could not be read';
}

function conflictKey(block) {
  return `${block.uid}|${new Date(block.startDate).toISOString()}|${new Date(block.endDate).toISOString()}|${block.conflictBookingReference}`;
}

function shortDate(date) {
  return new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// One notification per sync, however many overlaps it found — a feed that suddenly reports
// several clashes should be one message to act on, not a burst.
async function notifyHostOfConflicts(calendar, roomNumber, conflicts) {
  const hotel = await Hotel.findById(calendar.hotelId).select('hostId');
  if (!hotel?.hostId) return;

  const message = conflicts.length === 1
    ? `Room ${roomNumber}: the stay on ${conflicts[0].source} (${shortDate(conflicts[0].startDate)} to ${shortDate(conflicts[0].endDate)}) overlaps booking ${conflicts[0].conflictBookingReference}. One of them needs to be moved or cancelled.`
    : `Room ${roomNumber}: ${conflicts.length} stays on other platforms overlap bookings made here (${conflicts.map(c => c.conflictBookingReference).join(', ')}). They need to be moved or cancelled.`;

  await createNotification({
    userId: hotel.hostId,
    type: 'alert',
    title: 'Double booking detected',
    message,
    link: '/host/bookings',
    actionLabel: 'View Bookings'
  });
}

// Pulls one feed and replaces that feed's imported stays with what it contains now. On any
// failure the previously imported stays are left exactly as they were — a feed that is briefly
// unreachable must not suddenly re-open dates that are still taken on the other platform.
// `fetchEvents` is a seam for tests — production always uses the real fetcher. Returns
// { ok, newConflicts }: newConflicts are overlaps with a booking made here that this feed had
// not already been flagged for, so the caller can tell the host about each one only once.
export async function syncFeed(calendar, feed, roomNumber, { fetchEvents = fetchFeedEvents } = {}) {
  try {
    const events = await fetchEvents(feed.url);
    const today = toUtcDay(new Date());
    const upcoming = events.filter(event => event.end > today);

    const bookings = upcoming.length
      ? await Booking.find({
          hotelId: calendar.hotelId,
          roomId: roomNumber,
          status: { $ne: 'cancelled' },
          checkOutDate: { $gt: today },
        }).select('bookingReference checkInDate checkOutDate')
      : [];

    const blocks = upcoming.map(event => {
      const clash = bookings.find(
        booking => toUtcDay(booking.checkInDate) < event.end && toUtcDay(booking.checkOutDate) > event.start
      );
      return {
        hotelId: calendar.hotelId,
        roomObjectId: calendar.roomObjectId,
        feedId: feed._id,
        source: feed.name,
        uid: event.uid,
        summary: event.summary,
        startDate: event.start,
        endDate: event.end,
        conflictBookingReference: clash ? clash.bookingReference : null,
      };
    });

    // What this feed was already flagged for, captured before the blocks are rewritten, so a
    // conflict that simply persists across syncs is not reported again.
    const previouslyFlagged = new Set(
      (await ExternalRoomBlock.find({ feedId: feed._id, conflictBookingReference: { $ne: null } })
        .select('uid startDate endDate conflictBookingReference').lean())
        .map(block => conflictKey(block))
    );

    await runInTransaction(async session => {
      await ExternalRoomBlock.deleteMany({ feedId: feed._id }, { session });
      if (blocks.length) await ExternalRoomBlock.insertMany(blocks, { session });
    });

    feed.lastSyncedAt = new Date();
    feed.lastError = null;
    feed.eventCount = blocks.length;
    feed.conflictCount = blocks.filter(block => block.conflictBookingReference).length;
    const newConflicts = blocks.filter(block => block.conflictBookingReference && !previouslyFlagged.has(conflictKey(block)));
    return { ok: true, newConflicts };
  } catch (error) {
    feed.lastError = friendlyError(error);
    return { ok: false, newConflicts: [] };
  }
}

export async function syncRoomCalendar(calendar, roomNumber, options) {
  const newConflicts = [];
  for (const feed of calendar.feeds) {
    const result = await syncFeed(calendar, feed, roomNumber, options);
    newConflicts.push(...result.newConflicts);
  }
  await calendar.save();

  if (newConflicts.length > 0) {
    // The sync itself already succeeded and is saved; a notification problem must not fail it.
    await notifyHostOfConflicts(calendar, roomNumber, newConflicts)
      .catch(error => console.error('Error notifying host of calendar conflicts:', error.message));
  }
  return calendar;
}

export const MAX_FEEDS_PER_ROOM = 5;

// The one place a calendar link gets validated, read once, and saved — shared by the per-room
// panel and the hotel-wide bulk add, so both enforce exactly the same rules. Returns
// { ok: true, calendar } or { ok: false, status, message }.
export async function addFeedToRoom(hotel, room, rawName, rawUrl) {
  const name = String(rawName || '').trim();
  if (!name) return { ok: false, status: 400, message: 'Enter a name for this calendar, e.g. Airbnb' };
  if (name.length > 60) return { ok: false, status: 400, message: 'The name must be 60 characters or fewer' };

  let url;
  try {
    url = normalizeFeedUrl(rawUrl);
  } catch (error) {
    return { ok: false, status: 400, message: error.message };
  }

  // One of our own export links (the one handed TO a platform) pasted as if it were theirs: the room
  // would then import its own bookings back as "blocked by another platform" and flag them as clashes.
  const ownExport = /\/api\/calendar-sync\/export\/([a-f0-9]{20,})\.ics$/i.exec(new URL(url).pathname);
  if (ownExport && await RoomCalendar.exists({ exportToken: ownExport[1] })) {
    return {
      ok: false,
      status: 400,
      message: "That is a FinSmartHotels export link: the one you give to a platform. Paste the link you copied FROM the platform (Airbnb, Booking.com, Expedia...) instead."
    };
  }

  // The same platform link on two rooms would block both rooms together, whichever one is booked.
  const sameLinkElsewhere = await RoomCalendar.findOne({ hotelId: hotel._id, roomObjectId: { $ne: room._id }, 'feeds.url': url });
  if (sameLinkElsewhere) {
    const other = hotel.rooms.id(sameLinkElsewhere.roomObjectId);
    return {
      ok: false,
      status: 409,
      message: `That link is already connected to room ${other?.roomNumber || 'another room'}. Each room on the platform has its own link; using one link on several rooms would block them all together.`
    };
  }

  const calendar = await getOrCreateCalendar(hotel._id, room._id);
  if (calendar.feeds.length >= MAX_FEEDS_PER_ROOM) {
    return { ok: false, status: 400, message: `A room can have at most ${MAX_FEEDS_PER_ROOM} calendar links` };
  }
  if (calendar.feeds.some(feed => feed.url === url)) {
    return { ok: false, status: 409, message: 'That calendar link is already connected to this room' };
  }

  calendar.feeds.push({ name, url });
  const feed = calendar.feeds[calendar.feeds.length - 1];

  // Reads the link right away: one that can't be fetched or isn't a calendar is rejected here,
  // rather than saved and left failing silently until someone looks at the sync status.
  const { ok } = await syncFeed(calendar, feed, room.roomNumber);
  if (!ok) return { ok: false, status: 400, message: feed.lastError };

  await calendar.save();
  return { ok: true, calendar };
}

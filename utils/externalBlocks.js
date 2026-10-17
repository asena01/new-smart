import ExternalRoomBlock from '../models/ExternalRoomBlock.js';
import { resolveHotelTimeZone } from './hotelTime.js';

// Same normalization as nightsBetween() in bookingController.js: a booking's own time-of-day
// is ignored and only its UTC calendar day counts, so imported blocks (stored as UTC-midnight
// days) and booking nights are always compared on the same footing.
function toUtcDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function overlapQuery(checkIn, checkOut) {
  return { startDate: { $lt: toUtcDay(checkOut) }, endDate: { $gt: toUtcDay(checkIn) } };
}

// True when a stay imported from another platform's calendar already covers any night of this
// range for this room. Not part of RoomBookingHold's atomic guarantee — imports are eventually
// consistent by nature (a sync every ~30 minutes), so this is a best-effort check at booking time.
export async function hasExternalBlock(hotelId, roomObjectId, checkIn, checkOut) {
  const block = await ExternalRoomBlock.exists({ hotelId, roomObjectId, ...overlapQuery(checkIn, checkOut) });
  return !!block;
}

// Room _ids (as strings) with an imported stay overlapping the range — for filtering a hotel's
// whole room list in one query.
export async function externallyBlockedRoomIds(hotelId, checkIn, checkOut) {
  const ids = await ExternalRoomBlock.distinct('roomObjectId', { hotelId, ...overlapQuery(checkIn, checkOut) });
  return new Set(ids.map(String));
}

// Today's calendar day in the hotel's own timezone, as a UTC-midnight Date — the same footing
// the imported stays are stored on, so "arriving today" / "in-house" comparisons are exact.
// Using the server's own date instead would shift the answer for an hour or more around
// midnight for a hotel whose timezone differs from the server's.
export function hotelToday(hotel, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveHotelTimeZone(hotel),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [year, month, day] = parts.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

// Where a stay is relative to today. Imported stays carry dates only — no check-in event and no
// times — so "in-house" means the stay's nights cover today and it began before today.
export function stayStatus(stay, today) {
  if (stay.startDate > today) return 'upcoming';
  if (stay.startDate.getTime() === today.getTime()) return 'arriving';
  if (stay.endDate.getTime() === today.getTime()) return 'departing';
  return 'in-house';
}

// Stays that are current or upcoming (including ones departing today), with the room number
// resolved from the hotel's rooms. Stays for a room that no longer exists are dropped.
export async function getExternalStays(hotel, { limit = 300 } = {}) {
  const today = hotelToday(hotel);
  const blocks = await ExternalRoomBlock.find({ hotelId: hotel._id, endDate: { $gte: today } })
    .sort({ startDate: 1 })
    .limit(limit)
    .lean();

  const roomNumberById = new Map(hotel.rooms.map(room => [String(room._id), room.roomNumber]));
  const stays = blocks
    .filter(block => roomNumberById.has(String(block.roomObjectId)))
    .map(block => ({
      roomObjectId: String(block.roomObjectId),
      roomNumber: roomNumberById.get(String(block.roomObjectId)),
      source: block.source,
      startDate: block.startDate,
      endDate: block.endDate,
      nights: Math.round((block.endDate - block.startDate) / 86400000),
      status: stayStatus(block, today),
      conflictBookingReference: block.conflictBookingReference,
    }));

  return { today, stays };
}

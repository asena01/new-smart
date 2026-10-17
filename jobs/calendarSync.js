import Hotel from '../models/Hotel.js';
import RoomCalendar from '../models/RoomCalendar.js';
import { syncRoomCalendar } from '../services/calendarSyncService.js';

const SYNC_INTERVAL_MS = Number(process.env.CALENDAR_SYNC_INTERVAL_MS) || 30 * 60 * 1000;

// Imported stays are only as fresh as the last pull, so this is what keeps a booking made on
// another platform from sitting unseen for hours. Rooms are synced one at a time on purpose —
// each sync is an outbound request to a third party, and there's no deadline to beat here.
async function syncAllCalendars() {
  const calendars = await RoomCalendar.find({ 'feeds.0': { $exists: true } });

  for (const calendar of calendars) {
    try {
      const hotel = await Hotel.findById(calendar.hotelId).select('rooms');
      const room = hotel?.rooms.id(calendar.roomObjectId);
      // The room was deleted — nothing left to keep blocked, and its feeds are dead weight.
      if (!room) continue;
      await syncRoomCalendar(calendar, room.roomNumber);
    } catch (error) {
      console.error('Calendar sync error:', error.message);
    }
  }
}

let timer = null;

export function startCalendarSync() {
  if (timer) return;
  setTimeout(() => {
    syncAllCalendars().catch(error => console.error('Calendar sync error:', error.message));
  }, 30000);
  timer = setInterval(() => {
    syncAllCalendars().catch(error => console.error('Calendar sync error:', error.message));
  }, SYNC_INTERVAL_MS);
}

export function stopCalendarSync() {
  if (timer) clearInterval(timer);
  timer = null;
}

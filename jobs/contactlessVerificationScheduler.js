import Booking from '../models/Booking.js';
import { getEligibleRoomLock, sendContactlessVerificationLink } from '../controllers/bookingController.js';

// Catches bookings as they cross the "24 hours before arrival" mark and haven't had a
// verification link sent yet. Bookings made within 24h of check-in are sent immediately
// at booking time instead (see createBooking) — this poll is a safety net for those too,
// in case that immediate send failed.
const POLL_INTERVAL_MS = Number(process.env.VERIFICATION_SCHEDULER_INTERVAL_MS) || 15 * 60 * 1000;

async function sendDueVerifications() {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const dueBookings = await Booking.find({
    status: { $ne: 'cancelled' },
    checkInDate: { $lte: in24h },
    checkOutDate: { $gt: now },
    'contactlessCheckIn.diditSessionId': { $exists: false }
  }).populate('hotelId').populate('userId', 'email');

  for (const booking of dueBookings) {
    if (!getEligibleRoomLock(booking.hotelId, booking.roomId)) continue;

    try {
      await sendContactlessVerificationLink(booking);
      console.log(`✅ Auto-sent contactless verification link for booking ${booking._id}`);
    } catch (error) {
      console.error(`Error auto-sending verification for booking ${booking._id}:`, error.message);
    }
  }
}

let timer = null;

export function startContactlessVerificationScheduler() {
  if (timer) return;
  setTimeout(() => {
    sendDueVerifications().catch(error => console.error('Verification scheduler error:', error.message));
  }, 15000);
  timer = setInterval(() => {
    sendDueVerifications().catch(error => console.error('Verification scheduler error:', error.message));
  }, POLL_INTERVAL_MS);
}

export function stopContactlessVerificationScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

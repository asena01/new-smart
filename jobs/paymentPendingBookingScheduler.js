import Booking from '../models/Booking.js';
import RoomBookingHold from '../models/RoomBookingHold.js';
import { createNotification } from '../utils/notificationUtils.js';
import { sendToHotel } from '../utils/sseHub.js';

// Unpaid reservations are temporary holds. Waiting until 48 hours before arrival to release
// an unpaid one (the old behavior) meant a booking made days or weeks out — payment abandoned
// at checkout, card declined, guest never came back to pay — sat holding that room's inventory
// for the entire gap, unavailable to any other guest, even though it was functionally
// abandoned within minutes of being created. A short, fixed grace period after the booking
// itself (not tied to how far away arrival is) matches how a "reserve now, pay now" hold is
// actually meant to work: release it quickly if payment never completes, regardless of when
// the stay is. This does not touch housekeeping: the guest never occupied the room, so it
// remains ready. Five-minute detection latency is well within the 1-hour grace period and
// avoids unnecessary database work. The SSE event still updates open host screens immediately.
const POLL_INTERVAL_MS = Number(process.env.PAYMENT_PENDING_RELEASE_INTERVAL_MS) || 5 * 60 * 1000;
const PAYMENT_GRACE_MS = Number(process.env.PAYMENT_PENDING_GRACE_MS) || 60 * 60 * 1000;

export async function processPaymentPendingBookings(now = new Date()) {
  const candidates = await Booking.find({
    status: { $nin: ['cancelled', 'completed'] },
    paymentStatus: { $in: ['pending', 'failed'] },
    'checkInInfo.actualCheckInTime': { $exists: false }
  }).populate('hotelId').populate('userId', 'email firstName lastName');

  for (const booking of candidates) {
    const hotel = booking.hotelId;
    if (!hotel) continue;
    const paymentDeadline = new Date(booking.createdAt.getTime() + PAYMENT_GRACE_MS);
    if (now < paymentDeadline) continue;

    // Re-check immediately before mutating so a payment/check-in that completed
    // during the query cannot be released by this pass.
    const current = await Booking.findOne({
      _id: booking._id,
      status: { $nin: ['cancelled', 'completed'] },
      paymentStatus: { $in: ['pending', 'failed'] },
      'checkInInfo.actualCheckInTime': { $exists: false }
    });
    if (!current) continue;

    current.status = 'cancelled';
    current.cancellationReason = 'Payment was not completed within 1 hour of booking.';
    current.cancellationDate = now;
    await current.save();
    await RoomBookingHold.deleteMany({ bookingId: current._id });

    sendToHotel(hotel._id, 'booking-updated', {
        bookingId: current._id,
        status: 'cancelled',
        reason: current.cancellationReason,
        releasedForNonPayment: true
    });
    await createNotification({
        userId: hotel.hostId,
        type: 'booking',
        title: 'Unpaid Booking Released',
        message: `Room ${current.roomId} (${current.bookingReference}) was released because payment was not completed within 1 hour of booking.`,
        link: '/host/bookings',
        actionLabel: 'View Bookings'
    });
    if (current.userId) {
      await createNotification({
          userId: current.userId,
          type: 'booking',
          title: 'Booking Cancelled — Payment Pending',
          message: `Your booking at ${hotel.name} was cancelled because payment was not completed within 1 hour of booking.`,
          link: '/bookings',
          actionLabel: 'View Bookings'
      });
    }
    console.log(`✅ Released unpaid booking ${current.bookingReference} after its 1-hour payment grace period`);
  }
}

let timer = null;

export function startPaymentPendingBookingScheduler() {
  if (timer) return;
  setTimeout(() => processPaymentPendingBookings().catch(error => console.error('Payment-pending scheduler error:', error.message)), 15000);
  timer = setInterval(() => processPaymentPendingBookings().catch(error => console.error('Payment-pending scheduler error:', error.message)), POLL_INTERVAL_MS);
}

export function stopPaymentPendingBookingScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

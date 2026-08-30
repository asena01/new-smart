import Booking from '../models/Booking.js';
import RoomBookingHold from '../models/RoomBookingHold.js';
import { createNotification } from '../utils/notificationUtils.js';
import { sendToHotel } from '../utils/sseHub.js';
import { combineDateAndTime, resolveHotelTimeZone } from '../utils/hotelTime.js';

// Unpaid reservations are temporary holds. Once the 48-hour-before-arrival payment
// deadline has passed without
// payment or check-in, release the booking and its room-night holds. This does
// not touch housekeeping: the guest never occupied the room, so it remains ready.
// Five-minute detection latency is sufficient for this deadline and avoids
// unnecessary database work. The SSE event still updates open host screens immediately.
const POLL_INTERVAL_MS = Number(process.env.PAYMENT_PENDING_RELEASE_INTERVAL_MS) || 5 * 60 * 1000;
const PAYMENT_DEADLINE_LEAD_MS = 48 * 60 * 60 * 1000;

export async function processPaymentPendingBookings(now = new Date()) {
  const candidates = await Booking.find({
    status: { $nin: ['cancelled', 'completed'] },
    paymentStatus: { $in: ['pending', 'failed'] },
    'checkInInfo.actualCheckInTime': { $exists: false }
  }).populate('hotelId').populate('userId', 'email firstName lastName');

  for (const booking of candidates) {
    const hotel = booking.hotelId;
    if (!hotel) continue;
    const checkInAt = booking.checkInInfo?.approvedEarlyCheckInTime
      ? new Date(booking.checkInInfo.approvedEarlyCheckInTime)
      : combineDateAndTime(booking.checkInDate, hotel.policies?.checkInTime || '15:00', resolveHotelTimeZone(hotel));
    const paymentDeadline = new Date(checkInAt.getTime() - PAYMENT_DEADLINE_LEAD_MS);
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
    current.cancellationReason = 'Payment was not completed by the 48-hour-before-arrival deadline.';
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
        message: `Room ${current.roomId} (${current.bookingReference}) was released because payment was not completed 48 hours before arrival.`,
        link: '/host/bookings',
        actionLabel: 'View Bookings'
    });
    if (current.userId) {
      await createNotification({
          userId: current.userId,
          type: 'booking',
          title: 'Booking Cancelled — Payment Pending',
          message: `Your booking at ${hotel.name} was cancelled because payment was not completed 48 hours before arrival.`,
          link: '/bookings',
          actionLabel: 'View Bookings'
      });
    }
    console.log(`✅ Released unpaid booking ${current.bookingReference} at the 48-hour-before-arrival deadline`);
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

import Booking from '../models/Booking.js';
import Hotel from '../models/Hotel.js';
import ttlockService from '../services/ttlockService.js';
import { combineDateAndTime, resolveHotelTimeZone } from '../utils/hotelTime.js';
import { createNotification } from '../utils/notificationUtils.js';
import { createCleaningTask } from '../utils/cleaningTaskUtils.js';
import { sendToHotel } from '../utils/sseHub.js';

// Catches stays that never explicitly checked out: once the effective checkout deadline
// (an approved late-checkout time if they paid for one, otherwise the hotel's standard
// checkOutTime policy combined with their checkOutDate) plus a grace period has passed, this
// auto-completes the stay and revokes their TTLock key. Paid reservations that never checked
// in follow the same lifecycle; unpaid reservations are handled by the payment-pending job.
// Grace controls how late checkout is allowed to run; polling is only detection latency.
// Keep polling frequent so a 15-minute grace does not silently become almost 30 minutes.
const POLL_INTERVAL_MS = Number(process.env.AUTO_CHECKOUT_SCHEDULER_INTERVAL_MS) || 60 * 1000;

function effectiveDeadline(booking, hotel) {
  // A paid reservation that never checked in is treated as a no-show after its
  // scheduled arrival/check-in time. This prevents an expired arrival from
  // continuing to appear on the host's arrivals list until the next day.
  if (!booking.checkInInfo?.actualCheckInTime) {
    if (booking.checkInInfo?.approvedEarlyCheckInTime) {
      return new Date(booking.checkInInfo.approvedEarlyCheckInTime);
    }
    return combineDateAndTime(
      booking.checkInDate,
      hotel?.policies?.checkInTime || '14:00',
      resolveHotelTimeZone(hotel)
    );
  }
  if (booking.checkOutInfo?.approvedLateCheckOutTime) {
    return new Date(booking.checkOutInfo.approvedLateCheckOutTime);
  }
  return combineDateAndTime(
    booking.checkOutDate,
    hotel?.policies?.checkOutTime || '11:00',
    resolveHotelTimeZone(hotel)
  );
}

export async function processOverdueCheckouts() {
  const now = new Date();

  const candidates = await Booking.find({
    status: { $nin: ['cancelled', 'completed'] },
    'checkOutInfo.actualCheckOutTime': { $exists: false },
    $or: [
      { 'checkInInfo.actualCheckInTime': { $exists: true, $ne: null } },
      { paymentStatus: 'completed' }
    ]
  }).populate('hotelId').populate('userId', 'email firstName lastName');

  for (const booking of candidates) {
    const hotel = booking.hotelId;
    if (!hotel) continue;
    if (hotel.policies?.autoCheckoutEnabled === false) continue;

    const graceMinutes = hotel.policies?.autoCheckoutGraceMinutes ?? 15;
    const deadline = effectiveDeadline(booking, hotel);
    const cutoff = new Date(deadline.getTime() + graceMinutes * 60 * 1000);
    if (now < cutoff) continue;

    try {
      await autoCheckout(booking, hotel);
      console.log(`✅ Auto-checked-out booking ${booking._id} (deadline ${deadline.toISOString()}, grace ${graceMinutes}m)`);
    } catch (error) {
      console.error(`Error auto-checking-out booking ${booking._id}:`, error.message);
    }
  }
}

async function autoCheckout(booking, hotel) {
  const room = hotel.rooms.find(r => r.roomNumber === booking.roomId);

  if (booking.contactlessCheckIn?.enabled && room?.smartLockIntegration?.deviceId) {
    const deviceId = room.smartLockIntegration.deviceId;
    if (booking.contactlessCheckIn.keyboardPwdId) {
      try {
        await ttlockService.deleteKeyboardPwd(deviceId, booking.contactlessCheckIn.keyboardPwdId);
      } catch (revokeError) {
        console.error('Error revoking TTLock passcode on auto-checkout (non-fatal):', revokeError.message);
      }
    }
    if (booking.contactlessCheckIn.ekeyId) {
      try {
        await ttlockService.revokeEkey(deviceId, booking.contactlessCheckIn.ekeyId);
      } catch (revokeError) {
        console.error('Error revoking TTLock eKey on auto-checkout (non-fatal):', revokeError.message);
      }
    }
    booking.contactlessCheckIn.enabled = false;
  }

  // Occupancy is derived from the booking's own checkOutInfo (see attachRoomOccupancy in
  // hotelController.js), not stored on the room — writing status='available' here used to
  // silently clear a host-set Out of Order/Out of Service flag just because a guest checked
  // out, which is wrong; `status` is purely sellability intent and checkout doesn't change it.
  if (room) {
    room.housekeepingStatus = 'dirty';
    await hotel.save();
    await createCleaningTask(hotel, room);
  }

  booking.status = 'completed';
  booking.checkOutInfo.actualCheckOutTime = new Date();
  booking.checkOutInfo.autoCheckedOut = true;
  await booking.save();

  // Tell every open host/staff session immediately. Front Desk then reloads the authoritative
  // booking list and removes this departure without waiting for a page refresh.
  sendToHotel(hotel._id, 'booking-updated', {
    bookingId: booking._id,
    status: booking.status,
    actualCheckOutTime: booking.checkOutInfo.actualCheckOutTime,
    autoCheckedOut: true
  });

  await createNotification({
    userId: booking.userId?._id || booking.userId,
    type: 'booking',
    title: 'Checked Out',
    message: `You've been automatically checked out of ${hotel.name} — your room key is no longer active.`,
    link: '/bookings',
    actionLabel: 'View Booking'
  });

  await createNotification({
    userId: hotel.hostId,
    type: 'booking',
    title: 'Guest Auto-Checked-Out',
    message: `Room ${booking.roomId} (${booking.bookingReference}) was automatically checked out past its checkout deadline.`,
    link: '/host/bookings',
    actionLabel: 'View Booking'
  });
}

let timer = null;

export function startAutoCheckoutScheduler() {
  if (timer) return;
  setTimeout(() => {
    processOverdueCheckouts().catch(error => console.error('Auto-checkout scheduler error:', error.message));
  }, 15000);
  timer = setInterval(() => {
    processOverdueCheckouts().catch(error => console.error('Auto-checkout scheduler error:', error.message));
  }, POLL_INTERVAL_MS);
}

export function stopAutoCheckoutScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

import crypto from 'crypto';
import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Hotel from '../models/Hotel.js';
import User from '../models/User.js';
import Staff from '../models/Staff.js';
import ServiceOrder from '../models/ServiceOrder.js';
import RoomBookingHold from '../models/RoomBookingHold.js';
import ttlockService from '../services/ttlockService.js';
import diditService from '../services/diditService.js';
import { sendBookingConfirmationEmail, sendCheckInLinkEmail, sendGuestCredentialsEmail } from '../utils/emailUtils.js';
import { createNotification } from '../utils/notificationUtils.js';
import { combineDateAndTime, resolveHotelTimeZone } from '../utils/hotelTime.js';

export { combineDateAndTime } from '../utils/hotelTime.js';
import { getAvailableRooms } from './hotelController.js';
import { canManageHotel } from '../utils/staffAuth.js';
import { createCleaningTask } from '../utils/cleaningTaskUtils.js';
import { runInTransaction, isDuplicateKeyError } from '../utils/transactionUtils.js';
import { sendToHotel } from '../utils/sseHub.js';

// A room's discountPrice, when set and lower than basePrice, is what guests actually pay
function getEffectivePrice(room) {
  if (room.discountPrice != null && room.discountPrice > 0 && room.discountPrice < room.basePrice) {
    return room.discountPrice;
  }
  return room.basePrice;
}

// Only TTLock-equipped rooms get contactless check-in — returns the room + its smart lock
// config when eligible, or null otherwise. `hotel` must be a populated Hotel document.
export function getEligibleRoomLock(hotel, roomId) {
  const room = hotel?.rooms?.find(item => item.roomNumber === roomId);
  const smartLock = room?.smartLockIntegration;

  if (
    !room ||
    !['ttlock', 'both'].includes(room.checkInType) ||
    smartLock?.provider !== 'ttlock' ||
    !smartLock?.isActive ||
    !smartLock?.deviceId
  ) {
    return null;
  }

  return { room, smartLock };
}

// booking.userId is a User ref (populated where needed) for guest-portal bookings; guestEmail
// covers host-reception walk-ins with no account.
export function resolveGuestEmail(booking) {
  return booking.userId?.email || booking.guestEmail;
}

// The actual person staying isn't always the account the booking is under (someone can book
// on another guest's behalf — a family member, a corporate travel desk, etc.) — so the name
// explicitly recorded on the booking always wins over the linked account's own name. Falling
// back to the account name only covers bookings made before guestName was captured on every
// booking (see createBooking/createWalkInBooking).
function resolveGuestName(booking) {
  if (booking.guestName) {
    return booking.guestName;
  }
  if (booking.userId?.firstName) {
    return `${booking.userId.firstName} ${booking.userId.lastName || ''}`.trim();
  }
  return 'Guest';
}

// TTLock auto-provisions an app account for an eKey recipient who isn't already registered
// (createUser: 1), and always sets that account's password to the last 6 characters of the
// username we send — this is TTLock's own convention, not something we choose or store.
function deriveTtlockAppPassword(email) {
  return email.slice(-6);
}

// Self-service check-in (identity verification + digital lock code) is only allowed once
// the guest is genuinely close to arriving — this is the single source of truth for that
// window, used both to compute the `canCheckInNow` flag the frontend reads (so the UI and
// the server can never disagree) and to gate startVerification/getVerificationStatus
// server-side (a guest hitting those endpoints directly, e.g. via /guest/checkin/:bookingId,
// must be held to the exact same rule as the one driving the button in guest-bookings.ts).
// The window is anchored to the hotel's own configured check-in/check-out times (via
// combineDateAndTime) rather than raw midnight, so it lines up with when the room is
// actually ready/expected to be vacated instead of an arbitrary calendar-date boundary.
export const CHECKIN_WINDOW_HOURS = 48;

export function isWithinCheckInWindow(booking, now = new Date()) {
  if (booking.status === 'cancelled') return false;
  if (booking.checkInInfo?.actualCheckInTime) return false;
  if (booking.checkOutInfo?.actualCheckOutTime || booking.status === 'completed') return false;

  const policies = booking.hotelId?.policies || {};
  const timeZone = resolveHotelTimeZone(booking.hotelId);
  const normalCheckInAt = combineDateAndTime(booking.checkInDate, policies.checkInTime || '15:00', timeZone);

  // A host-approved early check-in overrides the default 48h-before rule with whatever
  // earlier moment was actually approved (and paid for) — the generic window is only the
  // fallback for guests who didn't request one.
  const windowStart = booking.checkInInfo?.approvedEarlyCheckInTime
    ? new Date(booking.checkInInfo.approvedEarlyCheckInTime)
    : new Date(normalCheckInAt.getTime() - CHECKIN_WINDOW_HOURS * 60 * 60 * 1000);

  // Same idea for an approved late check-out extending how long the window stays open.
  const windowEnd = booking.checkOutInfo?.approvedLateCheckOutTime
    ? new Date(booking.checkOutInfo.approvedLateCheckOutTime)
    : combineDateAndTime(booking.checkOutDate, policies.checkOutTime || '11:00', timeZone);

  return now >= windowStart && now < windowEnd;
}

// Generates and saves the TTLock temporary door code for a booking, and — best-effort — sends
// the guest a TTLock eKey so they can also unlock via the TTLock app over Bluetooth (no gateway
// required, same as the passcode). The passcode is the reliable, app-free path, so an eKey
// failure is logged but never blocks check-in. Shared by the standalone setupContactlessCheckIn
// endpoint and the post-verification path in getVerificationStatus.
//
// The key's validity window defaults to the hotel's standard checkIn/checkOutTime policy
// combined with the booking's dates (not just the bare dates) — pass `overrides` to give a
// guest's approved early-checkin/late-checkout request a different start/end instead.
export async function generateContactlessCode(booking, smartLock, guestEmail, overrides = {}) {
  const hotel = await Hotel.findById(booking.hotelId?._id || booking.hotelId).select('policies location.country');
  const policies = hotel?.policies || {};
  const timeZone = resolveHotelTimeZone(hotel);

  const startDate = overrides.startDate || combineDateAndTime(booking.checkInDate, policies.checkInTime || '15:00', timeZone);
  const endDate = overrides.endDate || combineDateAndTime(booking.checkOutDate, policies.checkOutTime || '11:00', timeZone);

  const accessCode = await ttlockService.generateAccessCode(
    smartLock.deviceId,
    startDate,
    endDate,
    `Guest ${booking.bookingReference}`
  );

  booking.contactlessCheckIn.enabled = true;
  booking.contactlessCheckIn.smartLockCode = accessCode.keyboardPwd;
  booking.contactlessCheckIn.keyboardPwdId = accessCode.keyboardPwdId;
  booking.contactlessCheckIn.expiryTime = endDate;

  if (guestEmail) {
    try {
      const ekeyResult = await ttlockService.sendEkey(
        smartLock.deviceId,
        guestEmail,
        `Guest ${booking.bookingReference}`,
        startDate,
        endDate
      );
      booking.contactlessCheckIn.ekeySent = true;
      booking.contactlessCheckIn.ekeyId = ekeyResult.keyId;
    } catch (ekeyError) {
      console.error('eKey send failed (non-fatal, passcode still valid):', ekeyError.message);
      booking.contactlessCheckIn.ekeySent = false;
      booking.contactlessCheckIn.ekeyError = ekeyError.response?.data?.errmsg || ekeyError.message;
    }
  }

  return accessCode.keyboardPwd;
}

// Expands a [checkIn, checkOut) date range into one UTC-midnight Date per calendar night —
// the granularity RoomBookingHold enforces uniqueness on. Normalizing to UTC Y/M/D (rather
// than trusting checkIn/checkOut's own time-of-day) keeps two bookings' night-sets comparable
// regardless of what time component a date happened to carry, and preserves the invariant the
// whole conflict-safety strategy relies on: two half-open whole-night ranges overlap if and
// only if their night-sets share at least one night in common.
export function nightsBetween(checkIn, checkOut) {
  const nights = [];
  const cursor = new Date(Date.UTC(checkIn.getUTCFullYear(), checkIn.getUTCMonth(), checkIn.getUTCDate()));
  const end = new Date(Date.UTC(checkOut.getUTCFullYear(), checkOut.getUTCMonth(), checkOut.getUTCDate()));
  while (cursor < end) {
    nights.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return nights;
}

// The actual concurrency-safety mechanism: inserting one hold per night relies on
// RoomBookingHold's unique (hotelId, roomId, night) index to make a genuine conflict
// impossible to miss, even when two requests' own findOne-based pre-checks both raced past
// each other and saw no conflict. Must run inside the same transaction as the Booking.create
// that follows it — see createBooking/createWalkInBooking.
async function reserveRoomNights(session, hotelId, roomId, checkIn, checkOut, bookingId) {
  const holds = nightsBetween(checkIn, checkOut).map(night => ({ hotelId, roomId, night, bookingId }));
  await RoomBookingHold.insertMany(holds, { session, ordered: true });
}

// Frees a cancelled booking's nights so a future booking can reserve them. Best-effort is
// NOT acceptable here (unlike most side effects in this file) — a hold left behind after its
// booking is cancelled would permanently block that room/night for no reason, so this is
// always awaited inside the same transaction as the status change in cancelBooking.
async function releaseRoomNights(session, bookingId) {
  await RoomBookingHold.deleteMany({ bookingId }, { session });
}

const ROOM_READY_STATUSES = ['clean', 'inspected'];

// The one place that decides whether it's actually safe to hand a guest a working key.
// A booking with an approved-but-not-yet-active early check-in needs BOTH the room to be
// ready AND the guest's identity to be verified before its earlier window takes effect —
// issuing early access to someone who hasn't been identity-verified yet would skip the same
// check every other check-in path enforces. Called from three places whenever one of those
// preconditions newly clears: the early-checkin order being confirmed, the room being marked
// ready, and identity verification completing. Returns true once a key is actually issued.
export async function tryIssueContactlessKey(booking, hotel, guestEmail) {
  const eligible = getEligibleRoomLock(hotel, booking.roomId);
  if (!eligible) return false;

  if (booking.checkInInfo?.approvedEarlyCheckInTime) {
    const room = hotel.rooms?.find(r => r.roomNumber === booking.roomId);
    const roomReady = room && ROOM_READY_STATUSES.includes(room.housekeepingStatus);
    const verified = !!booking.checkInInfo?.guestVerified;

    if (!roomReady || !verified) {
      booking.checkInInfo.pendingRoomReady = true;
      return false;
    }

    await generateContactlessCode(booking, eligible.smartLock, guestEmail, {
      startDate: booking.checkInInfo.approvedEarlyCheckInTime,
      endDate: booking.checkOutInfo?.approvedLateCheckOutTime || undefined
    });
    booking.checkInInfo.pendingRoomReady = false;
    return true;
  }

  await generateContactlessCode(booking, eligible.smartLock, guestEmail, {
    endDate: booking.checkOutInfo?.approvedLateCheckOutTime || undefined
  });
  return true;
}

export const createBooking = async (req, res) => {
  try {
    const { hotelId, roomId, checkInDate, checkOutDate, numberOfGuests, specialRequests, guestName } = req.body;

    const hotel = await Hotel.findById(hotelId);
    if (!hotel) {
      return res.status(404).json({ message: 'Hotel not found' });
    }

    const room = hotel.rooms.find(r => r.roomNumber === roomId);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const checkIn = new Date(checkInDate);
    const checkOut = new Date(checkOutDate);
    if (checkOut <= checkIn) {
      return res.status(400).json({ message: 'Check-out date must be after check-in date' });
    }

    // Cheap fast-path check outside the transaction — catches a conflict against any booking
    // that predates the RoomBookingHold rollout (and so has no holds of its own) and gives a
    // quick rejection for the common non-racing case. It is NOT the concurrency guarantee:
    // two requests can both pass this findOne at the same time. That guarantee comes from the
    // atomic reserveRoomNights + Booking.create below, inside a single transaction.
    const conflict = await Booking.findOne({
      hotelId,
      roomId,
      status: { $ne: 'cancelled' },
      checkInDate: { $lt: checkOut },
      checkOutDate: { $gt: checkIn }
    });
    if (conflict) {
      return res.status(409).json({ message: `Room ${roomId} is already booked for those dates` });
    }

    const nights = Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24));
    const totalPrice = getEffectivePrice(room) * nights;

    // req.user comes from the JWT, which only carries { userId, role } — not email — so
    // the guest's email has to be looked up from the User document, not the token.
    const guestUser = await User.findById(req.user.userId);
    // The account holder isn't necessarily who's staying (booking on someone else's behalf,
    // e.g. a family member) — an explicit guestName from the client always wins; otherwise
    // default to the account's own name so older/simple bookings still show something sane.
    const resolvedGuestName = (guestName || '').trim() || `${guestUser?.firstName || ''} ${guestUser?.lastName || ''}`.trim() || 'Guest';

    const bookingId = new mongoose.Types.ObjectId();
    let booking;
    try {
      booking = await runInTransaction(async session => {
        await reserveRoomNights(session, hotelId, roomId, checkIn, checkOut, bookingId);

        const [created] = await Booking.create([{
          _id: bookingId,
          userId: req.user.userId,
          guestName: resolvedGuestName,
          hotelId,
          roomId,
          checkInDate: checkIn,
          checkOutDate: checkOut,
          numberOfGuests,
          specialRequests,
          totalPrice,
          currency: room.currency || 'NGN',
        }], { session });
        return created;
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return res.status(409).json({ message: `Room ${roomId} is already booked for those dates` });
      }
      throw error;
    }

    await sendBookingConfirmationEmail(guestUser?.email, {
      guestName: resolvedGuestName,
      bookingReference: booking.bookingReference,
      hotelName: hotel.name,
      checkInDate: checkInDate,
      checkOutDate: checkOutDate,
      totalPrice: booking.totalPrice,
      currency: booking.currency,
    });

    await createNotification({
      userId: req.user.userId,
      type: 'booking',
      title: 'Booking Confirmed',
      message: `Your stay at ${hotel.name} is booked for ${checkInDate} to ${checkOutDate}.`,
      link: '/bookings',
      actionLabel: 'View Booking'
    });

    await createNotification({
      userId: hotel.hostId,
      type: 'booking',
      title: 'New Booking',
      message: `${guestUser?.firstName || 'A guest'} booked Room ${roomId} for ${checkInDate} to ${checkOutDate}.`,
      link: '/host/bookings',
      actionLabel: 'View Booking'
    });

    // Contactless verification is normally sent 24h before arrival (see
    // jobs/contactlessVerificationScheduler.js). If the guest booked less than 24h out,
    // send it immediately instead of waiting for a threshold that's already passed.
    if (getEligibleRoomLock(hotel, roomId)) {
      const hoursUntilCheckIn = (checkIn.getTime() - Date.now()) / (1000 * 60 * 60);
      if (hoursUntilCheckIn <= 24) {
        try {
          const populatedBooking = await Booking.findById(booking._id).populate('hotelId').populate('userId', 'email');
          await sendContactlessVerificationLink(populatedBooking);
        } catch (verificationError) {
          console.error('Error auto-sending contactless verification link:', verificationError.message);
        }
      }
    }

    res.status(201).json({ success: true, booking, hotelPaymentSubaccountId: hotel.flutterwaveSubaccountId });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Host (or staff with canManageReservations, e.g. a receptionist) creates a walk-in /
// reception booking on behalf of a guest
export const createWalkInBooking = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const {
      guestId,
      guestName,
      guestEmail,
      guestPhone,
      roomId,
      checkInDate,
      checkOutDate,
      numberOfGuests,
      specialRequests
    } = req.body;

    let hotel;
    if (req.user.role === 'staff') {
      const staff = await Staff.findOne({ userId: req.user.userId, status: 'active' });
      if (!staff || !(await canManageHotel(req, staff.hotelId, 'canManageReservations')) || String(staff.hotelId) !== String(hotelId)) {
        return res.status(403).json({ message: 'Not authorized to create bookings at this hotel' });
      }
      hotel = await Hotel.findById(hotelId);
    } else {
      hotel = await Hotel.findOne({ _id: hotelId, hostId: req.user.userId });
    }
    if (!hotel) {
      return res.status(404).json({ message: 'Hotel not found' });
    }

    if (!guestId && !guestName) {
      return res.status(400).json({ message: 'Guest name is required for walk-in bookings' });
    }
    if (!guestId && !guestEmail) {
      return res.status(400).json({ message: 'Guest email is required for walk-in bookings' });
    }

    const room = hotel.rooms.find(r => r.roomNumber === roomId);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const checkIn = new Date(checkInDate);
    const checkOut = new Date(checkOutDate);
    if (checkOut <= checkIn) {
      return res.status(400).json({ message: 'Check-out date must be after check-in date' });
    }

    // Cheap fast-path check outside the transaction — see the identical comment in
    // createBooking. The concurrency guarantee itself comes from reserveRoomNights +
    // Booking.create running atomically below, not from this pre-check.
    const conflict = await Booking.findOne({
      hotelId,
      roomId,
      status: { $ne: 'cancelled' },
      checkInDate: { $lt: checkOut },
      checkOutDate: { $gt: checkIn }
    });
    if (conflict) {
      return res.status(409).json({ message: `Room ${roomId} is already booked for those dates` });
    }

    // Front-desk bookings still need a real guest account — not just a guestName/guestEmail
    // string on the booking — so contactless features (a TTLock key below) have an account
    // to attach to. Reuse an existing account by email if one already exists; otherwise
    // create one with a generated password and email it to the guest.
    let resolvedUserId = guestId || undefined;
    let resolvedGuestEmail = null;
    let resolvedGuestFirstName = null;
    let newAccountPassword = null;
    let newAccountFirstName = null;

    if (resolvedUserId) {
      const existingUser = await User.findById(resolvedUserId);
      resolvedGuestEmail = existingUser?.email || null;
      resolvedGuestFirstName = existingUser?.firstName || null;
    } else {
      let guestUser = await User.findOne({ email: guestEmail });
      if (!guestUser) {
        const [firstName, ...rest] = guestName.trim().split(' ');
        const lastName = rest.join(' ') || firstName;
        newAccountPassword = crypto.randomBytes(6).toString('hex');
        newAccountFirstName = firstName;

        guestUser = await User.create({
          firstName,
          lastName,
          email: guestEmail,
          password: newAccountPassword,
          phone: guestPhone,
          role: 'guest'
        });
      }
      resolvedUserId = guestUser._id;
      resolvedGuestEmail = guestUser.email;
    }

    const nights = Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24));
    const totalPrice = getEffectivePrice(room) * nights;

    // Whoever's actually staying, as typed at the desk — takes priority over the linked
    // account's own name, since a front-desk booking is very often made using (or matched
    // to) an account that belongs to someone else entirely (e.g. a returning guest's account
    // reused for a companion, or a corporate account booking for an employee).
    const resolvedGuestDisplayName = (guestName || '').trim() || resolvedGuestFirstName || newAccountFirstName || 'Guest';

    const bookingId = new mongoose.Types.ObjectId();
    let booking;
    try {
      booking = await runInTransaction(async session => {
        await reserveRoomNights(session, hotelId, roomId, checkIn, checkOut, bookingId);

        const [created] = await Booking.create([{
          _id: bookingId,
          userId: resolvedUserId,
          guestName: resolvedGuestDisplayName,
          source: 'host-reception',
          hotelId,
          roomId,
          checkInDate: checkIn,
          checkOutDate: checkOut,
          numberOfGuests,
          specialRequests,
          totalPrice,
          currency: room.currency || 'NGN',
          status: 'confirmed',
          checkInInfo: {
            actualCheckInTime: new Date(),
            guestVerified: true
          }
        }], { session });
        return created;
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return res.status(409).json({ message: `Room ${roomId} is already booked for those dates` });
      }
      throw error;
    }

    // Walk-ins are verified in person by the host, not through the remote Didit flow, so
    // hand over a TTLock key right away instead of waiting on a check-in step that a
    // front-desk booking never goes through.
    const eligible = getEligibleRoomLock(hotel, roomId);
    if (eligible) {
      try {
        await generateContactlessCode(booking, eligible.smartLock, resolvedGuestEmail);
        await booking.save();
      } catch (ttlockError) {
        console.error('TTLock key assignment on walk-in booking failed (non-fatal):', ttlockError.message);
      }
    }

    if (resolvedGuestEmail) {
      try {
        await sendBookingConfirmationEmail(resolvedGuestEmail, {
          guestName: resolvedGuestDisplayName,
          bookingReference: booking.bookingReference,
          hotelName: hotel.name,
          checkInDate,
          checkOutDate,
          totalPrice: booking.totalPrice,
          currency: booking.currency,
          appDownloadUrl: process.env.MOBILE_APP_DOWNLOAD_URL
        });
      } catch (emailError) {
        console.error('Error sending walk-in booking email:', emailError.message);
      }

      if (newAccountPassword) {
        await sendGuestCredentialsEmail(resolvedGuestEmail, {
          firstName: newAccountFirstName,
          hotelName: hotel.name,
          password: newAccountPassword
        });
      }
    }

    // Without this, the response's userId is a bare ObjectId, and the host's booking
    // list (which reads userId.firstName/lastName) renders the guest's name as "undefined".
    await booking.populate('userId', 'firstName lastName email phone');

    res.status(201).json({ success: true, booking });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Host: get all bookings for their hotel
// Front Desk's Arrivals/Departing Today need the actual expected date+time, not just the
// bare calendar date — and that time isn't always the hotel's standard checkInTime/
// checkOutTime: a guest with an APPROVED early-checkin or late-checkout request has a
// different effective time, so Front Desk must reflect that override rather than the
// generic default (early check-in uses a fixed fee; late checkout is hourly — confirmed is
// their terminal "approved" status, set by finalizeEarlyCheckIn/finalizeLateCheckOut).
const TIME_24H_PATTERN = /^\d{1,2}:\d{2}$/;

// `hotel` is only needed as a fallback for callers whose bookings carry a bare hotelId
// ObjectId (e.g. getHotelBookings, already scoped to one hotel) — when a booking's own
// hotelId is already a populated Hotel doc (e.g. the guest endpoints below, where a single
// guest's bookings can span several different hotels), its own policies win instead.
async function attachArrivalDepartureTimes(bookings, hotel) {
  const bookingIds = bookings.map(b => b._id);
  const approvedOrders = await ServiceOrder.find({
    bookingId: { $in: bookingIds },
    serviceType: { $in: ['early-checkin', 'late-checkout'] },
    status: { $in: ['confirmed', 'completed'] }
  }).select('bookingId serviceType serviceDetails.requestedTime');

  const overridesByBooking = new Map();
  for (const order of approvedOrders) {
    // Orders confirmed before the per-hour pricing rework stored requestedTime as a 12-hour
    // string like "7:00 AM" (picked from a fixed catalog item) instead of today's "HH:MM" —
    // silently mis-parsing that legacy shape produced a plausible-looking but wrong time, so
    // only trust it as an override when it's actually in the format combineDateAndTime expects.
    const requestedTime = order.serviceDetails?.requestedTime;
    if (!TIME_24H_PATTERN.test(requestedTime || '')) continue;
    const key = String(order.bookingId);
    const existing = overridesByBooking.get(key) || {};
    existing[order.serviceType] = requestedTime;
    overridesByBooking.set(key, existing);
  }

  return bookings.map(bookingDoc => {
    const booking = bookingDoc.toObject ? bookingDoc.toObject() : bookingDoc;
    const overrides = overridesByBooking.get(String(booking._id)) || {};
    const policies = booking.hotelId?.policies || hotel?.policies;
    const checkInTime = overrides['early-checkin'] || policies?.checkInTime || '15:00';
    const checkOutTime = overrides['late-checkout'] || policies?.checkOutTime || '11:00';
    const timeZone = resolveHotelTimeZone(booking.hotelId?.policies ? booking.hotelId : hotel);
    booking.expectedArrival = combineDateAndTime(booking.checkInDate, checkInTime, timeZone);
    booking.expectedDeparture = combineDateAndTime(booking.checkOutDate, checkOutTime, timeZone);
    booking.hotelTimeZone = timeZone;
    return booking;
  });
}

export const getHotelBookings = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { status } = req.query;

    const hotel = await Hotel.findById(hotelId);
    if (!hotel) {
      return res.status(404).json({ message: 'Hotel not found' });
    }
    if (!(await canManageHotel(req, hotelId, 'canManageReservations'))) {
      return res.status(403).json({ message: 'Not authorized to view this hotel\'s bookings' });
    }

    const filter = { hotelId };
    if (status) filter.status = status;

    const bookings = await Booking.find(filter)
      .populate('userId', 'firstName lastName email phone')
      .sort({ createdAt: -1 });

    const bookingsWithTimes = await attachArrivalDepartureTimes(bookings, hotel);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isToday = value => {
      const date = new Date(value);
      date.setHours(0, 0, 0, 0);
      return date.getTime() === today.getTime();
    };
    const isOnOrBeforeToday = value => {
      const date = new Date(value);
      date.setHours(0, 0, 0, 0);
      return date <= today;
    };

    // Front Desk has different operational queues from a booking-management list. Return
    // those queues explicitly from the same authoritative response that already resolves
    // expectedArrival/expectedDeparture, rather than requiring each client to re-create the
    // checked-in and calendar-day rules locally.
    const operations = {
      arrivals: bookingsWithTimes.filter(booking =>
        booking.status !== 'cancelled' &&
        !booking.checkInInfo?.actualCheckInTime &&
        isOnOrBeforeToday(booking.checkInDate)
      ),
      departures: bookingsWithTimes.filter(booking =>
        !!booking.checkInInfo?.actualCheckInTime &&
        !booking.checkOutInfo?.actualCheckOutTime &&
        isToday(booking.checkOutDate)
      ),
      inHouse: bookingsWithTimes.filter(booking =>
        !!booking.checkInInfo?.actualCheckInTime &&
        !booking.checkOutInfo?.actualCheckOutTime &&
        !isToday(booking.checkOutDate)
      )
    };

    res.status(200).json({ success: true, bookings: bookingsWithTimes, operations });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Attaches a plain contactlessEligible boolean to each booking so the frontend doesn't
// need to duplicate the room/lock eligibility logic itself.
function withContactlessEligibility(bookingDoc) {
  const booking = bookingDoc.toObject();
  booking.contactlessEligible = !!getEligibleRoomLock(booking.hotelId, booking.roomId);

  // Early Check-in is a fixed-fee paid service (pay to have gotten in before the hotel's
  // standard check-in time), not just a one-time "unlock the room" gate — so it stays
  // requestable even after the guest has already checked in (e.g. via the free 48-hour
  // window), letting them formalize/pay for the early hours they used. It only stops making
  // sense once the standard check-in moment for this stay has actually passed, or the stay
  // has ended. hotelId is already a populated Hotel doc here (see getBookings/getBookingById
  // below), so no extra query.
  const isCheckedOut = !!booking.checkOutInfo?.actualCheckOutTime || booking.status === 'completed';
  const normalCheckInAt = combineDateAndTime(
    booking.checkInDate,
    booking.hotelId?.policies?.checkInTime || '15:00',
    resolveHotelTimeZone(booking.hotelId)
  );
  booking.canRequestEarlyCheckIn = !isCheckedOut && new Date() < normalCheckInAt;

  // An unpaid booking must not be checkable-in — the guest owes money on a room they haven't
  // secured yet, and letting them unlock it first removes any incentive to actually pay.
  // Surfaced as its own flag (rather than folded into canCheckInNow silently) so the frontend
  // can show "complete your payment" instead of a generic "not open yet" when this is why.
  booking.paymentPending = booking.paymentStatus !== 'completed';

  // Server-computed so the bookings list and the direct /guest/checkin/:bookingId page can't
  // drift apart — both just read this flag instead of each re-deriving the window themselves.
  booking.canCheckInNow = booking.contactlessEligible && !booking.paymentPending && isWithinCheckInWindow(booking);

  return booking;
}

export const getBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ userId: req.user.userId })
      .populate('hotelId')
      .sort({ createdAt: -1 });

    const withEligibility = bookings.map(withContactlessEligibility);
    res.status(200).json({ success: true, bookings: await attachArrivalDepartureTimes(withEligibility) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// A booking can be accessed by the guest it belongs to, an admin, the host of its hotel, or
// a staff member with the given permission at that hotel. Exported for reuse by
// receiptController, which needs the exact same "who can view this booking" rule.
//
// permissionKey defaults to 'canCheckInGuests' — the front-desk check-in/out permission,
// correct for every caller except cancelBooking, which is a reservation-management action and
// passes 'canManageReservations' instead (see cancelBooking below). Before this, every caller
// shared the same canCheckInGuests check, which meant a staff member granted only
// "manage reservations" (and not check-in/out) couldn't cancel a booking despite the label,
// while a receptionist with only check-in/out could cancel despite never being granted
// reservation-management — the permission label and the actual gate didn't match.
export const isAuthorizedForBooking = async (booking, req, permissionKey = 'canCheckInGuests') => {
  if (req.user.role === 'admin') return true;
  // booking.userId may be a plain ObjectId or a populated User sub-document
  // (e.g. startVerification/getVerificationStatus populate it for the guest's email),
  // so compare against whichever shape it currently is.
  const bookingUserId = booking.userId?._id?.toString() || booking.userId?.toString();
  if (bookingUserId && bookingUserId === req.user.userId) return true;
  if (req.user.role === 'host' && booking.hotelId?.hostId?.toString() === req.user.userId) return true;

  const hotelId = booking.hotelId?._id || booking.hotelId;
  if (req.user.role === 'staff' && (await canManageHotel(req, hotelId, permissionKey))) return true;

  return false;
};

export const getBookingById = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('hotelId');

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (!(await isAuthorizedForBooking(booking, req))) {
      return res.status(403).json({ message: 'Not authorized to view this booking' });
    }

    const [withTimes] = await attachArrivalDepartureTimes([withContactlessEligibility(booking)]);
    res.status(200).json({ success: true, booking: withTimes });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Real upgrade candidates for a booking: actual Hotel.rooms, filtered by the SAME
// availability check used by search (no overlapping non-cancelled booking for this
// booking's exact date range), excluding the guest's own current room and any room
// under maintenance. This replaces the old detached ServiceCatalogItem "menu" — an
// upgrade option is only ever offered here if the physical room is genuinely free.
export const getUpgradeOptions = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('hotelId');
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (!(await isAuthorizedForBooking(booking, req))) {
      return res.status(403).json({ message: 'Not authorized for this booking' });
    }

    const hotel = booking.hotelId;
    const available = await getAvailableRooms(hotel._id, hotel.rooms, booking.checkInDate, booking.checkOutDate);
    const currentRoom = hotel.rooms.find(r => r.roomNumber === booking.roomId);
    const currentPrice = currentRoom ? getEffectivePrice(currentRoom) : 0;

    const options = available
      // >= (not >) so a guest can move to a same-priced room laterally — only a strictly
      // cheaper room counts as a downgrade and is excluded.
      .filter(room => room.roomNumber !== booking.roomId && getEffectivePrice(room) >= currentPrice)
      .map(room => ({
        roomNumber: room.roomNumber,
        type: room.type,
        capacity: room.capacity,
        basePrice: room.basePrice,
        discountPrice: room.discountPrice,
        price: getEffectivePrice(room),
        images: room.images || []
      }));

    res.status(200).json({
      success: true,
      currentRoom: currentRoom ? {
        roomNumber: currentRoom.roomNumber,
        type: currentRoom.type,
        price: currentPrice
      } : null,
      nights: Math.max(1, Math.round((new Date(booking.checkOutDate) - new Date(booking.checkInDate)) / 86400000)),
      options
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const cancelBooking = async (req, res) => {
  try {
    const { cancellationReason } = req.body;

    const booking = await Booking.findById(req.params.id).populate('hotelId');

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (!(await isAuthorizedForBooking(booking, req, 'canManageReservations'))) {
      return res.status(403).json({ message: 'Not authorized to cancel this booking' });
    }

    if (booking.status === 'cancelled') {
      return res.status(400).json({ message: 'Booking already cancelled' });
    }

    // Once a stay is underway or finished, "cancelling" it would erase a real transaction —
    // that's not what cancellation is for. Admin keeps an override for genuine support cases.
    if (req.user.role !== 'admin') {
      if (booking.checkInInfo?.actualCheckInTime) {
        return res.status(400).json({ message: 'This guest has already checked in — the booking can no longer be cancelled.' });
      }
      if (booking.status === 'completed') {
        return res.status(400).json({ message: 'This stay is already completed and cannot be cancelled.' });
      }
    }

    booking.status = 'cancelled';
    booking.cancellationReason = cancellationReason;
    booking.cancellationDate = new Date();

    // Releasing the room-night holds has to land in the same transaction as the status
    // change — if the save succeeded but the release didn't, those nights would stay
    // permanently unbookable for a booking that's no longer active.
    await runInTransaction(async session => {
      await booking.save({ session });
      await releaseRoomNights(session, booking._id);
    });

    await createNotification({
      userId: booking.userId,
      type: 'booking',
      title: 'Booking Cancelled',
      message: `Your booking at ${booking.hotelId.name} has been cancelled.`,
      link: '/bookings',
      actionLabel: 'View Bookings'
    });

    // If the guest cancelled, the host wouldn't otherwise hear about it — a host-initiated
    // cancellation doesn't need this since the guest notification above already covers it.
    if (req.user.role !== 'host' && req.user.role !== 'admin') {
      await createNotification({
        userId: booking.hotelId.hostId,
        type: 'booking',
        title: 'Booking Cancelled',
        message: `A guest cancelled their booking for Room ${booking.roomId} (${booking.bookingReference}).`,
        link: '/host/bookings',
        actionLabel: 'View Bookings'
      });
    }

    res.status(200).json({ success: true, booking });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Host/staff editing an existing reservation's details from Bookings management — dates,
// room, guest count, contact info, special requests. There's no equivalent guest-initiated
// self-service edit flow today (a guest can only cancel), so this is host/staff/admin only.
export const updateBooking = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('hotelId');
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    const hotelId = booking.hotelId?._id || booking.hotelId;
    const isHost = req.user.role === 'host' && booking.hotelId?.hostId?.toString() === req.user.userId;
    const isStaff = req.user.role === 'staff' && (await canManageHotel(req, hotelId, 'canManageReservations'));
    if (req.user.role !== 'admin' && !isHost && !isStaff) {
      return res.status(403).json({ message: 'Not authorized to edit this booking' });
    }

    if (booking.status === 'cancelled' || booking.status === 'completed') {
      return res.status(400).json({ message: 'This booking can no longer be edited.' });
    }

    const { guestName, guestPhone, numberOfGuests, specialRequests, roomId, checkInDate, checkOutDate } = req.body;

    if (guestName !== undefined) booking.guestName = guestName;
    if (guestPhone !== undefined) booking.guestPhone = guestPhone;
    if (numberOfGuests !== undefined) booking.numberOfGuests = numberOfGuests;
    if (specialRequests !== undefined) booking.specialRequests = specialRequests;

    const changingDatesOrRoom = (roomId && roomId !== booking.roomId) || checkInDate || checkOutDate;

    if (changingDatesOrRoom) {
      // Once a guest has checked in, the room and stay dates are tied to a live key/lock
      // session — changing them here would desync from what was actually issued. Same rule
      // cancelBooking already enforces, for the same reason.
      if (booking.checkInInfo?.actualCheckInTime && req.user.role !== 'admin') {
        return res.status(400).json({ message: 'This guest has already checked in — dates and room can no longer be changed here.' });
      }

      const nextRoomId = roomId || booking.roomId;
      const nextCheckIn = checkInDate ? new Date(checkInDate) : booking.checkInDate;
      const nextCheckOut = checkOutDate ? new Date(checkOutDate) : booking.checkOutDate;
      if (nextCheckOut <= nextCheckIn) {
        return res.status(400).json({ message: 'Check-out date must be after check-in date' });
      }

      const room = booking.hotelId.rooms.find(r => r.roomNumber === nextRoomId);
      if (!room) {
        return res.status(404).json({ message: 'Room not found' });
      }

      // Cheap fast-path check outside the transaction — see the identical comment on the same
      // check in createWalkInBooking. The concurrency guarantee comes from reserveRoomNights's
      // unique index inside the transaction below, not from this pre-check.
      const conflict = await Booking.findOne({
        _id: { $ne: booking._id },
        hotelId,
        roomId: nextRoomId,
        status: { $ne: 'cancelled' },
        checkInDate: { $lt: nextCheckOut },
        checkOutDate: { $gt: nextCheckIn }
      });
      if (conflict) {
        return res.status(409).json({ message: `Room ${nextRoomId} is already booked for those dates` });
      }

      const nights = Math.ceil((nextCheckOut - nextCheckIn) / (1000 * 60 * 60 * 24));
      booking.roomId = nextRoomId;
      booking.checkInDate = nextCheckIn;
      booking.checkOutDate = nextCheckOut;
      booking.totalPrice = getEffectivePrice(room) * nights;
      booking.currency = room.currency || booking.currency;

      // Moving the room-night holds has to land in the same transaction as the booking save —
      // if the save succeeded but the hold move didn't, the old nights would stay blocked and
      // the new ones wouldn't be, letting someone else double-book the new dates.
      await runInTransaction(async session => {
        await releaseRoomNights(session, booking._id);
        await reserveRoomNights(session, hotelId, nextRoomId, nextCheckIn, nextCheckOut, booking._id);
        await booking.save({ session });
      });
    } else {
      await booking.save();
    }

    // Not populated up to this point (only hotelId was, for the auth check) — the response
    // feeds straight back into the same detail drawer that showed userId.email/phone before
    // the edit, so it needs to keep showing them rather than going blank after a save.
    await booking.populate('userId', 'firstName lastName email phone');

    res.status(200).json({ success: true, booking });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({ message: 'Those dates were just booked by someone else. Please pick different dates.' });
    }
    res.status(500).json({ message: error.message });
  }
};

const RECORDABLE_PAYMENT_STATUSES = ['pending', 'completed', 'failed', 'refunded'];

// Records a payment a host/staff took outside the online flow (cash or card at the front
// desk, a refund handled in person, etc.) — walk-in bookings in particular start out
// `paymentStatus: 'pending'` with nothing that would ever move them off it otherwise, since
// createWalkInBooking never runs guests through the online payments flow. Deliberately not
// blocked by booking.status the way updateBooking's other fields are: a payment can still
// need recording (or refunding) after checkout/cancellation.
export const updateBookingPayment = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('hotelId');
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    const hotelId = booking.hotelId?._id || booking.hotelId;
    const isHost = req.user.role === 'host' && booking.hotelId?.hostId?.toString() === req.user.userId;
    const isStaff = req.user.role === 'staff' && (await canManageHotel(req, hotelId, 'canManageReservations'));
    if (req.user.role !== 'admin' && !isHost && !isStaff) {
      return res.status(403).json({ message: 'Not authorized to update payment for this booking' });
    }

    const { paymentStatus, paymentMethod } = req.body;
    if (!RECORDABLE_PAYMENT_STATUSES.includes(paymentStatus)) {
      return res.status(400).json({ message: 'Invalid payment status' });
    }

    booking.paymentStatus = paymentStatus;
    if (paymentMethod !== undefined) booking.paymentMethod = paymentMethod;
    await booking.save();
    await booking.populate('userId', 'firstName lastName email phone');

    res.status(200).json({ success: true, booking });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const setupContactlessCheckIn = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('hotelId').populate('userId', 'email');

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    // Was the one booking endpoint with no authorization check at all — any authenticated
    // user who could guess/enumerate a booking id could generate a live TTLock passcode (and
    // trigger an eKey email) for a room that wasn't theirs, regardless of role or hotel.
    if (!(await isAuthorizedForBooking(booking, req))) {
      return res.status(403).json({ message: 'Not authorized to set up contactless check-in for this booking' });
    }

    const eligible = getEligibleRoomLock(booking.hotelId, booking.roomId);
    if (!eligible) {
      return res.status(400).json({ message: 'Digital lock is not configured for this room' });
    }

    try {
      const guestEmail = resolveGuestEmail(booking);
      const code = await generateContactlessCode(booking, eligible.smartLock, guestEmail);
      await booking.save();

      res.status(200).json({
        success: true,
        booking,
        accessCode: code,
        ekeySent: booking.contactlessCheckIn.ekeySent,
        ekeyAppLogin: booking.contactlessCheckIn.ekeySent ? { username: guestEmail, password: deriveTtlockAppPassword(guestEmail) } : null,
        message: 'Contactless check-in code generated successfully'
      });
    } catch (ttlockError) {
      res.status(500).json({ message: 'Failed to generate digital lock code', error: ttlockError.message });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Creates a fresh Didit verification session for this booking and emails the guest a link
// back into the app to continue. `booking` must have `hotelId` and `userId` populated.
// Shared by the guest-initiated endpoint below and the automatic scheduling in
// createBooking / jobs/contactlessVerificationScheduler.js.
export async function sendContactlessVerificationLink(booking) {
  const callbackUrl = `${process.env.FRONTEND_URL}/verification-callback?bookingId=${booking._id}`;
  const session = await diditService.createSession(booking._id.toString(), callbackUrl);

  booking.contactlessCheckIn.diditSessionId = session.session_id;
  await booking.save();

  const checkInLink = `${process.env.FRONTEND_URL}/guest/checkin/${booking._id}`;
  try {
    await sendCheckInLinkEmail(resolveGuestEmail(booking), checkInLink, booking.hotelId.name);
  } catch (emailError) {
    console.error('Error sending check-in link email:', emailError.message);
  }

  return session;
}

// Guest-initiated: lets the guest (re-)request a verification link on-demand, e.g. if an
// earlier session expired (sessions last 7 days) or the automatic send failed.
export const startVerification = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('hotelId').populate('userId', 'email');
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (!(await isAuthorizedForBooking(booking, req))) {
      return res.status(403).json({ message: 'Not authorized for this booking' });
    }

    if (!getEligibleRoomLock(booking.hotelId, booking.roomId)) {
      return res.status(400).json({ message: 'Contactless check-in is not available for this room' });
    }

    // Checked separately from the general window check below so a guest revisiting an old
    // check-in link (e.g. from email, or the browser back button) after already completing
    // verification gets an accurate "you're already checked in" message instead of the
    // generic "not open yet" one, which would be actively misleading here.
    if (booking.checkInInfo?.actualCheckInTime) {
      return res.status(409).json({ message: 'You\'re already checked in for this booking — no need to verify again.' });
    }

    // An unpaid booking can't be checked into — same reasoning as withContactlessEligibility's
    // paymentPending flag, re-checked here since that flag only hides the UI's check-in
    // button and doesn't stop a guest from hitting this endpoint directly.
    if (booking.paymentStatus !== 'completed') {
      return res.status(402).json({ message: 'Please complete payment for this booking before checking in.' });
    }

    // The guest-bookings list only hides the "Check In" button outside this window — it
    // doesn't stop a guest from hitting this endpoint directly (e.g. by navigating straight
    // to /guest/checkin/:bookingId), so the real gate has to live here.
    if (!isWithinCheckInWindow(booking)) {
      return res.status(403).json({ message: `Check-in isn't open yet for this booking — it opens ${CHECKIN_WINDOW_HOURS} hours before your scheduled arrival and closes at check-out.` });
    }

    const session = await sendContactlessVerificationLink(booking);

    res.status(200).json({ success: true, url: session.url });
  } catch (error) {
    console.error('Error starting verification:', error.message);
    res.status(500).json({ message: 'Failed to start identity verification' });
  }
};

// Guest polls this after being redirected back from Didit's hosted verification flow.
export const getVerificationStatus = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('hotelId').populate('userId', 'email');
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (!(await isAuthorizedForBooking(booking, req))) {
      return res.status(403).json({ message: 'Not authorized for this booking' });
    }

    const sessionId = booking.contactlessCheckIn.diditSessionId;
    if (!sessionId) {
      return res.status(400).json({ message: 'Identity verification has not been started for this booking' });
    }

    const decision = await diditService.getSessionDecision(sessionId);

    if (decision.status === 'Approved') {
      const eligible = getEligibleRoomLock(booking.hotelId, booking.roomId);
      if (!eligible) {
        return res.status(400).json({ message: 'Contactless check-in is no longer available for this room' });
      }

      // Verification sessions last up to 7 days, so one started legitimately at the edge of
      // the window (or before payment lapsed) could otherwise complete well after it's closed
      // — re-check both gates here rather than trusting that startVerification's still hold.
      if (booking.paymentStatus !== 'completed') {
        return res.status(402).json({ message: 'Please complete payment for this booking before checking in.' });
      }
      if (!isWithinCheckInWindow(booking)) {
        return res.status(403).json({ message: `Check-in isn't open for this booking right now — it opens ${CHECKIN_WINDOW_HOURS} hours before your scheduled arrival and closes at check-out.` });
      }

      const guestEmail = resolveGuestEmail(booking);
      // Verification succeeding is itself the guest's check-in — without this,
      // actualCheckInTime would never get set for the self-service path, permanently
      // blocking them from ordering hotel services (which require an actual check-in).
      booking.checkInInfo.guestVerified = true;
      booking.checkInInfo.actualCheckInTime = new Date();

      // Only actually issues a key if there's no still-unmet precondition (e.g. an approved
      // early check-in still waiting on the room to be marked ready) — verification alone
      // isn't enough to unlock an early window before the room is actually available.
      const keyIssued = await tryIssueContactlessKey(booking, booking.hotelId, guestEmail);
      await booking.save();

      if (!keyIssued) {
        return res.status(200).json({ status: 'approved', roomPending: true, code: null, ekeyAppLogin: null });
      }

      const ekeyAppLogin = booking.contactlessCheckIn.ekeySent
        ? { username: guestEmail, password: deriveTtlockAppPassword(guestEmail) }
        : null;

      return res.status(200).json({ status: 'approved', code: booking.contactlessCheckIn.smartLockCode, ekeyAppLogin });
    }

    const declinedStatuses = ['Declined', 'Expired', 'Abandoned', 'Kyc Expired'];
    if (declinedStatuses.includes(decision.status)) {
      return res.status(200).json({ status: 'declined' });
    }

    res.status(200).json({ status: 'pending' });
  } catch (error) {
    console.error('Error checking verification status:', error.message);
    res.status(500).json({ message: 'Failed to check verification status' });
  }
};

// Host-only: the raw Didit decision for this booking's verification session, so a host can
// manually review a failed/declined verification (rejection reason, extracted ID data,
// document images if Didit includes them) instead of just seeing "declined". Passed through
// as-is rather than remapped, since Didit's decision payload shape isn't something we own.
export const getVerificationDecision = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('hotelId').populate('userId', 'firstName lastName email');
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    const hotelId = booking.hotelId?._id || booking.hotelId;
    const isHost = req.user.role === 'host' && booking.hotelId?.hostId?.toString() === req.user.userId;
    if (req.user.role !== 'admin' && !isHost && !(await canManageHotel(req, hotelId, 'canCheckInGuests'))) {
      return res.status(403).json({ message: 'Not authorized for this booking' });
    }

    const sessionId = booking.contactlessCheckIn.diditSessionId;
    if (!sessionId) {
      return res.status(400).json({ message: 'Identity verification has not been started for this booking' });
    }

    const decision = await diditService.getSessionDecision(sessionId);

    res.status(200).json({
      success: true,
      guestName: resolveGuestName(booking),
      roomId: booking.roomId,
      decision
    });
  } catch (error) {
    console.error('Error fetching verification decision:', error.message);
    res.status(500).json({ message: 'Failed to fetch verification decision' });
  }
};

// Hands the mobile app the raw TTLock `lockData` blob so it can unlock over Bluetooth
// entirely locally, with no gateway and no guest-side TTLock account. This is our own
// service account's admin lockData, not a per-guest eKey — it carries no expiry on
// TTLock's side, so we enforce the guest's actual stay window and verification status
// ourselves before ever handing it out, and the mobile app should fetch it fresh right
// before each unlock attempt rather than caching it.
export const getLockCredentials = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('hotelId');
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (!(await isAuthorizedForBooking(booking, req))) {
      return res.status(403).json({ message: 'Not authorized for this booking' });
    }

    if (!booking.checkInInfo?.guestVerified) {
      return res.status(403).json({ message: 'Identity verification is required before unlocking' });
    }

    const now = new Date();
    if (now < new Date(booking.checkInDate) || now > new Date(booking.checkOutDate)) {
      return res.status(403).json({ message: 'Unlock is only available during your stay dates' });
    }

    const eligible = getEligibleRoomLock(booking.hotelId, booking.roomId);
    if (!eligible) {
      return res.status(400).json({ message: 'Bluetooth unlock is not available for this room' });
    }

    const lockData = await ttlockService.getLockData(eligible.smartLock.deviceId);

    res.status(200).json({
      lockData: lockData.lockData,
      lockMac: lockData.lockMac,
      lockName: lockData.lockAlias || lockData.lockName,
    });
  } catch (error) {
    console.error('Error fetching lock credentials:', error.message);
    res.status(500).json({ message: 'Failed to fetch lock credentials' });
  }
};

export const confirmCheckIn = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('hotelId').populate('userId', 'email');

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (!(await isAuthorizedForBooking(booking, req))) {
      return res.status(403).json({ message: 'Not authorized to check in this booking' });
    }

    // Front desk can always manually check in a guest who never went through self-service ID
    // verification at all (e.g. a standard, non-contactless room — checking a guest's physical
    // ID in person IS the front-desk workflow). The one case that must hard-block is an
    // explicit Didit decline: staff clicking past a rejected verification is exactly the gap
    // this endpoint had. A still-pending/in-review session doesn't block either — only a
    // resolved rejection does. Skipped once guestVerified is already true (verification
    // already succeeded) to avoid an extra Didit call on the common path.
    if (booking.contactlessCheckIn?.diditSessionId && !booking.checkInInfo?.guestVerified) {
      try {
        const decision = await diditService.getSessionDecision(booking.contactlessCheckIn.diditSessionId);
        if (decision?.status === 'Declined' && req.user.role !== 'admin') {
          return res.status(400).json({
            message: 'This guest\'s ID verification was declined. Check-in cannot proceed until this is resolved.'
          });
        }
      } catch (verificationLookupError) {
        // A Didit outage/lookup failure shouldn't itself block a legitimate front-desk
        // check-in — only an actual, confirmed decline does.
        console.error('Could not fetch verification decision during check-in (non-fatal):', verificationLookupError.message);
      }
    }

    booking.checkInInfo.actualCheckInTime = new Date();
    booking.checkInInfo.guestVerified = true;
    booking.status = 'confirmed';

    // Front-desk check-in stands in for the guest's own contactless setup, so hand them a
    // TTLock key the same way — but only if they don't already have one from self-service,
    // and still gated on room-readiness if an early-checkin approval is waiting on it.
    if (!booking.contactlessCheckIn.enabled) {
      try {
        await tryIssueContactlessKey(booking, booking.hotelId, resolveGuestEmail(booking));
      } catch (ttlockError) {
        console.error('TTLock key assignment on check-in failed (non-fatal):', ttlockError.message);
      }
    }

    await booking.save();

    sendToHotel(booking.hotelId._id || booking.hotelId, 'booking-updated', {
      bookingId: booking._id,
      status: booking.status,
      actualCheckInTime: booking.checkInInfo.actualCheckInTime
    });

    await createNotification({
      userId: booking.userId?._id,
      type: 'arrival',
      title: 'Checked In',
      message: `You're checked in at ${booking.hotelId.name}. Enjoy your stay!`,
      link: '/bookings',
      actionLabel: 'View Booking'
    });

    res.status(200).json({
      success: true,
      booking,
      message: 'Check-in confirmed'
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Host: check a guest out, freeing the room and flagging it for housekeeping
export const checkOutGuest = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('hotelId');

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (!(await isAuthorizedForBooking(booking, req))) {
      return res.status(403).json({ message: 'Not authorized to check out this booking' });
    }

    const hotel = await Hotel.findById(booking.hotelId._id || booking.hotelId);
    const room = hotel?.rooms.find(r => r.roomNumber === booking.roomId);

    // Revoke TTLock access at the moment of checkout, not the original checkOutDate —
    // otherwise a guest checking out early still holds a working passcode/eKey until
    // the room's booked end date, even after the room is handed to housekeeping.
    if (booking.contactlessCheckIn?.enabled && room?.smartLockIntegration?.deviceId) {
      const deviceId = room.smartLockIntegration.deviceId;

      if (booking.contactlessCheckIn.keyboardPwdId) {
        try {
          await ttlockService.deleteKeyboardPwd(deviceId, booking.contactlessCheckIn.keyboardPwdId);
        } catch (revokeError) {
          console.error('Error revoking TTLock passcode on checkout (non-fatal):', revokeError.message);
        }
      }

      if (booking.contactlessCheckIn.ekeyId) {
        try {
          await ttlockService.revokeEkey(deviceId, booking.contactlessCheckIn.ekeyId);
        } catch (revokeError) {
          console.error('Error revoking TTLock eKey on checkout (non-fatal):', revokeError.message);
        }
      }

      booking.contactlessCheckIn.enabled = false;
    }

    booking.checkOutInfo = booking.checkOutInfo || {};
    booking.checkOutInfo.actualCheckOutTime = new Date();
    booking.status = 'completed';
    await booking.save();

    sendToHotel(hotel._id, 'booking-updated', {
      bookingId: booking._id,
      status: booking.status,
      actualCheckOutTime: booking.checkOutInfo.actualCheckOutTime,
      autoCheckedOut: false
    });

    if (room) {
      room.housekeepingStatus = 'dirty';
      await hotel.save();
      await createCleaningTask(hotel, room);
    }

    res.status(200).json({
      success: true,
      booking,
      message: 'Guest checked out'
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

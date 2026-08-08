import crypto from 'crypto';
import Booking from '../models/Booking.js';
import Hotel from '../models/Hotel.js';
import User from '../models/User.js';
import ttlockService from '../services/ttlockService.js';
import diditService from '../services/diditService.js';
import { sendBookingConfirmationEmail, sendCheckInLinkEmail, sendGuestCredentialsEmail } from '../utils/emailUtils.js';
import { createNotification } from '../utils/notificationUtils.js';
import { getAvailableRooms } from './hotelController.js';

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
function resolveGuestEmail(booking) {
  return booking.userId?.email || booking.guestEmail;
}

function resolveGuestName(booking) {
  if (booking.userId?.firstName) {
    return `${booking.userId.firstName} ${booking.userId.lastName || ''}`.trim();
  }
  return booking.guestName || 'Guest';
}

// TTLock auto-provisions an app account for an eKey recipient who isn't already registered
// (createUser: 1), and always sets that account's password to the last 6 characters of the
// username we send — this is TTLock's own convention, not something we choose or store.
function deriveTtlockAppPassword(email) {
  return email.slice(-6);
}

// Generates and saves the TTLock temporary door code for a booking, and — best-effort — sends
// the guest a TTLock eKey so they can also unlock via the TTLock app over Bluetooth (no gateway
// required, same as the passcode). The passcode is the reliable, app-free path, so an eKey
// failure is logged but never blocks check-in. Shared by the standalone setupContactlessCheckIn
// endpoint and the post-verification path in getVerificationStatus.
async function generateContactlessCode(booking, smartLock, guestEmail) {
  const accessCode = await ttlockService.generateAccessCode(
    smartLock.deviceId,
    booking.checkInDate,
    booking.checkOutDate,
    `Guest ${booking.bookingReference}`
  );

  booking.contactlessCheckIn.enabled = true;
  booking.contactlessCheckIn.smartLockCode = accessCode.keyboardPwd;
  booking.contactlessCheckIn.keyboardPwdId = accessCode.keyboardPwdId;
  booking.contactlessCheckIn.expiryTime = new Date(booking.checkOutDate);

  if (guestEmail) {
    try {
      const ekeyResult = await ttlockService.sendEkey(
        smartLock.deviceId,
        guestEmail,
        `Guest ${booking.bookingReference}`,
        booking.checkInDate,
        booking.checkOutDate
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

export const createBooking = async (req, res) => {
  try {
    const { hotelId, roomId, checkInDate, checkOutDate, numberOfGuests, specialRequests } = req.body;

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

    const booking = await Booking.create({
      userId: req.user.userId,
      hotelId,
      roomId,
      checkInDate: checkIn,
      checkOutDate: checkOut,
      numberOfGuests,
      specialRequests,
      totalPrice,
      currency: room.currency || 'NGN',
    });

    // req.user comes from the JWT, which only carries { userId, role } — not email — so
    // the guest's email has to be looked up from the User document, not the token.
    const guestUser = await User.findById(req.user.userId);
    await sendBookingConfirmationEmail(guestUser?.email, {
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

    res.status(201).json({ success: true, booking });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Host creates a walk-in / reception booking on behalf of a guest
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

    const hotel = await Hotel.findOne({ _id: hotelId, hostId: req.user.userId });
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
    let newAccountPassword = null;
    let newAccountFirstName = null;

    if (resolvedUserId) {
      const existingUser = await User.findById(resolvedUserId);
      resolvedGuestEmail = existingUser?.email || null;
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

    const booking = await Booking.create({
      userId: resolvedUserId,
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
    });

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
          bookingReference: booking.bookingReference,
          hotelName: hotel.name,
          checkInDate,
          checkOutDate,
          totalPrice: booking.totalPrice,
          currency: booking.currency,
          // Reception/walk-in guests haven't necessarily seen the app before — point them
          // to it so they can order hotel services during their stay.
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
export const getHotelBookings = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { status } = req.query;

    // Platform admins can view any hotel's bookings for oversight; hosts only their own.
    const hotelQuery = req.user.role === 'admin' ? { _id: hotelId } : { _id: hotelId, hostId: req.user.userId };
    const hotel = await Hotel.findOne(hotelQuery);
    if (!hotel) {
      return res.status(404).json({ message: 'Hotel not found' });
    }

    const filter = { hotelId };
    if (status) filter.status = status;

    const bookings = await Booking.find(filter)
      .populate('userId', 'firstName lastName email phone')
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, bookings });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Attaches a plain contactlessEligible boolean to each booking so the frontend doesn't
// need to duplicate the room/lock eligibility logic itself.
function withContactlessEligibility(bookingDoc) {
  const booking = bookingDoc.toObject();
  booking.contactlessEligible = !!getEligibleRoomLock(booking.hotelId, booking.roomId);
  return booking;
}

export const getBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ userId: req.user.userId })
      .populate('hotelId')
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, bookings: bookings.map(withContactlessEligibility) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// A booking can be accessed by the guest it belongs to, an admin, or the host of its hotel
const isAuthorizedForBooking = (booking, req) => {
  if (req.user.role === 'admin') return true;
  // booking.userId may be a plain ObjectId or a populated User sub-document
  // (e.g. startVerification/getVerificationStatus populate it for the guest's email),
  // so compare against whichever shape it currently is.
  const bookingUserId = booking.userId?._id?.toString() || booking.userId?.toString();
  if (bookingUserId && bookingUserId === req.user.userId) return true;
  if (req.user.role === 'host' && booking.hotelId?.hostId?.toString() === req.user.userId) return true;
  return false;
};

export const getBookingById = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('hotelId');

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (!isAuthorizedForBooking(booking, req)) {
      return res.status(403).json({ message: 'Not authorized to view this booking' });
    }

    res.status(200).json({ success: true, booking: withContactlessEligibility(booking) });
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

    if (!isAuthorizedForBooking(booking, req)) {
      return res.status(403).json({ message: 'Not authorized for this booking' });
    }

    const hotel = booking.hotelId;
    const available = await getAvailableRooms(hotel._id, hotel.rooms, booking.checkInDate, booking.checkOutDate);
    const currentRoom = hotel.rooms.find(r => r.roomNumber === booking.roomId);
    const currentPrice = currentRoom ? getEffectivePrice(currentRoom) : 0;

    const options = available
      .filter(room => room.roomNumber !== booking.roomId && getEffectivePrice(room) > currentPrice)
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

    if (!isAuthorizedForBooking(booking, req)) {
      return res.status(403).json({ message: 'Not authorized to cancel this booking' });
    }

    if (booking.status === 'cancelled') {
      return res.status(400).json({ message: 'Booking already cancelled' });
    }

    booking.status = 'cancelled';
    booking.cancellationReason = cancellationReason;
    booking.cancellationDate = new Date();

    await booking.save();

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

export const setupContactlessCheckIn = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('hotelId').populate('userId', 'email');

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    const eligible = getEligibleRoomLock(booking.hotelId, booking.roomId);
    if (!eligible) {
      return res.status(400).json({ message: 'TTLock is not configured for this room' });
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
      res.status(500).json({ message: 'Failed to generate TTLock code', error: ttlockError.message });
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

    if (!isAuthorizedForBooking(booking, req)) {
      return res.status(403).json({ message: 'Not authorized for this booking' });
    }

    if (!getEligibleRoomLock(booking.hotelId, booking.roomId)) {
      return res.status(400).json({ message: 'Contactless check-in is not available for this room' });
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

    if (!isAuthorizedForBooking(booking, req)) {
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

      const guestEmail = resolveGuestEmail(booking);
      const code = await generateContactlessCode(booking, eligible.smartLock, guestEmail);
      booking.checkInInfo.guestVerified = true;
      // Contactless verification IS the guest's check-in — without this, actualCheckInTime
      // would never get set for the self-service path, permanently blocking them from
      // ordering hotel services (which require an actual check-in, not just a confirmed booking).
      booking.checkInInfo.actualCheckInTime = new Date();
      await booking.save();

      const ekeyAppLogin = booking.contactlessCheckIn.ekeySent
        ? { username: guestEmail, password: deriveTtlockAppPassword(guestEmail) }
        : null;

      return res.status(200).json({ status: 'approved', code, ekeyAppLogin });
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

    if (req.user.role !== 'admin' && booking.hotelId?.hostId?.toString() !== req.user.userId) {
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

    if (!isAuthorizedForBooking(booking, req)) {
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

    if (!isAuthorizedForBooking(booking, req)) {
      return res.status(403).json({ message: 'Not authorized to check in this booking' });
    }

    booking.checkInInfo.actualCheckInTime = new Date();
    booking.checkInInfo.guestVerified = true;
    booking.status = 'confirmed';

    // Front-desk check-in stands in for the guest's own contactless setup, so hand them a
    // TTLock key the same way — but only if they don't already have one from self-service.
    const eligible = getEligibleRoomLock(booking.hotelId, booking.roomId);
    if (eligible && !booking.contactlessCheckIn.enabled) {
      try {
        await generateContactlessCode(booking, eligible.smartLock, resolveGuestEmail(booking));
      } catch (ttlockError) {
        console.error('TTLock key assignment on check-in failed (non-fatal):', ttlockError.message);
      }
    }

    await booking.save();

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

    if (!isAuthorizedForBooking(booking, req)) {
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

    if (room) {
      room.housekeepingStatus = 'dirty';
      await hotel.save();
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

import Hotel from '../models/Hotel.js';
import Booking from '../models/Booking.js';
import ServiceOrder from '../models/ServiceOrder.js';
import ServiceCatalogItem from '../models/ServiceCatalogItem.js';
import Staff from '../models/Staff.js';
import { tryIssueContactlessKey, resolveGuestEmail } from './bookingController.js';
import { canManageHotel } from '../utils/staffAuth.js';
import ttlockService from '../services/ttlockService.js';
import { sendToHotel } from '../utils/sseHub.js';
import { combineDateAndTime, isValidTimeZone, resolveHotelTimeZone } from '../utils/hotelTime.js';

const ROOM_READY_STATUSES = ['clean', 'inspected'];

// Everything else on the Hotel schema is either computed (rating, reviewCount — derived from
// actual reviews), identity/ownership (hostId, _id), or has its own dedicated, more tightly
// gated endpoint: isActive (admin-only, PATCH /admin/hotels/:id/status), flutterwaveSubaccountId
// (admin-only, PATCH /hotels/:id/payment-subaccount), bankDetails (PATCH /hotels/:id/bank-details).
// rooms are managed through the separate /hotels/host/rooms endpoints, not this one. A field
// not on this list is silently dropped from the request rather than reaching the database,
// so a caller can't smuggle in host-controlled or computed fields by simply adding them to the
// PUT body.
const ALLOWED_HOTEL_UPDATE_FIELDS = ['name', 'description', 'category', 'location', 'images', 'amenities', 'policies'];

// Vacant/Occupied is a distinct concept from the room's own `status` field (available/
// occupied/maintenance, which is about sellability — can this room be booked at all — and is
// set by the host or the room-upgrade flow, not by the booking lifecycle itself). Vacant means
// "no guest is physically in this room right now", derived the same way host-front-desk.ts's
// inHouse() already does: a non-cancelled booking that has checked in but not checked out.
// Keeping the two separate means a room can be sellable (available) and vacant, or held for a
// future reservation (unavailable for new bookings) while still vacant today, without either
// dimension silently overwriting the other.
// Full room-status model: three independent, host-facing dimensions, plus one computed
// summary that priority-orders them for a single at-a-glance badge.
//   - status (maintenance/sellability intent, host-set): available | out-of-order | out-of-
//     service. OOO = cannot be sold or used at all; OOS = temporarily unavailable (a lesser,
//     shorter block than OOO). Legacy 'occupied'/'maintenance' values are normalized here so
//     old data displays sanely without a migration; a room's actual occupancy is NEVER stored
//     on `status` itself (see currentStatus below) — this field is host intent only.
//   - occupancyStatus (derived): vacant | occupied — is a guest physically in the room right
//     now (an active, checked-in-not-yet-checked-out booking)? Kept separate from `status`
//     and from `reservationStatus` on purpose, per the room's own request to track it as its
//     own state.
//   - reservationStatus (derived): reserved | none — is there a confirmed, non-cancelled,
//     not-yet-checked-in booking for this room (i.e. booked for a future/pending stay)?
//   - currentStatus (derived summary): the single "what's going on with this room right now"
//     label, in priority order — a maintenance block always wins (a room can't be sold no
//     matter who's booked it), then actual occupancy, then a pending reservation, else it's
//     genuinely available to sell.
async function attachRoomOccupancy(hotel) {
  if (!hotel) return hotel;

  const plain = hotel.toObject ? hotel.toObject() : hotel;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const relevantBookings = await Booking.find({
    hotelId: plain._id,
    status: { $ne: 'cancelled' },
    checkOutDate: { $gte: today }
  }).select('roomId checkInInfo.actualCheckInTime checkOutInfo.actualCheckOutTime');

  const occupiedRoomNumbers = new Set();
  const reservedRoomNumbers = new Set();
  for (const booking of relevantBookings) {
    const isCheckedIn = !!booking.checkInInfo?.actualCheckInTime;
    const isCheckedOut = !!booking.checkOutInfo?.actualCheckOutTime;
    if (isCheckedIn && !isCheckedOut) {
      occupiedRoomNumbers.add(booking.roomId);
    } else if (!isCheckedIn && !isCheckedOut) {
      reservedRoomNumbers.add(booking.roomId);
    }
  }

  plain.rooms = (plain.rooms || []).map(room => {
    const normalizedStatus = room.status === 'maintenance' ? 'out-of-order'
      : room.status === 'occupied' ? 'available'
      : (room.status || 'available');
    const isOccupied = occupiedRoomNumbers.has(room.roomNumber);
    const isReserved = !isOccupied && reservedRoomNumbers.has(room.roomNumber);

    let currentStatus;
    if (normalizedStatus === 'out-of-order') currentStatus = 'out-of-order';
    else if (normalizedStatus === 'out-of-service') currentStatus = 'out-of-service';
    else if (isOccupied) currentStatus = 'occupied';
    else if (isReserved) currentStatus = 'reserved';
    else currentStatus = 'available';

    return {
      ...room,
      status: normalizedStatus,
      occupancyStatus: isOccupied ? 'occupied' : 'vacant',
      reservationStatus: isReserved ? 'reserved' : 'none',
      currentStatus
    };
  });

  return plain;
}

function timeStringToMinutes(time) {
  if (!time) return null;
  const [hours, minutes] = String(time).split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

// "Early" and "late" only mean something relative to the standard check-in/check-out times —
// letting a host save an earliest-early-check-in time that's at or after standard check-in
// (or a latest-late-check-out at or before standard check-out) would silently make every
// early-checkin/late-checkout request server-side-reject as "outside the allowed window"
// (see computeAuthoritativePricing in serviceOrderController.js), with no indication to the
// host of why. Catch it here instead, at the one place these policies get saved.
function validatePolicyTimes(policies) {
  if (!policies) return null;
  if (policies.timeZone && !isValidTimeZone(policies.timeZone)) {
    return 'Hotel timezone must be a valid IANA timezone, such as Europe/Helsinki or Africa/Lagos.';
  }
  const checkIn = timeStringToMinutes(policies.checkInTime);
  const checkOut = timeStringToMinutes(policies.checkOutTime);
  const earlyFrom = timeStringToMinutes(policies.earlyCheckInFrom);
  const lateUntil = timeStringToMinutes(policies.lateCheckOutUntil);

  if (earlyFrom != null && checkIn != null && earlyFrom >= checkIn) {
    return 'Earliest early check-in time must be before the standard check-in time.';
  }
  if (lateUntil != null && checkOut != null && lateUntil <= checkOut) {
    return 'Latest late check-out time must be after the standard check-out time.';
  }
  return null;
}

// A confirmed early-checkin request that arrived before the room was actually ready (or
// before identity verification completed) leaves the guest's booking flagged
// pendingRoomReady (see finalizeEarlyCheckIn in serviceOrderController.js) instead of issuing
// a key right away. The moment housekeeping marks the room ready, this picks that up —
// tryIssueContactlessKey itself still checks that verification has also completed.
async function issueKeyForReadyRoom(hotel, room) {
  if (!ROOM_READY_STATUSES.includes(room.housekeepingStatus)) return;

  const booking = await Booking.findOne({
    hotelId: hotel._id,
    roomId: room.roomNumber,
    'checkInInfo.pendingRoomReady': true,
    status: { $ne: 'cancelled' }
  }).populate('userId', 'email firstName lastName');
  if (!booking) return;

  try {
    await tryIssueContactlessKey(booking, hotel, resolveGuestEmail(booking));
    await booking.save();
  } catch (error) {
    console.error(`Error issuing early-checkin key once room ${room.roomNumber} became ready (non-fatal):`, error.message);
  }
}

// Shared by the manual room-edit form (updateMyRoom, below) and taskController.updateTaskStatus
// (which calls this when a cleaning Task is marked completed, to sync that back to Front
// Desk) — both need the exact same "did this room just become ready" side effect (issuing a
// pending early-checkin key), not just the field write, so this is the one place that does both.
export async function setRoomHousekeepingStatus(hotelId, roomNumber, housekeepingStatus) {
  const hotel = await Hotel.findById(hotelId);
  if (!hotel) return null;
  const room = hotel.rooms.find(r => r.roomNumber === roomNumber);
  if (!room) return null;

  const wasReady = ROOM_READY_STATUSES.includes(room.housekeepingStatus);
  room.housekeepingStatus = housekeepingStatus;
  await hotel.save();

  // Front Desk (and any other open staff view) needs to see this the moment it happens, not
  // on the next manual reload — see host-front-desk.ts's realtime subscription.
  sendToHotel(hotelId, 'room-updated', { roomNumber: room.roomNumber, housekeepingStatus: room.housekeepingStatus });

  if (!wasReady && ROOM_READY_STATUSES.includes(room.housekeepingStatus)) {
    await issueKeyForReadyRoom(hotel, room);
  }

  return room;
}

// Default host-managed extra services every new hotel starts with, since these are
// common enough to offer out of the box. Hosts can rename, reprice, or delete them
// like any other custom service — this is just a convenience seed, not a fixed type.
const DEFAULT_CUSTOM_SERVICES = [
  {
    name: 'Conference Room Rental',
    description: 'Fully equipped conference room, billed hourly.',
    icon: '🏢',
    price: 15000,
    requiresScheduling: true
  },
  {
    name: 'Meeting Room Rental',
    description: 'Private meeting room for small groups, billed hourly.',
    icon: '💼',
    price: 8000,
    requiresScheduling: true
  }
];

// A room is available for a date range only when it is operationally ready for a guest:
// not maintenance-blocked, clean or inspected by housekeeping, large enough for the party,
// and free of an overlapping non-cancelled booking. A dirty room remains reserved for any
// existing guest but is not sellable for a new booking until Front Desk/housekeeping marks it
// clean or inspected. Without dates, the same sellability and capacity checks still apply.
const MAINTENANCE_BLOCKED_STATUSES = ['out-of-order', 'out-of-service', 'maintenance'];

export async function getAvailableRooms(hotelId, rooms, checkIn, checkOut, guests) {
  let available = rooms.filter(room =>
    !MAINTENANCE_BLOCKED_STATUSES.includes(room.status) &&
    ROOM_READY_STATUSES.includes(room.housekeepingStatus)
  );

  if (guests) {
    available = available.filter(room => room.capacity >= Number(guests));
  }

  if (checkIn && checkOut) {
    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    const overlapping = await Booking.find({
      hotelId,
      status: { $ne: 'cancelled' },
      checkInDate: { $lt: checkOutDate },
      checkOutDate: { $gt: checkInDate }
    }).select('roomId');
    const bookedRoomNumbers = new Set(overlapping.map(b => b.roomId));
    available = available.filter(room => !bookedRoomNumbers.has(room.roomNumber));
  }

  return available;
}

export const getAllHotels = async (req, res) => {
  try {
    const { city, minPrice, maxPrice, amenities, rating, checkIn, checkOut, guests } = req.query;

    let query = { isActive: true };

    if (city) query['location.city'] = { $regex: city, $options: 'i' };
    if (minPrice || maxPrice) {
      query['rooms.basePrice'] = {};
      if (minPrice) query['rooms.basePrice'].$gte = Number(minPrice);
      if (maxPrice) query['rooms.basePrice'].$lte = Number(maxPrice);
    }
    if (amenities) {
      const amenitiesArray = Array.isArray(amenities) ? amenities : [amenities];
      query.amenities = { $in: amenitiesArray };
    }
    if (rating) query.rating = { $gte: Number(rating) };

    const hotelDocs = await Hotel.find(query)
      .select('-rooms.smartLockIntegration.clientId -rooms.smartLockIntegration.deviceId -bankDetails -flutterwaveSubaccountId')
      .populate('hostId', 'firstName lastName')
      .limit(50);

    const withAvailability = await Promise.all(
      hotelDocs.map(async hotel => {
        const plain = hotel.toObject();
        plain.rooms = await getAvailableRooms(hotel._id, plain.rooms, checkIn, checkOut, guests);
        return plain;
      })
    );

    // Only hide hotels with zero availability when the guest actually searched for dates.
    const hotels = (checkIn && checkOut) ? withAvailability.filter(h => h.rooms.length > 0) : withAvailability;

    res.status(200).json({ success: true, count: hotels.length, hotels });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getHotelById = async (req, res) => {
  try {
    const { checkIn, checkOut, guests } = req.query;

    const hotel = await Hotel.findById(req.params.id)
      .select('-rooms.smartLockIntegration.clientId -rooms.smartLockIntegration.deviceId -bankDetails -flutterwaveSubaccountId')
      .populate('hostId');

    if (!hotel) {
      return res.status(404).json({ message: 'Hotel not found' });
    }

    const plain = hotel.toObject();
    plain.rooms = await getAvailableRooms(hotel._id, plain.rooms, checkIn, checkOut, guests);

    res.status(200).json({ success: true, hotel: plain });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getMyHotel = async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ hostId: req.user.userId });

    res.status(200).json({
      success: true,
      hotel: await attachRoomOccupancy(hotel),
      isConfigured: Boolean(hotel),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getHostDashboard = async (req, res) => {
  try {
    let hotel;
    if (req.user.role === 'staff') {
      const staff = await Staff.findOne({ userId: req.user.userId, status: 'active' });
      if (!staff || !(await canManageHotel(req, staff.hotelId, 'canManageStaff'))) {
        return res.status(403).json({ message: 'Not authorized to view this hotel overview' });
      }
      hotel = await Hotel.findById(staff.hotelId).lean();
    } else {
      hotel = await Hotel.findOne({ hostId: req.user.userId }).lean();
    }

    if (!hotel) {
      return res.status(200).json({
        success: true,
        hotel: null,
        metrics: {
          rooms: 0,
          occupiedRooms: 0,
          availableRooms: 0,
          totalBookings: 0,
          activeBookings: 0,
          bookingRevenue: 0,
          serviceOrders: 0,
          serviceRevenue: 0,
        },
        serviceStats: [],
        recentBookings: [],
        todayArrivals: [],
        todayDepartures: [],
      });
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);
    const [bookingStats, serviceStats, recentBookings, todayArrivals, todayDepartures] = await Promise.all([
      Booking.aggregate([
        { $match: { hotelId: hotel._id } },
        {
          $group: {
            _id: null,
            totalBookings: { $sum: 1 },
            activeBookings: {
              $sum: {
                $cond: [{ $in: ['$status', ['pending', 'confirmed']] }, 1, 0],
              },
            },
            // Only bookings that actually collected payment count toward revenue — a
            // pending/failed/never-attempted payment isn't money the host has, and a
            // cancelled booking is excluded regardless of paymentStatus (see
            // RECEIPT_ELIGIBLE_PAYMENT_STATUSES in receiptController.js for the analogous
            // "was this ever really paid" check used elsewhere).
            bookingRevenue: {
              $sum: {
                $cond: [
                  { $and: [{ $ne: ['$status', 'cancelled'] }, { $eq: ['$paymentStatus', 'completed'] }] },
                  '$totalPrice',
                  0,
                ],
              },
            },
          },
        },
      ]),
      ServiceOrder.aggregate([
        { $match: { hotelId: hotel._id } },
        {
          $group: {
            _id: '$serviceType',
            orders: { $sum: 1 },
            // Orders still in flight — everything except the three terminal statuses. This is
            // what the dashboard cards show as the headline count: a card should read 0 once
            // nothing is currently in progress, not keep showing a lifetime total that never
            // drops even after every order from months ago is long since delivered.
            active: {
              $sum: {
                $cond: [{ $not: [{ $in: ['$status', ['completed', 'delivered', 'cancelled']] }] }, 1, 0],
              },
            },
            pending: {
              $sum: {
                $cond: [{ $eq: ['$status', 'pending'] }, 1, 0],
              },
            },
            // Unlike bookings, most service orders are charged to the guest's room rather than
            // paid online at order time — paymentStatus stays 'pending' for the life of the
            // order unless a host explicitly marks it paid (today only laundry's UI does that;
            // see updatePaymentStatus in serviceOrderController.js) or the guest paid through
            // the separate early-checkin/late-checkout Flutterwave flow. Requiring
            // paymentStatus === 'completed' here (like bookingRevenue does) would hide nearly
            // all order revenue, not fix an inflation bug — cancelled is still excluded, since
            // that's a real "never happened" case regardless of payment model.
            revenue: {
              $sum: {
                $cond: [{ $ne: ['$status', 'cancelled'] }, '$total', 0],
              },
            },
            // Revenue from just the still-in-flight orders (mirrors `active` above) — the
            // dashboard card pairs this with the "current" order count, so both numbers on the
            // card describe the same live snapshot rather than mixing a current count with a
            // lifetime revenue total. `revenue` (all-time) still backs the Total Revenue metric
            // and the dedicated Revenue page, where a historical total is the correct figure.
            activeRevenue: {
              $sum: {
                $cond: [{ $not: [{ $in: ['$status', ['completed', 'delivered', 'cancelled']] }] }, '$total', 0],
              },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Booking.find({ hotelId: hotel._id })
        .populate('userId', 'firstName lastName')
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
      Booking.find({ hotelId: hotel._id, checkInDate: { $gte: todayStart, $lt: todayEnd }, status: { $ne: 'cancelled' } }).populate('userId', 'firstName lastName').sort({ checkInDate: 1 }).limit(20).lean(),
      Booking.find({ hotelId: hotel._id, checkOutDate: { $gte: todayStart, $lt: todayEnd }, status: { $nin: ['cancelled', 'completed'] } }).populate('userId', 'firstName lastName').sort({ checkOutDate: 1 }).limit(20).lean(),
    ]);

    const bookingMetrics = bookingStats[0] || {
      totalBookings: 0,
      activeBookings: 0,
      bookingRevenue: 0,
    };
    const serviceOrders = serviceStats.reduce((total, item) => total + item.orders, 0);
    const serviceRevenue = serviceStats.reduce((total, item) => total + item.revenue, 0);
    const hotelTimeZone = resolveHotelTimeZone(hotel);

    // Booking checkInDate/checkOutDate are calendar dates stored at midnight. The dashboard's
    // operations list needs the actual expected moment instead: a confirmed early check-in or
    // late checkout overrides the hotel policy time and is persisted on the booking by the
    // service-order confirmation flow. Expose the resolved values explicitly so the client
    // never has to infer an arrival/departure time from the raw midnight date.
    const withExpectedOperationTime = (bookings, kind) => bookings.map(booking => ({
      ...booking,
      hotelTimeZone,
      [kind === 'arrival' ? 'expectedArrival' : 'expectedDeparture']:
        kind === 'arrival'
          ? (booking.checkInInfo?.approvedEarlyCheckInTime || combineDateAndTime(booking.checkInDate, hotel.policies?.checkInTime || '15:00', hotelTimeZone))
          : (booking.checkOutInfo?.approvedLateCheckOutTime || combineDateAndTime(booking.checkOutDate, hotel.policies?.checkOutTime || '11:00', hotelTimeZone))
    }));

    res.status(200).json({
      success: true,
      hotel,
      metrics: {
        rooms: hotel.rooms?.length || 0,
        occupiedRooms: hotel.rooms?.filter(room => room.status === 'occupied').length || 0,
        availableRooms: hotel.rooms?.filter(room =>
          room.status === 'available' && ROOM_READY_STATUSES.includes(room.housekeepingStatus)
        ).length || 0,
        ...bookingMetrics,
        serviceOrders,
        serviceRevenue,
      },
      serviceStats,
      recentBookings,
      todayArrivals: withExpectedOperationTime(todayArrivals, 'arrival'),
      todayDepartures: withExpectedOperationTime(todayDepartures, 'departure'),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getMyRooms = async (req, res) => {
  try {
    let hotel;
    if (req.user.role === 'staff') {
      const staff = await Staff.findOne({ userId: req.user.userId, status: 'active' });
      if (!staff || !(await canManageHotel(req, staff.hotelId, 'canAccessRooms'))) {
        return res.status(403).json({ message: 'Not authorized to view rooms at this hotel' });
      }
      hotel = await Hotel.findById(staff.hotelId);
    } else {
      hotel = await Hotel.findOne({ hostId: req.user.userId });
    }
    if (!hotel) {
      return res.status(404).json({ message: 'Complete your hotel setup first' });
    }

    const { rooms } = await attachRoomOccupancy(hotel);
    res.status(200).json({ success: true, hotelId: hotel._id, rooms });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Same rule the Room subdocument schema itself enforces (see models/Hotel.js) — checked here
// too so a bad payload gets a clear, specific 400 instead of falling through to whatever
// generic message a Mongoose ValidationError happens to produce on save.
function validateRoomPricing(basePrice, discountPrice) {
  if (basePrice != null && Number(basePrice) < 0) {
    return 'Base price cannot be negative.';
  }
  if (discountPrice != null && discountPrice !== '' && Number(discountPrice) < 0) {
    return 'Discount price cannot be negative.';
  }
  if (discountPrice != null && discountPrice !== '' && Number(discountPrice) !== 0 && Number(discountPrice) >= Number(basePrice)) {
    return 'Discount price must be lower than the base price.';
  }
  return null;
}

export const addMyRoom = async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ hostId: req.user.userId });
    if (!hotel) {
      return res.status(404).json({ message: 'Complete your hotel setup first' });
    }

    if (hotel.rooms.some(room => room.roomNumber === req.body.roomNumber)) {
      return res.status(409).json({ message: 'That room number already exists' });
    }

    const priceError = validateRoomPricing(req.body.basePrice, req.body.discountPrice);
    if (priceError) {
      return res.status(400).json({ message: priceError });
    }

    hotel.rooms.push(req.body);
    await hotel.save();
    res.status(201).json({ success: true, room: hotel.rooms.at(-1) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Staff (with canAccessRooms) update rooms through this same endpoint for two legitimate,
// narrow reasons today: marking housekeeping status (host-front-desk.ts's markRoomClean /
// host-room-management.ts's updateHousekeeping) and now renaming a room's type/name. Business
// config — pricing, images, smart lock credentials, the room number itself — stays host/admin
// only, so a staff member's client (or a raw API call) can't smuggle those in via this route.
const STAFF_EDITABLE_ROOM_FIELDS = ['housekeepingStatus', 'type'];

export const updateMyRoom = async (req, res) => {
  try {
    let hotel;
    let isStaff = false;
    if (req.user.role === 'staff') {
      isStaff = true;
      const staff = await Staff.findOne({ userId: req.user.userId, status: 'active' });
      if (!staff || !(await canManageHotel(req, staff.hotelId, 'canAccessRooms'))) {
        return res.status(403).json({ message: 'Not authorized to update rooms at this hotel' });
      }
      hotel = await Hotel.findById(staff.hotelId);
    } else {
      hotel = await Hotel.findOne({ hostId: req.user.userId });
    }
    if (!hotel) {
      return res.status(404).json({ message: 'Hotel not found' });
    }

    const room = hotel.rooms.id(req.params.roomId);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const updates = isStaff
      ? Object.fromEntries(STAFF_EDITABLE_ROOM_FIELDS.filter(key => key in req.body).map(key => [key, req.body[key]]))
      : req.body;

    const duplicate = hotel.rooms.some(
      item => item._id.toString() !== room._id.toString() &&
        item.roomNumber === updates.roomNumber
    );
    if (duplicate) {
      return res.status(409).json({ message: 'That room number already exists' });
    }

    // A partial update might only touch one of the two price fields — validate against the
    // combination that will actually be in effect afterward, not just whatever's in this body.
    const effectiveBasePrice = 'basePrice' in updates ? updates.basePrice : room.basePrice;
    const effectiveDiscountPrice = 'discountPrice' in updates ? updates.discountPrice : room.discountPrice;
    const priceError = validateRoomPricing(effectiveBasePrice, effectiveDiscountPrice);
    if (priceError) {
      return res.status(400).json({ message: priceError });
    }

    const wasReady = ROOM_READY_STATUSES.includes(room.housekeepingStatus);
    const priorHousekeepingStatus = room.housekeepingStatus;
    room.set(updates);
    await hotel.save();

    if (room.housekeepingStatus !== priorHousekeepingStatus) {
      sendToHotel(hotel._id, 'room-updated', { roomNumber: room.roomNumber, housekeepingStatus: room.housekeepingStatus });
    }

    if (!wasReady && ROOM_READY_STATUSES.includes(room.housekeepingStatus)) {
      await issueKeyForReadyRoom(hotel, room);
    }

    res.status(200).json({ success: true, room });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const deleteMyRoom = async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ hostId: req.user.userId });
    if (!hotel) {
      return res.status(404).json({ message: 'Hotel not found' });
    }

    const room = hotel.rooms.id(req.params.roomId);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Every booking ever made against this room — status !== cancelled/completed covers both
    // an upcoming reservation and a guest currently in-house (checkout doesn't happen until
    // status flips to 'completed', see checkOutGuest), and either one would be broken by
    // deleting the room out from under it.
    const roomBookings = await Booking.find({ hotelId: hotel._id, roomId: room.roomNumber });

    const activeStay = roomBookings.find(b => b.status !== 'cancelled' && b.status !== 'completed');
    if (activeStay) {
      const guestLabel = activeStay.guestName || 'A guest';
      const stayState = activeStay.checkInInfo?.actualCheckInTime ? 'is currently checked in' : 'has an upcoming reservation';
      return res.status(409).json({
        message: `Room ${room.roomNumber} cannot be deleted — ${guestLabel} ${stayState} (booking ${activeStay.bookingReference}). Cancel or complete that booking first.`
      });
    }

    // A past booking's TTLock key can still be enabled if revocation silently failed at
    // checkout (see checkOutGuest's non-fatal try/catch) — deleting the room now would discard
    // our only record of that key while leaving the physical passcode/eKey itself still
    // usable. Try to actually revoke it before allowing deletion, not just drop the record.
    const bookingsWithActiveKey = roomBookings.filter(b => b.contactlessCheckIn?.enabled);
    const deviceId = room.smartLockIntegration?.deviceId;
    for (const activeKeyBooking of bookingsWithActiveKey) {
      try {
        if (deviceId && activeKeyBooking.contactlessCheckIn.keyboardPwdId) {
          await ttlockService.deleteKeyboardPwd(deviceId, activeKeyBooking.contactlessCheckIn.keyboardPwdId);
        }
        if (deviceId && activeKeyBooking.contactlessCheckIn.ekeyId) {
          await ttlockService.revokeEkey(deviceId, activeKeyBooking.contactlessCheckIn.ekeyId);
        }
        activeKeyBooking.contactlessCheckIn.enabled = false;
        await activeKeyBooking.save();
      } catch (revokeError) {
        console.error('Error revoking TTLock key before room deletion:', revokeError.message);
        return res.status(409).json({
          message: `Room ${room.roomNumber} cannot be deleted — an active digital key from booking ${activeKeyBooking.bookingReference} could not be revoked. Please try again, or revoke it manually first.`
        });
      }
    }

    room.deleteOne();
    await hotel.save();
    res.status(200).json({ success: true, message: 'Room deleted' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const createHotel = async (req, res) => {
  try {
    const existingHotel = await Hotel.findOne({ hostId: req.user.userId });
    if (existingHotel) {
      return res.status(409).json({
        message: 'Your host account already has a hotel. Update it from Settings.',
        hotel: existingHotel,
      });
    }

    const policyError = validatePolicyTimes(req.body.policies);
    if (policyError) {
      return res.status(400).json({ message: policyError });
    }

    const hotelData = {
      ...req.body,
      hostId: req.user.userId,
    };

    const hotel = await Hotel.create(hotelData);

    await ServiceCatalogItem.insertMany(
      DEFAULT_CUSTOM_SERVICES.map(service => ({
        ...service,
        hotelId: hotel._id,
        serviceType: 'custom'
      }))
    );

    res.status(201).json({ success: true, hotel });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateHotel = async (req, res) => {
  try {
    let hotel = await Hotel.findById(req.params.id);

    if (!hotel) {
      return res.status(404).json({ message: 'Hotel not found' });
    }

    const isOwner = hotel.hostId.toString() === req.user.userId;
    if (!isOwner && req.user.role !== 'admin' && !(await canManageHotel(req, hotel._id, 'canChangeHotelSettings'))) {
      return res.status(403).json({ message: 'Not authorized to update this hotel' });
    }

    // Merge with the hotel's existing policies first — a partial policies payload (e.g. only
    // checkInTime changed) shouldn't be validated as if the other fields were being unset.
    const mergedPolicies = { ...hotel.policies?.toObject?.() ?? hotel.policies, ...req.body.policies };
    const policyError = validatePolicyTimes(req.body.policies ? mergedPolicies : null);
    if (policyError) {
      return res.status(400).json({ message: policyError });
    }

    // Allow-list, not a deny-list: only fields explicitly named in
    // ALLOWED_HOTEL_UPDATE_FIELDS ever reach the database, so an unrecognized or
    // host-controlled/computed field in the request body (rating, reviewCount, hostId,
    // isActive, flutterwaveSubaccountId, bankDetails, rooms, _id, ...) is dropped rather
    // than silently written.
    const updatableFields = {};
    for (const field of ALLOWED_HOTEL_UPDATE_FIELDS) {
      if (req.body[field] !== undefined) {
        // Policies is a nested object. Save the merged version so an older browser bundle
        // that does not yet send newer fields (such as timeZone) cannot erase them while
        // changing an unrelated setting like checkOutTime.
        updatableFields[field] = field === 'policies' ? mergedPolicies : req.body[field];
      }
    }

    hotel = await Hotel.findByIdAndUpdate(
      req.params.id,
      { ...updatableFields, updatedAt: Date.now() },
      { new: true, runValidators: true }
    );

    res.status(200).json({ success: true, hotel });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Admin-only, and deliberately separate from updateHotel (which strips this field out of
// req.body entirely) — a hotel's Flutterwave subaccount is created manually on Flutterwave's
// own merchant dashboard after the platform verifies the hotel's bank details, then an admin
// pastes the resulting id here. Passing an empty string/null unsets it, reverting the hotel's
// bookings to the platform's own Flutterwave account (see launchPayment in checkout.ts).
export const updateHotelPaymentSubaccount = async (req, res) => {
  try {
    const { flutterwaveSubaccountId } = req.body;

    const hotel = await Hotel.findByIdAndUpdate(
      req.params.id,
      { flutterwaveSubaccountId: flutterwaveSubaccountId || null, updatedAt: Date.now() },
      { new: true, runValidators: true }
    );

    if (!hotel) {
      return res.status(404).json({ message: 'Hotel not found' });
    }

    res.status(200).json({ success: true, hotel });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Host-writable (unlike the subaccount id above) — this is just the hotel's own bank details,
// submitted so an admin has what they need to actually create the Flutterwave subaccount.
// Submitting new details never touches flutterwaveSubaccountId itself; an admin still has to
// review the details and create/paste the subaccount id separately.
export const updateHotelBankDetails = async (req, res) => {
  try {
    const hotel = await Hotel.findById(req.params.id);
    if (!hotel) {
      return res.status(404).json({ message: 'Hotel not found' });
    }

    if (hotel.hostId.toString() !== req.user.userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to update this hotel' });
    }

    const { bankName, accountNumber, accountName } = req.body;
    if (!bankName || !accountNumber || !accountName) {
      return res.status(400).json({ message: 'Bank name, account number, and account name are all required.' });
    }

    hotel.bankDetails = { bankName, accountNumber, accountName, submittedAt: Date.now() };
    hotel.updatedAt = Date.now();
    await hotel.save();

    res.status(200).json({ success: true, hotel });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteHotel = async (req, res) => {
  try {
    const hotel = await Hotel.findById(req.params.id);

    if (!hotel) {
      return res.status(404).json({ message: 'Hotel not found' });
    }

    if (hotel.hostId.toString() !== req.user.userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to delete this hotel' });
    }

    await Hotel.findByIdAndDelete(req.params.id);

    res.status(200).json({ success: true, message: 'Hotel deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const searchHotels = async (req, res) => {
  try {
    const { city, checkIn, checkOut, guests, minPrice, maxPrice } = req.query;

    let query = { isActive: true };

    if (city) query['location.city'] = { $regex: city, $options: 'i' };
    if (minPrice || maxPrice) {
      query['rooms.basePrice'] = {};
      if (minPrice) query['rooms.basePrice'].$gte = Number(minPrice);
      if (maxPrice) query['rooms.basePrice'].$lte = Number(maxPrice);
    }

    const hotelDocs = await Hotel.find(query)
      .select('-rooms.smartLockIntegration.clientId -rooms.smartLockIntegration.deviceId -bankDetails -flutterwaveSubaccountId')
      .populate('hostId', 'firstName lastName');

    const withAvailability = await Promise.all(
      hotelDocs.map(async hotel => {
        const plain = hotel.toObject();
        plain.rooms = await getAvailableRooms(hotel._id, plain.rooms, checkIn, checkOut, guests);
        return plain;
      })
    );

    const hotels = (checkIn && checkOut) ? withAvailability.filter(h => h.rooms.length > 0) : withAvailability;

    res.status(200).json({
      success: true,
      count: hotels.length,
      hotels,
      searchParams: { city, checkIn, checkOut, guests }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Host revenue summary with one consistent eligibility rule for bookings and services.
export const getHostRevenue = async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ hostId: req.user.userId }).select('_id policies');
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
    const start = req.query.startDate ? new Date(req.query.startDate) : new Date(Date.now() - 30 * 86400000);
    const end = req.query.endDate ? new Date(req.query.endDate) : new Date();
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return res.status(400).json({ error: 'Invalid revenue date range' });
    const range = { $gte: start, $lte: end };
    const [bookings, services, serviceCategories, dailyBookings, dailyServices] = await Promise.all([
      Booking.aggregate([{ $match: { hotelId: hotel._id, createdAt: range, status: { $ne: 'cancelled' }, paymentStatus: 'completed' } }, { $group: { _id: null, revenue: { $sum: '$totalPrice' }, orders: { $sum: 1 } } }]),
      ServiceOrder.aggregate([{ $match: { hotelId: hotel._id, createdAt: range, status: { $ne: 'cancelled' } } }, { $group: { _id: null, revenue: { $sum: '$total' }, orders: { $sum: 1 } } }]),
      ServiceOrder.aggregate([{ $match: { hotelId: hotel._id, createdAt: range, status: { $ne: 'cancelled' } } }, { $group: { _id: '$serviceType', revenue: { $sum: '$total' }, orders: { $sum: 1 } } }, { $sort: { revenue: -1 } }]),
      Booking.aggregate([{ $match: { hotelId: hotel._id, createdAt: range, status: { $ne: 'cancelled' }, paymentStatus: 'completed' } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, revenue: { $sum: '$totalPrice' }, orders: { $sum: 1 } } }]),
      ServiceOrder.aggregate([{ $match: { hotelId: hotel._id, createdAt: range, status: { $ne: 'cancelled' } } }, { $group: { _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, serviceType: '$serviceType' }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } }])
    ]);
    const room = bookings[0] || { revenue: 0, orders: 0 };
    const service = services[0] || { revenue: 0, orders: 0 };
    const daily = new Map();
    for (const row of dailyBookings) daily.set(row._id, { date: row._id, roomRevenue: row.revenue, serviceRevenue: 0, orders: row.orders, services: {} });
    for (const row of dailyServices) { const day = daily.get(row._id.date) || { date: row._id.date, roomRevenue: 0, serviceRevenue: 0, orders: 0, services: {} }; day.serviceRevenue += row.revenue; day.orders += row.orders; day.services[row._id.serviceType || 'custom'] = (day.services[row._id.serviceType || 'custom'] || 0) + row.revenue; daily.set(row._id.date, day); }
    res.json({ startDate: start, endDate: end, currency: 'NGN', roomRevenue: room.revenue, serviceRevenue: service.revenue, totalRevenue: room.revenue + service.revenue, roomOrders: room.orders, serviceOrders: service.orders, serviceCategories, daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)) });
  } catch (error) {
    console.error('Error loading host revenue summary:', error);
    res.status(500).json({ error: 'Failed to load revenue summary' });
  }
};

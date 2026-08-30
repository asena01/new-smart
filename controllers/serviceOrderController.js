import mongoose from 'mongoose';
import ServiceOrder from '../models/ServiceOrder.js';
import Booking from '../models/Booking.js';
import Hotel from '../models/Hotel.js';
import Staff from '../models/Staff.js';
import ServiceCatalogItem from '../models/ServiceCatalogItem.js';
import ttlockService from '../services/ttlockService.js';
import { getEligibleRoomLock, resolveGuestEmail, generateContactlessCode, combineDateAndTime, tryIssueContactlessKey } from './bookingController.js';
import { createNotification } from '../utils/notificationUtils.js';
import { sendToUser, sendToHotel } from '../utils/sseHub.js';
import { canManageHotel } from '../utils/staffAuth.js';
import Attendance from '../models/Attendance.js';
import { resolveHotelTimeZone } from '../utils/hotelTime.js';

// Which permission actually governs managing an order (assigning staff to it, confirming/
// advancing its status, updating its payment) depends on its serviceType — restaurant/bar
// oversight is a different real-world job from laundry/transportation coordination, which is
// again different from the front-desk guest-service work behind early-checkin, late-checkout,
// room-upgrade, and custom requests. Used everywhere a host/staff-manage authorization check
// used to hardcode 'canManageOrders' regardless of the order's actual type — which meant a
// chef or bar-attendant (who hold canManageOrders for restaurant/bar oversight) could also
// assign staff to, confirm, or update payment on a guest's early check-in or room upgrade.
// Falls back to canManageOrders for restaurant/bar (and anything not otherwise listed).
const ORDER_MANAGE_PERMISSION = {
  laundry: 'canManageLaundry',
  transportation: 'canManageTransportation',
  'early-checkin': 'canManageGuestServices',
  'late-checkout': 'canManageGuestServices',
  'room-upgrade': 'canManageGuestServices',
  custom: 'canManageGuestServices'
};

function orderManagePermission(serviceType) {
  return ORDER_MANAGE_PERMISSION[serviceType] || 'canManageOrders';
}

// A catalog item's discountPrice, when set and lower than price, is what guests actually pay —
// duplicated from each guest-facing Angular page's identical client-side logic, since the
// server must independently re-derive the same number rather than trust whatever the client sent.
function effectiveCatalogPrice(item) {
  if (item.discountPrice != null && item.discountPrice > 0 && item.discountPrice < item.price) {
    return item.discountPrice;
  }
  return item.price;
}

// Unlike combineDateAndTime (bookingController.js), which is fed a Mongoose Date field
// that's always a full ISO timestamp, `dateStr` here comes straight off a guest's
// <input type="date"> as a bare "YYYY-MM-DD" string — `new Date('YYYY-MM-DD')` parses that
// as UTC midnight, not local midnight, so overlaying hours with .setHours() afterward can
// silently land on the wrong calendar day for any server not running in UTC. Building the
// Date from its numeric Y/M/D/H/M parts instead is always interpreted in local time, with
// no such ambiguity regardless of the server's own timezone.
function combineLocalDateAndTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const [hours, minutes] = String(timeStr).split(':').map(Number);
  if (![year, month, day, hours, minutes].every(Number.isFinite)) return null;
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

function minutesToTimeLabel(mins) {
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const period = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function timeStringToMinutes(time) {
  if (!time) return null;
  const [hours, minutes] = String(time).split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function effectiveRoomPrice(room) {
  if (room.discountPrice != null && room.discountPrice > 0 && room.discountPrice < room.basePrice) {
    return room.discountPrice;
  }
  return room.basePrice;
}

// Recomputes subtotal/tax/total from catalog/room/booking data actually stored in the
// database — the client's own subtotal/tax/total are never trusted, only used as a display
// hint on the guest's screen before this recomputation. Throws a descriptive Error (caught by
// createServiceOrder as a 400) when a referenced catalog item/room can no longer be found,
// which most often means the guest's catalog view was stale (host changed/removed the item).
async function computeAuthoritativePricing(serviceType, serviceDetails, hotelId, booking) {
  switch (serviceType) {
    case 'restaurant':
    case 'bar': {
      const items = Array.isArray(serviceDetails?.items) ? serviceDetails.items : [];
      if (items.length === 0) throw new Error('Order has no items');

      const catalogItems = await ServiceCatalogItem.find({
        _id: { $in: items.map(i => i.itemId).filter(Boolean) },
        hotelId,
        serviceType
      });
      const byId = new Map(catalogItems.map(c => [String(c._id), c]));

      let subtotal = 0;
      const resolvedItems = items.map(i => {
        const catalogItem = byId.get(String(i.itemId));
        if (!catalogItem || !catalogItem.isAvailable) {
          throw new Error(`"${i.name || 'An item'}" is no longer available — please refresh and try again.`);
        }
        const quantity = Math.max(1, Number(i.quantity) || 0);
        const price = effectiveCatalogPrice(catalogItem);
        subtotal += price * quantity;
        return { itemId: i.itemId, name: catalogItem.name, quantity, price, specialRequests: i.specialRequests };
      });

      return { subtotal, tax: 0, total: subtotal, serviceDetails: { ...serviceDetails, items: resolvedItems } };
    }

    case 'laundry': {
      const laundryItems = Array.isArray(serviceDetails?.laundryItems) ? serviceDetails.laundryItems : [];
      const catalogItems = await ServiceCatalogItem.find({ hotelId, serviceType: 'laundry', isAvailable: true });

      let subtotal = 0;
      const resolvedLaundryItems = laundryItems.map(li => {
        const match = catalogItems.find(c => c.category !== 'service-level' && c.name === li.itemType);
        if (!match) throw new Error(`"${li.itemType}" is no longer available — please refresh and try again.`);
        const quantity = Math.max(1, Number(li.quantity) || 0);
        const price = effectiveCatalogPrice(match);
        subtotal += price * quantity;
        return { itemType: li.itemType, quantity, price };
      });

      let serviceFee = 0;
      if (serviceDetails?.serviceLevel) {
        const levelMatch = catalogItems.find(c => c.category === 'service-level' && c.name === serviceDetails.serviceLevel);
        if (!levelMatch) throw new Error(`Service level "${serviceDetails.serviceLevel}" is no longer available — please refresh and try again.`);
        serviceFee = effectiveCatalogPrice(levelMatch);
      }

      const total = subtotal + serviceFee;
      return { subtotal: total, tax: 0, total, serviceDetails: { ...serviceDetails, laundryItems: resolvedLaundryItems } };
    }

    case 'transportation': {
      const match = await ServiceCatalogItem.findOne({ hotelId, serviceType: 'transportation', name: serviceDetails?.serviceOption, isAvailable: true });
      if (!match) throw new Error(`"${serviceDetails?.serviceOption || 'That transport option'}" is no longer available — please refresh and try again.`);

      // The date input alone being >= today isn't enough — a guest can still pick a time
      // earlier today that's already passed. Reject it outright rather than letting
      // computeEstimatedReadyAt silently paper over it with an unrelated "ready in 30
      // minutes" fallback (see below) once the order already exists.
      const pickupMoment = combineLocalDateAndTime(serviceDetails?.pickupDate, serviceDetails?.pickupTime);
      if (!pickupMoment || Number.isNaN(pickupMoment.getTime())) {
        throw new Error('Please choose a valid pickup date and time.');
      }
      if (pickupMoment <= new Date()) {
        throw new Error('Pickup time must be in the future. Please choose a different date or time.');
      }

      const passengers = Math.max(1, Number(serviceDetails?.passengers) || 1);
      if (match.vehicleCapacity && passengers > match.vehicleCapacity) {
        throw new Error(`This vehicle seats up to ${match.vehicleCapacity} passengers.`);
      }
      const luggage = Math.max(0, Number(serviceDetails?.luggage) || 0);

      const basePrice = effectiveCatalogPrice(match);
      const passengerCost = (match.perPassengerFee || 0) * Math.max(0, passengers - 1);
      const luggageCost = (match.perLuggageFee || 0) * luggage;
      const total = basePrice + passengerCost + luggageCost;

      return { subtotal: total, tax: 0, total, serviceDetails: { ...serviceDetails, passengers, luggage } };
    }

    case 'early-checkin':
    case 'late-checkout': {
      // Priced from the hotel's own policy fields, not a catalog item — early check-in
      // uses one fixed fee while late checkout remains hourly. The guest
      // picks an exact time, and "how many hours early/late is that" plus "is that even
      // inside the hotel's allowed window" are both derived server-side from the same
      // policies the settings page validates (see validatePolicyTimes in
      // hotelController.js), so a stale/tampered client value can't buy a cheaper or
      // out-of-window request.
      const hotel = await Hotel.findById(hotelId).select('policies');
      if (!hotel) throw new Error('Hotel not found');
      const policies = hotel.policies || {};

      const isEarlyCheckIn = serviceType === 'early-checkin';
      const rate = isEarlyCheckIn
        ? (policies.earlyCheckInFee || policies.earlyCheckInRatePerHour || 0)
        : (policies.lateCheckOutRatePerHour || 0);
      if (!rate) {
        throw new Error(`${isEarlyCheckIn ? 'Early check-in' : 'Late check-out'} isn't available at this hotel right now.`);
      }

      const requestedMinutes = timeStringToMinutes(serviceDetails?.requestedTime);
      if (requestedMinutes == null) throw new Error('Please choose a valid time.');

      let diffMinutes;
      if (isEarlyCheckIn) {
        const normalMinutes = timeStringToMinutes(policies.checkInTime) ?? timeStringToMinutes('15:00');
        const earliestMinutes = timeStringToMinutes(policies.earlyCheckInFrom) ?? 0;
        if (requestedMinutes < earliestMinutes || requestedMinutes >= normalMinutes) {
          throw new Error(`Early check-in must be requested between ${minutesToTimeLabel(earliestMinutes)} and ${minutesToTimeLabel(normalMinutes)}.`);
        }
        diffMinutes = normalMinutes - requestedMinutes;
      } else {
        const normalMinutes = timeStringToMinutes(policies.checkOutTime) ?? timeStringToMinutes('11:00');
        const latestMinutes = timeStringToMinutes(policies.lateCheckOutUntil) ?? (24 * 60 - 1);
        if (requestedMinutes <= normalMinutes || requestedMinutes > latestMinutes) {
          throw new Error(`Late check-out must be requested between ${minutesToTimeLabel(normalMinutes)} and ${minutesToTimeLabel(latestMinutes)}.`);
        }
        diffMinutes = requestedMinutes - normalMinutes;
      }

      const hours = Math.ceil(diffMinutes / 60);
      const total = isEarlyCheckIn ? rate : hours * rate;
      return {
        subtotal: total,
        tax: 0,
        total,
        serviceDetails: isEarlyCheckIn
          ? { ...serviceDetails, requestedTime: serviceDetails.requestedTime, hours, fixedPrice: rate }
          : { ...serviceDetails, requestedTime: serviceDetails.requestedTime, hours, ratePerHour: rate }
      };
    }

    case 'room-upgrade': {
      const hotel = await Hotel.findById(hotelId);
      if (!hotel) throw new Error('Hotel not found');

      const currentRoom = hotel.rooms.find(r => r.roomNumber === booking.roomId);
      const newRoom = hotel.rooms.find(r => r.roomNumber === serviceDetails?.newRoomNumber);
      if (!currentRoom || !newRoom) throw new Error('One of the rooms in this upgrade is no longer available.');

      const currentRoomPrice = effectiveRoomPrice(currentRoom);
      const newRoomPrice = effectiveRoomPrice(newRoom);
      const nights = Math.max(1, Math.round((new Date(booking.checkOutDate) - new Date(booking.checkInDate)) / 86400000));
      const total = (newRoomPrice - currentRoomPrice) * nights;

      return {
        subtotal: total,
        tax: 0,
        total,
        serviceDetails: { ...serviceDetails, currentRoomPrice, newRoomPrice, nights }
      };
    }

    case 'custom': {
      const match = await ServiceCatalogItem.findOne({ _id: serviceDetails?.customServiceId, hotelId, serviceType: 'custom', isAvailable: true });
      if (!match) throw new Error('That service is no longer available — please refresh and try again.');

      const price = effectiveCatalogPrice(match);
      const total = match.requiresScheduling
        ? price * Math.max(1, Number(serviceDetails?.durationHours) || 1)
        : price * Math.max(1, Number(serviceDetails?.quantity) || 1);

      return { subtotal: total, tax: 0, total, serviceDetails: { ...serviceDetails, requiresScheduling: match.requiresScheduling } };
    }

    default:
      throw new Error(`Unknown service type: ${serviceType}`);
  }
}

const SERVICE_LABELS = {
  'restaurant': 'Restaurant',
  'bar': 'Bar',
  'laundry': 'Laundry',
  'transportation': 'Transportation',
  'early-checkin': 'Early check-in',
  'late-checkout': 'Late check-out',
  'room-upgrade': 'Room upgrade',
  'custom': 'Additional service'
};

// Custom services are host-named, so prefer the specific name the guest booked
// (e.g. "Conference Room Rental") over the generic 'Additional service' fallback.
function serviceLabelFor(order) {
  if (order.serviceType === 'custom' && order.serviceDetails?.customServiceName) {
    return order.serviceDetails.customServiceName;
  }
  return SERVICE_LABELS[order.serviceType] || order.serviceType;
}

const STATUS_LABELS = {
  'pending': 'received',
  'confirmed': 'confirmed',
  'preparing': 'being prepared',
  'in-progress': 'in progress',
  'ready': 'ready',
  'on-the-way': 'on the way',
  'completed': 'completed',
  'delivered': 'delivered',
  'cancelled': 'cancelled'
};

// How long each service type typically takes to fulfill, used to compute
// estimatedReadyAt for the guest-facing countdown widget. Laundry has its own
// dedicated two-tier calculation below instead of a flat minutes offset.
const DEFAULT_MINUTES_BY_TYPE = {
  'restaurant': 30,
  'bar': 15,
  'transportation': 30,
  'early-checkin': 60,
  'late-checkout': 60,
  'room-upgrade': 45
};

// Laundry only ever has two functional tiers — Standard and Express — matched by a
// case-insensitive substring on whatever display name the host gave their
// "service-level" catalog item, since the catalog has no fixed enum and hosts can
// name/price these however they like (e.g. "Express Service", "Rush Express").
function isExpressLaundry(serviceLevel) {
  return /express/i.test(serviceLevel || '');
}

// Standard: ready by noon the next day. Express: same day — targeting 4 hours out, but
// capped at 11pm the same day so "same day" always holds even for a late-placed order.
function computeLaundryReadyAt(serviceLevel, from) {
  if (isExpressLaundry(serviceLevel)) {
    const fourHoursOut = new Date(from.getTime() + 4 * 60 * 60 * 1000);
    const sameDayCap = new Date(from);
    sameDayCap.setHours(23, 0, 0, 0);
    return fourHoursOut < sameDayCap ? fourHoursOut : sameDayCap;
  }

  const nextDayNoon = new Date(from);
  nextDayNoon.setDate(nextDayNoon.getDate() + 1);
  nextDayNoon.setHours(12, 0, 0, 0);
  return nextDayNoon;
}

// Guest laundry pickup is scheduled loosely ("within about an hour") rather than
// picking a specific time slot — this is the window a host commits to for collecting
// the dirty laundry from the room.
const LAUNDRY_PICKUP_WINDOW_MINUTES = 60;
function computeLaundryPickupAt(from) {
  return new Date(from.getTime() + LAUNDRY_PICKUP_WINDOW_MINUTES * 60 * 1000);
}

function computeEstimatedReadyAt(serviceType, serviceDetails, from = new Date()) {
  if (serviceType === 'transportation' && serviceDetails?.pickupDate) {
    const pickup = combineLocalDateAndTime(serviceDetails.pickupDate, serviceDetails.pickupTime || '00:00');
    if (pickup && !Number.isNaN(pickup.getTime()) && pickup > from) {
      return pickup;
    }
  }

  if (serviceType === 'laundry') {
    return computeLaundryReadyAt(serviceDetails?.serviceLevel, from);
  }

  if (serviceType === 'custom' && serviceDetails?.scheduledDate) {
    const scheduled = new Date(serviceDetails.scheduledDate);
    if (serviceDetails.scheduledTime) {
      const [hours, minutes] = String(serviceDetails.scheduledTime).split(':').map(Number);
      if (!Number.isNaN(hours)) {
        scheduled.setHours(hours, minutes || 0, 0, 0);
      }
    }
    if (!Number.isNaN(scheduled.getTime()) && scheduled > from) {
      return scheduled;
    }
  }

  const minutes = DEFAULT_MINUTES_BY_TYPE[serviceType] || 30;
  return new Date(from.getTime() + minutes * 60 * 1000);
}

// Create a new service order
export const createServiceOrder = async (req, res) => {
  try {
    const {
      bookingId,
      hotelId,
      guestId,
      serviceType,
      serviceDetails,
      specialRequests,
      paymentMethod
    } = req.body;

    // Validate booking exists
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Confirmed just means the reservation/payment went through — hotel services are
    // only orderable once the guest has actually checked in (front-desk or contactless).
    // Early check-in is the one exception: it's a fixed-fee paid service (pay to have
    // gotten in before the hotel's standard check-in time), so it's requestable both before
    // actualCheckInTime is set (the common case) and after (to formalize/pay for early hours
    // already used via the free check-in window) — see canRequestEarlyCheckIn in
    // bookingController.js for the cutoff that still applies either way.
    if (serviceType !== 'early-checkin' && !booking.checkInInfo?.actualCheckInTime) {
      return res.status(403).json({ error: 'Please check in before ordering hotel services.' });
    }

    // actualCheckInTime never gets cleared on checkout, so it alone can't tell an active
    // stay apart from one that's already ended — check checkout state separately.
    if (booking.checkOutInfo?.actualCheckOutTime || booking.status === 'completed') {
      return res.status(403).json({ error: 'This stay has already been checked out — hotel services are no longer available.' });
    }

    // Validate hotel exists
    const hotel = await Hotel.findById(hotelId);
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    // Early check-in / late check-out are one-time-per-stay requests, not a repeatable cart
    // order — without this, a double-tap or a flaky network retry creates two separate
    // billed orders for the exact same request ("double charging").
    if (serviceType === 'early-checkin' || serviceType === 'late-checkout') {
      const duplicate = await ServiceOrder.findOne({ bookingId, serviceType, status: { $ne: 'cancelled' } });
      if (duplicate) {
        return res.status(409).json({ error: `You've already requested ${serviceType === 'early-checkin' ? 'early check-in' : 'late check-out'} for this stay.` });
      }
    }

    let pricing;
    try {
      pricing = await computeAuthoritativePricing(serviceType, serviceDetails, hotelId, booking);
    } catch (pricingError) {
      return res.status(400).json({ error: pricingError.message });
    }

    const serviceOrder = new ServiceOrder({
      bookingId,
      hotelId,
      guestId,
      serviceType,
      serviceDetails: pricing.serviceDetails,
      subtotal: pricing.subtotal,
      tax: pricing.tax,
      total: pricing.total,
      specialRequests,
      paymentMethod,
      estimatedReadyAt: computeEstimatedReadyAt(serviceType, pricing.serviceDetails),
      estimatedPickupAt: serviceType === 'laundry' ? computeLaundryPickupAt(new Date()) : undefined
    });

    await serviceOrder.save();

    const serviceLabel = SERVICE_LABELS[serviceType] || serviceType;
    await createNotification({
      userId: guestId,
      type: 'order',
      title: 'Order Placed',
      message: `Your ${serviceLabel.toLowerCase()} order has been placed.`,
      link: '/my-orders',
      actionLabel: 'View Order'
    });

    await createNotification({
      userId: hotel.hostId,
      type: 'order',
      title: 'New Order',
      message: `A new ${serviceLabel.toLowerCase()} order has been placed at ${hotel.name}.`,
      link: `/host/${serviceType}-orders`,
      actionLabel: 'View Order'
    });

    sendToHotel(hotelId, 'order-created', { serviceType, orderId: serviceOrder._id });
    sendToUser(guestId, 'order-created', { serviceType, orderId: serviceOrder._id });

    // Kitchen/bar claim queue: let clocked-in prep staff know a new order needs picking up,
    // same fan-out pattern as the 'ready' notification for delivery staff.
    if (['restaurant', 'bar'].includes(serviceType)) {
      const eligibleStaff = await Staff.find({ hotelId, status: 'active', 'permissions.canPrepareOrders': true });
      if (eligibleStaff.length) {
        const clockedIn = await Attendance.find({ staffId: { $in: eligibleStaff.map(s => s._id) }, clockOutTime: null });
        const clockedInIds = new Set(clockedIn.map(a => String(a.staffId)));
        const toNotify = eligibleStaff.filter(s => clockedInIds.has(String(s._id)));
        for (const s of toNotify) {
          await createNotification({
            userId: s.userId,
            type: 'order',
            title: 'New Order to Prepare',
            message: `A new ${serviceLabel.toLowerCase()} order is ready to claim.`,
            link: '/staff/kitchen-queue',
            actionLabel: 'View Queue'
          });
        }
      }
    }

    res.status(201).json({
      message: 'Service order created successfully',
      order: serviceOrder,
      hotelPaymentSubaccountId: hotel.flutterwaveSubaccountId
    });
  } catch (error) {
    console.error('Error creating service order:', error);
    res.status(500).json({ error: 'Failed to create service order' });
  }
};

// Get all service orders for a guest
export const getGuestServiceOrders = async (req, res) => {
  try {
    const { guestId } = req.params;

    if (guestId !== req.user.userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to view these orders' });
    }

    const orders = await ServiceOrder.find({ guestId })
      .populate('hotelId', 'name')
      .sort({ createdAt: -1 });

    res.json(orders);
  } catch (error) {
    console.error('Error fetching guest orders:', error);
    res.status(500).json({ error: 'Failed to fetch service orders' });
  }
};

// Get service orders for a hotel
export const getHotelServiceOrders = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { serviceType, status, staffId } = req.query;

    if (req.user.role !== 'admin') {
      const hotel = await Hotel.findOne({ _id: hotelId, hostId: req.user.userId });
      if (!hotel) {
        // Not the host — allow an active staff member to view orders at their own hotel
        // (e.g. the delivery queue's "my deliveries" list, filtered by their own staffId).
        const staff = await Staff.findOne({ userId: req.user.userId, hotelId, status: 'active' });
        if (!staff) {
          return res.status(404).json({ error: 'Hotel not found' });
        }
      }
    }

    let filter = { hotelId };
    if (serviceType) filter.serviceType = serviceType;
    if (status) filter.status = status;
    if (staffId) filter.staffId = staffId;

    const orders = await ServiceOrder.find(filter)
      .populate('guestId', 'firstName lastName')
      .populate('bookingId', 'roomId')
      .populate('staffId', 'firstName lastName position')
      .sort({ createdAt: -1 });

    res.json(orders);
  } catch (error) {
    console.error('Error fetching hotel orders:', error);
    res.status(500).json({ error: 'Failed to fetch service orders' });
  }
};

// Get a specific service order
export const getServiceOrder = async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await ServiceOrder.findById(orderId)
      .populate('hotelId', 'name')
      .populate('guestId', 'firstName lastName email')
      .populate('bookingId', 'roomId');

    if (!order) {
      return res.status(404).json({ error: 'Service order not found' });
    }

    res.json(order);
  } catch (error) {
    console.error('Error fetching service order:', error);
    res.status(500).json({ error: 'Failed to fetch service order' });
  }
};

// A room-upgrade ServiceOrder is otherwise purely cosmetic (free-text serviceDetails
// strings) — this is the one place a host marks the process done, so it's the only
// correct point to actually move the guest: reassign Booking.roomId to the new room,
// flip both rooms' status/housekeeping so the host's room list reflects the swap
// immediately, and carry over smart-lock access — revoking the old room's TTLock
// code/eKey (same as a checkout, since the guest no longer occupies it) and issuing a
// fresh one for the new room (same as a check-in) so the guest isn't left holding a key
// to the wrong door.
async function finalizeRoomUpgrade(order) {
  const newRoomNumber = order.serviceDetails?.newRoomNumber;
  if (!newRoomNumber) return;

  const booking = await Booking.findById(order.bookingId).populate('userId', 'email firstName lastName');
  if (!booking) return;
  const oldRoomNumber = booking.roomId;

  const hotel = await Hotel.findById(order.hotelId);
  if (!hotel) return;

  const oldRoom = hotel.rooms.find(r => r.roomNumber === oldRoomNumber);
  const newRoom = hotel.rooms.find(r => r.roomNumber === newRoomNumber);

  if (booking.contactlessCheckIn?.enabled && oldRoom?.smartLockIntegration?.deviceId) {
    const deviceId = oldRoom.smartLockIntegration.deviceId;
    if (booking.contactlessCheckIn.keyboardPwdId) {
      try {
        await ttlockService.deleteKeyboardPwd(deviceId, booking.contactlessCheckIn.keyboardPwdId);
      } catch (revokeError) {
        console.error('Error revoking TTLock passcode on room upgrade (non-fatal):', revokeError.message);
      }
    }
    if (booking.contactlessCheckIn.ekeyId) {
      try {
        await ttlockService.revokeEkey(deviceId, booking.contactlessCheckIn.ekeyId);
      } catch (revokeError) {
        console.error('Error revoking TTLock eKey on room upgrade (non-fatal):', revokeError.message);
      }
    }
    booking.contactlessCheckIn.enabled = false;
  }

  // Occupancy is derived from the booking's own check-in state (see attachRoomOccupancy in
  // hotelController.js), not stored on the room — so the new room needs no status write here;
  // it'll correctly show as occupied the moment booking.roomId below points at it. `status`
  // itself is purely the host's sellability intent (available/out-of-order/out-of-service),
  // which an upgrade doesn't change for either room.
  if (oldRoom) {
    oldRoom.housekeepingStatus = 'dirty';
  }
  await hotel.save();

  booking.roomId = newRoomNumber;

  const eligible = getEligibleRoomLock(hotel, newRoomNumber);
  if (eligible) {
    try {
      await generateContactlessCode(booking, eligible.smartLock, resolveGuestEmail(booking));
    } catch (lockError) {
      console.error('Error issuing TTLock code for upgraded room (non-fatal):', lockError.message);
    }
  }

  await booking.save();
}

const ROOM_READY_STATUSES = ['clean', 'inspected'];

// Revokes whatever TTLock passcode/eKey is currently active for a booking, ahead of issuing
// a fresh one for a different room or a different validity window.
async function revokeContactlessCode(booking, room) {
  if (!booking.contactlessCheckIn?.enabled || !room?.smartLockIntegration?.deviceId) return;
  const deviceId = room.smartLockIntegration.deviceId;
  if (booking.contactlessCheckIn.keyboardPwdId) {
    try {
      await ttlockService.deleteKeyboardPwd(deviceId, booking.contactlessCheckIn.keyboardPwdId);
    } catch (revokeError) {
      console.error('Error revoking TTLock passcode (non-fatal):', revokeError.message);
    }
  }
  if (booking.contactlessCheckIn.ekeyId) {
    try {
      await ttlockService.revokeEkey(deviceId, booking.contactlessCheckIn.ekeyId);
    } catch (revokeError) {
      console.error('Error revoking TTLock eKey (non-fatal):', revokeError.message);
    }
  }
}

// A confirmed early-checkin order moves the guest's effective key-window start earlier than
// the hotel's standard check-in time — but tryIssueContactlessKey only actually activates it
// once BOTH the room is ready AND the guest's identity has been verified; otherwise it's left
// pending and picked up later by whichever of those two clears second (the housekeeping-status
// hook in hotelController.js, or verification completing in getVerificationStatus).
// Throws (rather than silently returning) when data this order actually needs to extend the
// guest's key window is missing — updateServiceOrderStatus only commits status: 'confirmed'
// once this resolves without throwing, so the order can never end up marked confirmed while
// the window itself was never touched. Never throws for a TTLock/hotel-lookup failure though
// (see the try/catch below) — approvedEarlyCheckInTime, the actual deliverable, is already set
// on the booking by that point regardless of whether the physical key could be reissued.
async function finalizeEarlyCheckIn(order) {
  const requestedTime = order.serviceDetails?.requestedTime;
  if (!requestedTime) {
    throw new Error('This order has no requested check-in time on record and cannot be confirmed.');
  }

  const booking = await Booking.findById(order.bookingId).populate('userId', 'email firstName lastName');
  if (!booking) {
    throw new Error('The booking for this order could not be found.');
  }

  const hotel = await Hotel.findById(order.hotelId);
  booking.checkInInfo.approvedEarlyCheckInTime = combineDateAndTime(
    booking.checkInDate,
    requestedTime,
    resolveHotelTimeZone(hotel)
  );
  if (hotel) {
    const room = hotel.rooms.find(r => r.roomNumber === booking.roomId);
    await revokeContactlessCode(booking, room);
    try {
      await tryIssueContactlessKey(booking, hotel, resolveGuestEmail(booking));
    } catch (lockError) {
      console.error('Error issuing early TTLock window (non-fatal):', lockError.message);
    }
  }

  await booking.save();
}

// A confirmed late-checkout order extends the guest's effective key-window end past the
// hotel's standard checkout time, so the key (and the auto-checkout scheduler) both honor it.
// Same explicit-failure contract as finalizeEarlyCheckIn above.
async function finalizeLateCheckOut(order) {
  const requestedTime = order.serviceDetails?.requestedTime;
  if (!requestedTime) {
    throw new Error('This order has no requested check-out time on record and cannot be confirmed.');
  }

  const booking = await Booking.findById(order.bookingId).populate('userId', 'email firstName lastName');
  if (!booking) {
    throw new Error('The booking for this order could not be found.');
  }

  const hotel = await Hotel.findById(order.hotelId);
  const approvedTime = combineDateAndTime(
    booking.checkOutDate,
    requestedTime,
    resolveHotelTimeZone(hotel)
  );
  booking.checkOutInfo.approvedLateCheckOutTime = approvedTime;

  // Only reissue the live key if one is already active — if the room isn't ready yet, the
  // early-checkin path (or a future check-in) will pick up this approved end time itself.
  if (booking.contactlessCheckIn?.enabled) {
    const room = hotel?.rooms?.find(r => r.roomNumber === booking.roomId);
    const eligible = getEligibleRoomLock(hotel, booking.roomId);
    if (eligible) {
      await revokeContactlessCode(booking, room);
      try {
        await generateContactlessCode(booking, eligible.smartLock, resolveGuestEmail(booking), {
          startDate: booking.checkInInfo?.approvedEarlyCheckInTime || undefined,
          endDate: approvedTime
        });
      } catch (lockError) {
        console.error('Error extending TTLock window for late checkout (non-fatal):', lockError.message);
      }
    }
  }

  await booking.save();
}

// Update service order status
export const updateServiceOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    const existingOrder = await ServiceOrder.findById(orderId);
    if (!existingOrder) {
      return res.status(404).json({ error: 'Service order not found' });
    }

    if (req.user.role !== 'admin') {
      // Requiring active status here means a terminated staff member's still-valid token
      // can no longer touch an order just because it was assigned to them before termination.
      const isAssignedStaff = existingOrder.staffId &&
        !!(await Staff.findOne({ _id: existingOrder.staffId, userId: req.user.userId, status: 'active' }));
      if (!isAssignedStaff && !(await canManageHotel(req, existingOrder.hotelId, orderManagePermission(existingOrder.serviceType)))) {
        return res.status(403).json({ error: 'Not authorized to update this order' });
      }
    }

    if (status !== 'pending' && !existingOrder.staffId) {
      return res.status(400).json({ error: 'Assign a staff member to this order before updating its status.' });
    }

    // 'pending' (no staff assigned yet) is the one universal "not started" state shared by
    // every service type — the guard above already treats it that way for staff assignment.
    // Once an order moves past it — whatever type-specific status label that is — real work
    // is underway, so cancelling from there would erase an already-in-motion transaction.
    if (status === 'cancelled' && req.user.role !== 'admin' && existingOrder.status !== 'pending') {
      return res.status(400).json({ error: `This order is already ${existingOrder.status} and can no longer be cancelled.` });
    }

    // A retried/duplicate request setting the status to what it already is is a no-op, not an
    // error — treat it as already-succeeded rather than rejecting it as an invalid transition
    // or silently re-running notifications/side effects a second time.
    if (status === existingOrder.status) {
      return res.json({ message: 'Service order status unchanged', order: existingOrder });
    }

    // Food orders move through a strict, ordered pipeline once real work begins — allowing a
    // skip (e.g. straight from 'ready' to 'delivered', bypassing the waiter's "on the way"
    // leg) would leave staff, the guest, and the audit trail looking at an inconsistent,
    // out-of-sequence history. Only restaurant/bar orders are constrained this way; other
    // service types keep their existing, more flexible status handling. Admins can still
    // force any transition (e.g. correcting a mistake), same as the cancellation override above.
    const RESTAURANT_BAR_NEXT_STATUS = {
      pending: ['confirmed'],
      confirmed: ['preparing'],
      preparing: ['ready'],
      ready: ['on-the-way'],
      'on-the-way': ['delivered']
    };
    if (
      status !== 'cancelled' &&
      req.user.role !== 'admin' &&
      ['restaurant', 'bar'].includes(existingOrder.serviceType)
    ) {
      const allowedNext = RESTAURANT_BAR_NEXT_STATUS[existingOrder.status] || [];
      if (!allowedNext.includes(status)) {
        return res.status(400).json({
          error: allowedNext.length
            ? `Cannot move this order from ${existingOrder.status} to ${status} — only ${allowedNext.join(' or ')} is allowed from here.`
            : `This order is ${existingOrder.status} and cannot be moved to any other status.`
        });
      }
    }

    // Restaurant/bar prep and delivery are claimed by different people (kitchen vs. waiter)
    // — the staffId set by whoever claimed/prepared it must not block a waiter from claiming
    // it for delivery once it's ready, so it re-opens to the delivery claim queue here. Other
    // service types keep one staffId across their whole lifecycle, as before.
    const reopenForDelivery = ['restaurant', 'bar'].includes(existingOrder.serviceType) &&
      status === 'ready' && existingOrder.status !== 'ready';

    // Run BEFORE the status write commits, not after — these two finalize steps are what
    // actually extends the guest's key window, and an order must never end up marked
    // 'confirmed' in the database when that never happened (e.g. the order's own requested
    // time or its booking record is missing). Reads existingOrder rather than the
    // not-yet-updated `order` below since neither function depends on the order's own status.
    if (existingOrder.serviceType === 'early-checkin' && status === 'confirmed' && existingOrder.status !== 'confirmed') {
      try {
        await finalizeEarlyCheckIn(existingOrder);
      } catch (finalizeError) {
        return res.status(422).json({ error: `Could not confirm this order: ${finalizeError.message}` });
      }
    }

    if (existingOrder.serviceType === 'late-checkout' && status === 'confirmed' && existingOrder.status !== 'confirmed') {
      try {
        await finalizeLateCheckOut(existingOrder);
      } catch (finalizeError) {
        return res.status(422).json({ error: `Could not confirm this order: ${finalizeError.message}` });
      }
    }

    const order = await ServiceOrder.findByIdAndUpdate(
      orderId,
      {
        $set: {
          status,
          completedAt: status === 'completed' || status === 'delivered' ? Date.now() : undefined,
          ...(status === 'delivered' ? { deliveredBy: existingOrder.staffId } : {}),
          ...(reopenForDelivery ? { staffId: null } : {})
        },
        $push: { statusHistory: { status, changedBy: req.user.userId, changedByRole: req.user.role, at: new Date() } }
      },
      { new: true }
    );

    if (order.serviceType === 'room-upgrade' && status === 'completed' && existingOrder.status !== 'completed') {
      await finalizeRoomUpgrade(order);
    }

    const serviceLabel = SERVICE_LABELS[order.serviceType] || order.serviceType;
    const statusLabel = STATUS_LABELS[status] || status;
    await createNotification({
      userId: order.guestId,
      type: 'order',
      title: 'Order Update',
      message: `Your ${serviceLabel.toLowerCase()} order is now ${statusLabel}.`,
      link: '/my-orders',
      actionLabel: 'View Order'
    });

    sendToHotel(order.hotelId, 'order-updated', { serviceType: order.serviceType, orderId: order._id, status: order.status });
    sendToUser(order.guestId, 'order-updated', { serviceType: order.serviceType, orderId: order._id, status: order.status });

    // Fan out to whoever can currently claim this: eligible staff (canDeliverOrders) who
    // are clocked in right now. Guarded on the transition itself so re-saving 'ready'
    // (or a caller retrying) doesn't spam repeat notifications.
    if (status === 'ready' && existingOrder.status !== 'ready' && !order.staffId) {
      const eligibleStaff = await Staff.find({ hotelId: order.hotelId, status: 'active', 'permissions.canDeliverOrders': true });
      if (eligibleStaff.length) {
        const clockedIn = await Attendance.find({ staffId: { $in: eligibleStaff.map(s => s._id) }, clockOutTime: null });
        const clockedInIds = new Set(clockedIn.map(a => String(a.staffId)));
        const toNotify = eligibleStaff.filter(s => clockedInIds.has(String(s._id)));
        for (const s of toNotify) {
          await createNotification({
            userId: s.userId,
            type: 'order',
            title: 'Order Ready for Delivery',
            message: `A ${serviceLabel.toLowerCase()} order is ready to claim.`,
            link: '/staff/delivery-queue',
            actionLabel: 'View Queue'
          });
        }
      }
    }

    res.json({
      message: 'Service order status updated',
      order
    });
  } catch (error) {
    console.error('Error updating service order:', error);
    res.status(500).json({ error: 'Failed to update service order' });
  }
};

// Assign the staff member responsible for fulfilling this order. Must happen
// before the order's status can move past 'pending' (see updateServiceOrderStatus).
export const assignStaffToOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { staffId } = req.body;

    const existingOrder = await ServiceOrder.findById(orderId);
    if (!existingOrder) {
      return res.status(404).json({ error: 'Service order not found' });
    }

    if (!(await canManageHotel(req, existingOrder.hotelId, orderManagePermission(existingOrder.serviceType)))) {
      return res.status(403).json({ error: 'Not authorized to assign staff to this order' });
    }

    const staff = await Staff.findOne({ _id: staffId, hotelId: existingOrder.hotelId, status: 'active' });
    if (!staff) {
      return res.status(404).json({ error: 'Active staff member not found for this hotel' });
    }

    const order = await ServiceOrder.findByIdAndUpdate(
      orderId,
      { staffId },
      { new: true }
    ).populate('staffId', 'firstName lastName position');

    const serviceLabel = SERVICE_LABELS[order.serviceType] || order.serviceType;
    await createNotification({
      userId: staff.userId,
      type: 'order',
      title: 'Order Assigned To You',
      message: `You've been assigned a ${serviceLabel.toLowerCase()} order to fulfill.`,
      link: `/host/${order.serviceType}-orders`,
      actionLabel: 'View Order'
    });

    res.json({
      message: 'Staff member assigned to order',
      order
    });
  } catch (error) {
    console.error('Error assigning staff to order:', error);
    res.status(500).json({ error: 'Failed to assign staff to order' });
  }
};

// Self-service claim: any active staff member with the right permission can claim an
// unassigned order at the right stage, without a manager assigning it. Keyed by serviceType
// first — 'pending' means something different (and needs a different permission) depending
// on the type: restaurant prep (canPrepareOrders — kitchen cooking a ticket) is a distinct
// permission from bar prep (canPrepareBarOrders), so a chef can't claim bar tickets and a
// bar-attendant can't claim kitchen ones, even though both land on the same claim queue;
// delivery (canDeliverOrders — a waiter bringing it up, claimed once the order reaches
// 'ready') isn't split the same way, since delivery isn't kitchen-vs-bar specific. Laundry
// has no such split either — one staff member (housekeeping) owns the order from pickup
// through completion, gated on canManageLaundry. Transportation claims on canClaimTransportation
// instead of canManageTransportation — the latter is the front-desk/host "coordinate and
// assign" permission (receptionist holds it), which is a different job from personally
// claiming a trip and going to drive it (see staffPermissions.js for the full rationale).
// Either way this is the same atomic compare-and-swap: findOneAndUpdate's filter+update runs
// as one Mongo operation, so a second concurrent claim's filter no longer matches (staffId is
// no longer null) and it gets a 409 instead of silently overwriting the first claim.
const CLAIMABLE_STAGES = {
  restaurant: { pending: 'canPrepareOrders', ready: 'canDeliverOrders' },
  bar: { pending: 'canPrepareBarOrders', ready: 'canDeliverOrders' },
  laundry: { pending: 'canManageLaundry' },
  transportation: { pending: 'canClaimTransportation' },
  'early-checkin': { pending: 'canManageGuestServices' },
  'late-checkout': { pending: 'canManageGuestServices' }
};

export const claimServiceOrder = async (req, res) => {
  try {
    const { orderId } = req.params;

    const existingOrder = await ServiceOrder.findById(orderId);
    if (!existingOrder) {
      return res.status(404).json({ error: 'Service order not found' });
    }
    const permissionKey = CLAIMABLE_STAGES[existingOrder.serviceType]?.[existingOrder.status];
    if (!permissionKey) {
      return res.status(400).json({ error: 'This order is not currently claimable' });
    }

    const staff = await Staff.findOne({ userId: req.user.userId, hotelId: existingOrder.hotelId, status: 'active' });
    if (!staff) {
      return res.status(403).json({ error: 'Not an active staff member at this hotel' });
    }
    if (!staff.permissions?.[permissionKey]) {
      return res.status(403).json({ error: 'Not permitted to claim this order' });
    }

    // Claiming a *pending* restaurant/bar order is the kitchen accepting it — advance straight
    // to 'confirmed' here rather than leaving it at 'pending'. Without this, the order was left
    // exactly where the strict RESTAURANT_BAR_NEXT_STATUS pipeline in updateServiceOrderStatus
    // only allows pending -> confirmed, so the chef's very next action ("Start Preparing",
    // which requests 'preparing') was always rejected as an invalid pending -> preparing jump.
    // Delivery claims (status 'ready', a waiter picking it up) are untouched — claiming for
    // delivery doesn't mean the order has moved past 'ready' yet.
    const advanceToConfirmed = existingOrder.status === 'pending' && ['restaurant', 'bar'].includes(existingOrder.serviceType);

    const order = await ServiceOrder.findOneAndUpdate(
      { _id: orderId, staffId: null, status: existingOrder.status },
      { staffId: staff._id, ...(advanceToConfirmed ? { status: 'confirmed' } : {}) },
      { new: true }
    ).populate('staffId', 'firstName lastName position');

    if (!order) {
      return res.status(409).json({ error: 'This order was already claimed by someone else' });
    }

    sendToHotel(order.hotelId, 'order-updated', { serviceType: order.serviceType, orderId: order._id, status: order.status, staffId: order.staffId?._id });

    res.json({ message: 'Order claimed', order });
  } catch (error) {
    console.error('Error claiming service order:', error);
    res.status(500).json({ error: 'Failed to claim order' });
  }
};

// One entry per staff-facing claim queue — each maps to the (serviceType, status) pair that
// queue page shows as "available to claim". 'delivery' is the default (no ?stage=) to
// preserve the original behavior from before this table existed. Kitchen and bar prep are
// separate stages (not one shared 'prep') so each has its own dedicated queue page — a chef
// only ever queries 'kitchen-prep' and a bar-attendant only 'bar-prep', instead of both
// landing on one page that has to sort tickets apart client-side.
const CLAIM_QUEUE_STAGES = {
  'kitchen-prep': { status: 'pending', serviceTypes: ['restaurant'] },
  'bar-prep': { status: 'pending', serviceTypes: ['bar'] },
  delivery: { status: 'ready', serviceTypes: ['restaurant', 'bar'] },
  laundry: { status: 'pending', serviceTypes: ['laundry'] },
  transportation: { status: 'pending', serviceTypes: ['transportation'] },
  'guest-services': { status: 'pending', serviceTypes: ['early-checkin', 'late-checkout'] }
};

// Unassigned orders at the right stage any eligible active staff member at the hotel can claim
// — plus, for a non-admin, any order already pre-assigned to them specifically. Without that
// second half, a host manually assigning a staff member to a still-'pending' order (the
// "Reassign" dropdown on hotel-restaurant-orders.ts etc — legitimate before status can move
// past 'pending', see assignStaffToOrder) silently vanished it from every self-serve queue,
// including the one belonging to the very staffer it was assigned to: staffId: null excluded
// it from "New Orders" for everyone, and it only ever showed up in that staffer's separate
// "My Orders" list if they knew to look there instead.
export const getClaimableOrders = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const stage = CLAIM_QUEUE_STAGES[req.query.stage] || CLAIM_QUEUE_STAGES.delivery;

    const staff = await Staff.findOne({ userId: req.user.userId, hotelId, status: 'active' });
    if (req.user.role !== 'admin' && !staff) {
      return res.status(403).json({ error: 'Not an active staff member at this hotel' });
    }

    // A stage can cover more than one serviceType (delivery spans restaurant+bar), but which
    // of those a given staff member is actually eligible to claim depends on their own
    // permissions — a chef (canPrepareOrders, not canPrepareBarOrders) should never see bar
    // tickets, even on a stage that spans both. Narrow the list to only the types
    // CLAIMABLE_STAGES would actually let this staff member claim, rather than showing
    // everyone every type in the stage regardless of eligibility. Admins see every type,
    // matching claimServiceOrder's own admin bypass.
    const eligibleServiceTypes = req.user.role === 'admin'
      ? stage.serviceTypes
      : stage.serviceTypes.filter(type => {
          const permissionKey = CLAIMABLE_STAGES[type]?.[stage.status];
          return permissionKey && !!staff.permissions?.[permissionKey];
        });

    const filter = {
      hotelId,
      status: stage.status,
      serviceType: { $in: eligibleServiceTypes },
      ...(req.user.role === 'admin' ? { staffId: null } : { $or: [{ staffId: null }, { staffId: staff._id }] })
    };

    const orders = await ServiceOrder.find(filter)
      .populate('guestId', 'firstName lastName')
      .populate('bookingId', 'roomId')
      .sort({ updatedAt: 1 });

    res.json(orders);
  } catch (error) {
    console.error('Error fetching claimable orders:', error);
    res.status(500).json({ error: 'Failed to fetch claimable orders' });
  }
};

// Update payment status
export const updatePaymentStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { paymentStatus, paymentMethod } = req.body;

    const existingOrder = await ServiceOrder.findById(orderId);
    if (!existingOrder) {
      return res.status(404).json({ error: 'Service order not found' });
    }

    if (!(await canManageHotel(req, existingOrder.hotelId, orderManagePermission(existingOrder.serviceType)))) {
      return res.status(403).json({ error: 'Not authorized to update payment for this order' });
    }

    const order = await ServiceOrder.findByIdAndUpdate(
      orderId,
      {
        paymentStatus,
        paymentMethod,
        paidAt: paymentStatus === 'completed' ? Date.now() : undefined
      },
      { new: true }
    );

    res.json({
      message: 'Payment status updated',
      order
    });
  } catch (error) {
    console.error('Error updating payment:', error);
    res.status(500).json({ error: 'Failed to update payment' });
  }
};

// Get service statistics for hotel
export const getServiceStats = async (req, res) => {
  try {
    const { hotelId } = req.params;

    const hotel = await Hotel.findOne({ _id: hotelId, hostId: req.user.userId });
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    // Total revenue by service type
    const stats = await ServiceOrder.aggregate([
      { $match: { hotelId: new mongoose.Types.ObjectId(hotelId) } },
      { $group: {
        _id: '$serviceType',
        totalRevenue: { $sum: '$total' },
        orderCount: { $sum: 1 },
        avgOrderValue: { $avg: '$total' }
      }},
      { $sort: { totalRevenue: -1 }}
    ]);

    // Overall stats
    const totalOrders = await ServiceOrder.countDocuments({ hotelId });
    const totalRevenue = await ServiceOrder.aggregate([
      { $match: { hotelId: new mongoose.Types.ObjectId(hotelId) } },
      { $group: { _id: null, total: { $sum: '$total' } }}
    ]);

    res.json({
      stats,
      totalOrders,
      totalRevenue: totalRevenue[0]?.total || 0
    });
  } catch (error) {
    console.error('Error fetching service stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
};

// Cancel a service order — see deleteServiceOrder below for why there is no hard-delete path.
export const cancelServiceOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;

    const existingOrder = await ServiceOrder.findById(orderId);
    if (!existingOrder) {
      return res.status(404).json({ error: 'Service order not found' });
    }

    if (req.user.role !== 'admin' && String(existingOrder.guestId) !== req.user.userId) {
      return res.status(403).json({ error: 'Not authorized to cancel this order' });
    }

    // Same lock point as the staff-side updateServiceOrderStatus: 'pending' (no staff assigned
    // yet) is the one universal "not started" state shared by every service type — once an
    // order moves past it, real work is underway (the kitchen has started cooking, laundry has
    // been picked up, a transport is dispatched, ...) and cancelling from there would erase an
    // already-in-motion transaction, leaving staff holding an order that no longer exists in
    // the system. This used to only block completed/delivered/cancelled, which let a guest
    // cancel a food order well after the kitchen had already started preparing it.
    if (existingOrder.status !== 'pending' && req.user.role !== 'admin') {
      return res.status(400).json({ error: `This order is already ${existingOrder.status} and can no longer be cancelled.` });
    }

    // Atomic compare-and-swap (same pattern as claimServiceOrder/claimTask) — the check above
    // reads a snapshot that can go stale, e.g. staff assigns and starts preparing the order in
    // the moment between that read and this write. Filtering the write itself on status still
    // being 'pending' means a losing race can't silently cancel an order that's already in
    // production; it instead falls through to the 409 below with the order's actual status.
    const cancelFilter = req.user.role === 'admin' ? { _id: orderId } : { _id: orderId, status: 'pending' };
    const order = await ServiceOrder.findOneAndUpdate(
      cancelFilter,
      {
        $set: {
          status: 'cancelled',
          specialRequests: `${existingOrder.specialRequests || ''} \n Cancellation reason: ${reason || 'No reason provided'}`
        },
        $push: { statusHistory: { status: 'cancelled', changedBy: req.user.userId, changedByRole: req.user.role, at: new Date() } }
      },
      { new: true }
    );

    if (!order) {
      const current = await ServiceOrder.findById(orderId);
      return res.status(409).json({ error: `This order is already ${current?.status || 'unavailable'} and can no longer be cancelled.` });
    }

    const serviceLabel = SERVICE_LABELS[order.serviceType] || order.serviceType;
    await createNotification({
      userId: order.guestId,
      type: 'order',
      title: 'Order Cancelled',
      message: `Your ${serviceLabel.toLowerCase()} order has been cancelled.`,
      link: '/my-orders',
      actionLabel: 'View Order'
    });

    sendToHotel(order.hotelId, 'order-updated', { serviceType: order.serviceType, orderId: order._id, status: order.status });
    sendToUser(order.guestId, 'order-updated', { serviceType: order.serviceType, orderId: order._id, status: order.status });

    res.json({
      message: 'Service order cancelled',
      order
    });
  } catch (error) {
    console.error('Error cancelling order:', error);
    res.status(500).json({ error: 'Failed to cancel order' });
  }
};

// Hard-deleting a service order would erase real transaction/revenue history and the
// statusHistory audit trail (who changed what, when) — there is no status, and no role
// including admin, for which that's an acceptable outcome. cancelServiceOrder (while still
// 'pending') is the only reversal this app offers; once a cancelled/completed/delivered order
// exists, its record is permanent. This endpoint exists (rather than leaving the route
// undefined) specifically so a DELETE request gets an explicit, permanent 403 explaining why,
// instead of a generic 404 that could read as "not built yet" to a future caller.
export const deleteServiceOrder = async (req, res) => {
  return res.status(403).json({
    error: 'Service orders cannot be deleted. Cancel a still-pending order instead — every other status is a permanent transaction record.'
  });
};

// Get daily revenue report
export const getDailyRevenueReport = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { startDate, endDate } = req.query;

    const hotel = await Hotel.findOne({ _id: hotelId, hostId: req.user.userId });
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    const report = await ServiceOrder.aggregate([
      {
        $match: {
          hotelId: new mongoose.Types.ObjectId(hotelId),
          createdAt: {
            $gte: new Date(startDate),
            $lte: new Date(endDate)
          },
          // Most service orders are charged to the guest's room and remain in
          // paymentStatus=pending until the stay is settled. Revenue eligibility
          // therefore follows the dashboard rule: every non-cancelled order counts.
          status: { $ne: 'cancelled' }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
          },
          total: { $sum: '$total' },
          orders: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 }}
    ]);

    res.json(report);
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
};

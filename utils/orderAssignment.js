import ServiceOrder from '../models/ServiceOrder.js';
import Staff from '../models/Staff.js';
import Attendance from '../models/Attendance.js';
import Hotel from '../models/Hotel.js';
import { createNotification } from './notificationUtils.js';
import { sendToHotel } from './sseHub.js';

// Which permission decides who may take an order, keyed by order type and the status it is
// waiting in. Restaurant and bar orders are two hand-offs: prep (kitchen vs bar), then delivery
// once the order is 'ready'. This is also the rule behind the staff queues' self-claim, so
// assignment and claiming can never disagree about who is eligible.
export const STAGE_ROLES = {
  restaurant: { pending: 'canPrepareOrders', ready: 'canDeliverOrders' },
  bar: { pending: 'canPrepareBarOrders', ready: 'canDeliverOrders' },
  laundry: { pending: 'canManageLaundry' },
  transportation: { pending: 'canClaimTransportation' },
  'early-checkin': { pending: 'canManageGuestServices' },
  'late-checkout': { pending: 'canManageGuestServices' }
};

// Where an assigned staff member works each order type.
export const STAFF_QUEUE_LINKS = {
  restaurant: '/staff/kitchen-queue',
  bar: '/staff/bar-queue',
  laundry: '/staff/laundry-queue',
  transportation: '/staff/transportation-queue',
  'early-checkin': '/staff/guest-services-queue',
  'late-checkout': '/staff/guest-services-queue'
};

const DELIVERY_QUEUE = '/staff/delivery-queue';

const TERMINAL_STATUSES = ['completed', 'delivered', 'cancelled', 'denied'];

const ORDER_LABELS = {
  restaurant: 'restaurant',
  bar: 'bar',
  laundry: 'laundry',
  transportation: 'transportation',
  'early-checkin': 'early check-in',
  'late-checkout': 'late check-out'
};

function queueLinkFor(order) {
  const isDelivery = ['restaurant', 'bar'].includes(order.serviceType) && order.status === 'ready';
  return isDelivery ? DELIVERY_QUEUE : STAFF_QUEUE_LINKS[order.serviceType] || '/staff/dashboard';
}

// The eligible staff member who is clocked in and has the fewest open orders. Spreading by
// current workload (rather than rotating) keeps one person from being buried while a colleague
// with the same role is idle. Null when nobody with the role is on shift.
async function pickStaff(hotelId, permissionKey, excludeStaffId = null) {
  const eligible = await Staff.find({
    hotelId,
    status: 'active',
    [`permissions.${permissionKey}`]: true,
    ...(excludeStaffId ? { _id: { $ne: excludeStaffId } } : {})
  });
  if (eligible.length === 0) return null;

  const clockedIn = await Attendance.find({ staffId: { $in: eligible.map(s => s._id) }, clockOutTime: null }).select('staffId');
  const onShiftIds = new Set(clockedIn.map(a => String(a.staffId)));
  const onShift = eligible.filter(s => onShiftIds.has(String(s._id)));
  if (onShift.length === 0) return null;

  const loads = await ServiceOrder.aggregate([
    { $match: { staffId: { $in: onShift.map(s => s._id) }, status: { $nin: TERMINAL_STATUSES } } },
    { $group: { _id: '$staffId', open: { $sum: 1 } } }
  ]);
  const openByStaff = new Map(loads.map(l => [String(l._id), l.open]));

  return onShift.sort((a, b) => {
    const diff = (openByStaff.get(String(a._id)) || 0) - (openByStaff.get(String(b._id)) || 0);
    return diff !== 0 ? diff : String(a._id).localeCompare(String(b._id));
  })[0];
}

async function notifyHostNobodyOnShift(order) {
  const hotel = await Hotel.findById(order.hotelId).select('hostId');
  if (!hotel?.hostId) return;
  const label = ORDER_LABELS[order.serviceType] || order.serviceType;
  await createNotification({
    userId: hotel.hostId,
    type: 'order',
    title: 'No staff on shift for an order',
    message: `A new ${label} order is waiting and nobody with the right role is clocked in. It will be assigned when someone clocks in, or you can process it yourself.`,
    link: `/host/${order.serviceType}-orders`,
    actionLabel: 'View Order'
  });
}

// Gives an unassigned order to the right staff member for the stage it is in. Returns the
// updated order, or null when it was left alone (already assigned, finished, no role for this
// type, or nobody on shift — in which case the host is told). The assignment is a
// compare-and-swap on staffId: null, so two triggers at once (a new order and someone clocking
// in) can't hand the same order to two people.
export async function autoAssignOrder(orderId, { excludeStaffId = null } = {}) {
  const order = await ServiceOrder.findById(orderId);
  if (!order || order.staffId || TERMINAL_STATUSES.includes(order.status)) return null;

  const permissionKey = STAGE_ROLES[order.serviceType]?.[order.status];
  if (!permissionKey) return null;

  const staff = await pickStaff(order.hotelId, permissionKey, excludeStaffId);
  if (!staff) {
    await notifyHostNobodyOnShift(order);
    return null;
  }

  const assigned = await ServiceOrder.findOneAndUpdate(
    { _id: order._id, staffId: null, status: order.status },
    { staffId: staff._id },
    { new: true }
  );
  if (!assigned) return null;

  const label = ORDER_LABELS[assigned.serviceType] || assigned.serviceType;
  await createNotification({
    userId: staff.userId,
    type: 'order',
    title: 'New Order Assigned To You',
    message: `A ${label} order has been assigned to you.`,
    link: queueLinkFor(assigned),
    actionLabel: 'View Queue'
  });
  sendToHotel(assigned.hotelId, 'order-updated', {
    serviceType: assigned.serviceType,
    orderId: assigned._id,
    status: assigned.status,
    staffId: staff._id
  });
  return assigned;
}

// Orders that piled up while nobody was on shift go to whoever has just clocked in.
export async function assignWaitingOrders(staff) {
  const waiting = [];
  for (const [serviceType, stages] of Object.entries(STAGE_ROLES)) {
    for (const [status, permissionKey] of Object.entries(stages)) {
      if (!staff.permissions?.[permissionKey]) continue;
      const orders = await ServiceOrder.find({ hotelId: staff.hotelId, serviceType, status, staffId: null }).sort({ createdAt: 1 }).select('_id');
      waiting.push(...orders.map(o => o._id));
    }
  }
  for (const id of waiting) await autoAssignOrder(id);
}

// A staff member going off shift hands back whatever they haven't started: the order is
// re-offered to someone still on shift (or left waiting, with the host told). Work already
// underway stays with them. Call after the clock-out has been saved so they aren't picked again.
export async function releaseUnstartedOrders(staff) {
  const released = [];
  for (const [serviceType, stages] of Object.entries(STAGE_ROLES)) {
    for (const [status, permissionKey] of Object.entries(stages)) {
      if (!staff.permissions?.[permissionKey]) continue;
      const orders = await ServiceOrder.find({ hotelId: staff.hotelId, serviceType, status, staffId: staff._id }).select('_id');
      for (const order of orders) {
        const reopened = await ServiceOrder.findOneAndUpdate({ _id: order._id, staffId: staff._id, status }, { staffId: null }, { new: true });
        if (reopened) released.push(reopened._id);
      }
    }
  }
  for (const id of released) await autoAssignOrder(id, { excludeStaffId: staff._id });
}

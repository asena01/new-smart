import mongoose from 'mongoose';
import ServiceOrder from '../models/ServiceOrder.js';
import Booking from '../models/Booking.js';
import Hotel from '../models/Hotel.js';
import Staff from '../models/Staff.js';
import { createNotification } from '../utils/notificationUtils.js';
import { sendToUser, sendToHotel } from '../utils/sseHub.js';

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
    const pickup = new Date(serviceDetails.pickupDate);
    if (serviceDetails.pickupTime) {
      const [hours, minutes] = String(serviceDetails.pickupTime).split(':').map(Number);
      if (!Number.isNaN(hours)) {
        pickup.setHours(hours, minutes || 0, 0, 0);
      }
    }
    if (!Number.isNaN(pickup.getTime()) && pickup > from) {
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
      subtotal,
      tax,
      total,
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
    if (!booking.checkInInfo?.actualCheckInTime) {
      return res.status(403).json({ error: 'Please check in before ordering hotel services.' });
    }

    // Validate hotel exists
    const hotel = await Hotel.findById(hotelId);
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    const serviceOrder = new ServiceOrder({
      bookingId,
      hotelId,
      guestId,
      serviceType,
      serviceDetails,
      subtotal,
      tax,
      total,
      specialRequests,
      paymentMethod,
      estimatedReadyAt: computeEstimatedReadyAt(serviceType, serviceDetails),
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

    res.status(201).json({
      message: 'Service order created successfully',
      order: serviceOrder
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
    const { serviceType, status } = req.query;

    const hotel = await Hotel.findOne({ _id: hotelId, hostId: req.user.userId });
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    let filter = { hotelId };
    if (serviceType) filter.serviceType = serviceType;
    if (status) filter.status = status;

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
// and flip both rooms' status so the host's room list reflects the swap immediately.
async function finalizeRoomUpgrade(order) {
  const newRoomNumber = order.serviceDetails?.newRoomNumber;
  if (!newRoomNumber) return;

  const booking = await Booking.findById(order.bookingId);
  if (!booking) return;
  const oldRoomNumber = booking.roomId;

  const hotel = await Hotel.findById(order.hotelId);
  if (hotel) {
    const oldRoom = hotel.rooms.find(r => r.roomNumber === oldRoomNumber);
    if (oldRoom) oldRoom.status = 'available';
    const newRoom = hotel.rooms.find(r => r.roomNumber === newRoomNumber);
    if (newRoom) newRoom.status = 'occupied';
    await hotel.save();
  }

  booking.roomId = newRoomNumber;
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
      const hotel = await Hotel.findOne({ _id: existingOrder.hotelId, hostId: req.user.userId });
      if (!hotel) {
        return res.status(403).json({ error: 'Not authorized to update this order' });
      }
    }

    if (status !== 'pending' && !existingOrder.staffId) {
      return res.status(400).json({ error: 'Assign a staff member to this order before updating its status.' });
    }

    const order = await ServiceOrder.findByIdAndUpdate(
      orderId,
      {
        status,
        completedAt: status === 'completed' || status === 'delivered' ? Date.now() : undefined
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

    if (req.user.role !== 'admin') {
      const hotel = await Hotel.findOne({ _id: existingOrder.hotelId, hostId: req.user.userId });
      if (!hotel) {
        return res.status(403).json({ error: 'Not authorized to update this order' });
      }
    }

    const staff = await Staff.findOne({ _id: staffId, hotelId: existingOrder.hotelId });
    if (!staff) {
      return res.status(404).json({ error: 'Staff member not found for this hotel' });
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

// Update payment status
export const updatePaymentStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { paymentStatus, paymentMethod } = req.body;

    const order = await ServiceOrder.findByIdAndUpdate(
      orderId,
      {
        paymentStatus,
        paymentMethod,
        paidAt: paymentStatus === 'completed' ? Date.now() : undefined
      },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ error: 'Service order not found' });
    }

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

// Delete/Cancel service order
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

    const order = await ServiceOrder.findByIdAndUpdate(
      orderId,
      {
        status: 'cancelled',
        specialRequests: `${existingOrder.specialRequests || ''} \n Cancellation reason: ${reason}`
      },
      { new: true }
    );

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
          paymentStatus: 'completed'
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

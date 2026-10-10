import Booking from '../models/Booking.js';
import ServiceOrder from '../models/ServiceOrder.js';
import { isAuthorizedForBooking } from './bookingController.js';
import { generateBookingReceiptPdf, generateServiceOrderReceiptPdf } from '../utils/receiptGenerator.js';

// A receipt only makes sense once money has actually moved — a still-pending or failed
// payment has nothing real to document. 'refunded' stays eligible: the guest was charged at
// some point and may still want a record of that, even though the money has since been
// returned (see paymentStatus's own enum on Booking — nothing in this app currently drives a
// booking to 'refunded' automatically, but the receipt honors the field if it's ever set).
const RECEIPT_ELIGIBLE_PAYMENT_STATUSES = ['completed', 'refunded'];

function isOrderAuthorized(order, req) {
  if (req.user.role === 'admin') return true;
  const guestId = order.guestId?._id?.toString() || order.guestId?.toString();
  if (guestId && guestId === req.user.userId) return true;
  const hostId = order.hotelId?.hostId?.toString();
  if (req.user.role === 'host' && hostId && hostId === req.user.userId) return true;
  return false;
}

export const getBookingReceipt = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.bookingId).populate('hotelId').populate('userId');
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (!(await isAuthorizedForBooking(booking, req))) {
      return res.status(403).json({ message: 'Not authorized to access this receipt' });
    }

    if (!RECEIPT_ELIGIBLE_PAYMENT_STATUSES.includes(booking.paymentStatus)) {
      return res.status(400).json({
        message: 'No receipt is available for this booking yet — payment has not been completed.'
      });
    }

    const pdfBuffer = await generateBookingReceiptPdf(booking, booking.hotelId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="receipt-${booking.bookingReference}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating booking receipt:', error);
    res.status(500).json({ message: 'Failed to generate receipt' });
  }
};

export const getServiceOrderReceipt = async (req, res) => {
  try {
    const order = await ServiceOrder.findById(req.params.orderId).populate('hotelId').populate('guestId');
    if (!order) {
      return res.status(404).json({ message: 'Service order not found' });
    }

    if (!isOrderAuthorized(order, req)) {
      return res.status(403).json({ message: 'Not authorized to access this receipt' });
    }

    if (!RECEIPT_ELIGIBLE_PAYMENT_STATUSES.includes(order.paymentStatus)) {
      return res.status(400).json({
        message: 'No receipt is available for this order yet — payment has not been completed.'
      });
    }

    const pdfBuffer = await generateServiceOrderReceiptPdf(order, order.hotelId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="receipt-order-${order._id}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating service order receipt:', error);
    res.status(500).json({ message: 'Failed to generate receipt' });
  }
};

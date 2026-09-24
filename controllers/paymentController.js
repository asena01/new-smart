import axios from 'axios';
import Booking from '../models/Booking.js';
import ServiceOrder from '../models/ServiceOrder.js';
import PlatformSettings from '../models/PlatformSettings.js';
import Hotel from '../models/Hotel.js';
import User from '../models/User.js';

const FLUTTERWAVE_BASE_URL = 'https://api.flutterwave.com/v3';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:4200';

// Flutterwave's inline/modal checkout (the old FlutterwaveCheckout({...}) call, an iframe on
// our own page) gets stuck on its own branded loading animation and never renders a payment
// form — reproduced consistently, and confirmed it's specifically the iframe embedding: the
// exact same checkout URL opened as a normal top-level page renders fine. This is a known
// failure mode for embedded payment widgets under modern third-party-cookie/storage
// restrictions, not something fixable from our side via headers. Fix: use Flutterwave's
// redirect-based "Standard" flow instead — get a hosted payment link server-to-server, send
// the guest's whole browser there (a real top-level navigation, so it behaves like the
// working standalone-tab case), and let Flutterwave redirect back to redirectUrl afterward.
async function createFlutterwavePaymentLink({ txRef, amount, currency, customer, title, description, redirectUrl, subaccounts }) {
  const response = await axios.post(
    `${FLUTTERWAVE_BASE_URL}/payments`,
    {
      tx_ref: txRef,
      amount,
      currency,
      redirect_url: redirectUrl,
      customer,
      payment_options: 'card,mobilemoney,ussd,banktransfer',
      customizations: {
        title,
        description,
        logo: `${FRONTEND_URL}/finsmarthotels-logo.png`
      },
      ...(subaccounts ? { subaccounts } : {})
    },
    { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } }
  );
  return response.data?.data?.link;
}

// Expose the public key so the frontend can launch the Flutterwave checkout modal, plus the
// platform's commission rate as a whole percentage (Flutterwave's split-payment
// transaction_charge expects e.g. 10, not 0.1) — checkout.ts/CheckoutScreen.tsx pass this
// straight through to the subaccounts config instead of duplicating the settings lookup.
export const getPaymentConfig = async (req, res) => {
  try {
    const settings = await PlatformSettings.findOne({});
    res.status(200).json({
      publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY,
      commissionRatePercent: (settings?.commissionRate ?? 0.1) * 100
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const initiateBookingPayment = async (req, res) => {
  try {
    const { bookingId } = req.body;
    if (!bookingId) {
      return res.status(400).json({ message: 'bookingId is required' });
    }

    const booking = await Booking.findById(bookingId).populate('hotelId');
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }
    if (!booking.userId || booking.userId.toString() !== req.user.userId) {
      return res.status(403).json({ message: 'Not authorized to pay for this booking' });
    }
    if (booking.paymentStatus === 'completed') {
      return res.status(400).json({ message: 'This booking is already paid' });
    }

    const [user, settings] = await Promise.all([
      User.findById(req.user.userId),
      PlatformSettings.findOne({})
    ]);
    const commissionRatePercent = (settings?.commissionRate ?? 0.1) * 100;
    const hotel = booking.hotelId;

    const link = await createFlutterwavePaymentLink({
      txRef: `${booking.bookingReference}-${Date.now()}`,
      amount: booking.totalPrice,
      currency: booking.currency,
      customer: { email: user?.email, name: `${user?.firstName || ''} ${user?.lastName || ''}`.trim() },
      title: 'FinSmartHotels Booking',
      description: `Payment for ${hotel?.name || 'your booking'}`,
      redirectUrl: `${FRONTEND_URL}/payment-callback?type=booking&id=${booking._id}`,
      subaccounts: hotel?.flutterwaveSubaccountId
        ? [{ id: hotel.flutterwaveSubaccountId, transaction_charge_type: 'percentage', transaction_charge: commissionRatePercent }]
        : undefined
    });

    res.status(200).json({ link });
  } catch (error) {
    console.error('Error initiating booking payment:', error.response?.data || error.message);
    res.status(500).json({ message: 'Failed to initiate payment' });
  }
};

export const initiateServiceOrderPayment = async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ message: 'orderId is required' });
    }

    const order = await ServiceOrder.findById(orderId).populate('hotelId');
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }
    if (!order.guestId || order.guestId.toString() !== req.user.userId) {
      return res.status(403).json({ message: 'Not authorized to pay for this order' });
    }
    if (order.paymentStatus === 'completed') {
      return res.status(400).json({ message: 'This order is already paid' });
    }

    const [user, settings] = await Promise.all([
      User.findById(req.user.userId),
      PlatformSettings.findOne({})
    ]);
    const commissionRatePercent = (settings?.commissionRate ?? 0.1) * 100;
    const hotel = order.hotelId;

    const link = await createFlutterwavePaymentLink({
      txRef: `${order._id}-${Date.now()}`,
      amount: order.total,
      currency: 'NGN',
      customer: { email: user?.email, name: `${user?.firstName || ''} ${user?.lastName || ''}`.trim() },
      title: 'FinSmartHotels Room Upgrade',
      description: `Payment for ${hotel?.name || 'your order'}`,
      redirectUrl: `${FRONTEND_URL}/payment-callback?type=service-order&id=${order._id}`,
      subaccounts: hotel?.flutterwaveSubaccountId
        ? [{ id: hotel.flutterwaveSubaccountId, transaction_charge_type: 'percentage', transaction_charge: commissionRatePercent }]
        : undefined
    });

    res.status(200).json({ link });
  } catch (error) {
    console.error('Error initiating service order payment:', error.response?.data || error.message);
    res.status(500).json({ message: 'Failed to initiate payment' });
  }
};

async function verifyFlutterwaveTransaction(transactionId) {
  const response = await axios.get(
    `${FLUTTERWAVE_BASE_URL}/transactions/${transactionId}/verify`,
    { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } }
  );
  return response.data?.data;
}

// Verify a Flutterwave transaction server-to-server before trusting it, then mark the booking paid
export const verifyPayment = async (req, res) => {
  try {
    const { transactionId, bookingId } = req.body;

    if (!transactionId || !bookingId) {
      return res.status(400).json({ message: 'transactionId and bookingId are required' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (!booking.userId || booking.userId.toString() !== req.user.userId) {
      return res.status(403).json({ message: 'Not authorized to pay for this booking' });
    }

    if (booking.paymentStatus === 'completed') {
      return res.status(200).json({ success: true, booking });
    }

    const transaction = await verifyFlutterwaveTransaction(transactionId);

    const isValid =
      transaction &&
      transaction.status === 'successful' &&
      typeof transaction.tx_ref === 'string' &&
      transaction.tx_ref.startsWith(`${booking.bookingReference}-`) &&
      transaction.currency === booking.currency &&
      transaction.amount >= booking.totalPrice;

    if (!isValid) {
      booking.paymentStatus = 'failed';
      await booking.save();
      return res.status(400).json({ message: 'Payment could not be verified', booking });
    }

    booking.paymentStatus = 'completed';
    booking.paymentMethod = 'flutterwave';
    booking.paymentId = String(transaction.id);
    if (booking.status === 'pending') {
      booking.status = 'confirmed';
    }
    await booking.save();

    res.status(200).json({ success: true, booking });
  } catch (error) {
    console.error('Error verifying payment:', error.response?.data || error.message);
    res.status(500).json({ message: 'Failed to verify payment' });
  }
};

// Same server-to-server verification as verifyPayment, for a ServiceOrder (e.g. a room
// upgrade) instead of a Booking — the two models don't share a schema (no bookingReference/
// currency on ServiceOrder), so this mirrors rather than reuses verifyPayment's body.
// Marks the order confirmed-and-paid only; the actual room reassignment stays a separate
// host/staff fulfillment step (finalizeRoomUpgrade, triggered when staff mark the order
// completed) — paying doesn't by itself mean the new room is ready.
export const verifyServiceOrderPayment = async (req, res) => {
  try {
    const { transactionId, orderId } = req.body;

    if (!transactionId || !orderId) {
      return res.status(400).json({ message: 'transactionId and orderId are required' });
    }

    const order = await ServiceOrder.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (!order.guestId || order.guestId.toString() !== req.user.userId) {
      return res.status(403).json({ message: 'Not authorized to pay for this order' });
    }

    if (order.paymentStatus === 'completed') {
      return res.status(200).json({ success: true, order });
    }

    const transaction = await verifyFlutterwaveTransaction(transactionId);

    // ServiceOrder has no per-order currency field — every service order in this app is
    // priced and displayed in NGN, so that's what was actually charged.
    const isValid =
      transaction &&
      transaction.status === 'successful' &&
      typeof transaction.tx_ref === 'string' &&
      transaction.tx_ref.startsWith(`${order._id}-`) &&
      transaction.currency === 'NGN' &&
      transaction.amount >= order.total;

    if (!isValid) {
      order.paymentStatus = 'failed';
      await order.save();
      return res.status(400).json({ message: 'Payment could not be verified', order });
    }

    order.paymentStatus = 'completed';
    order.paymentMethod = 'flutterwave';
    order.paidAt = new Date();
    if (order.status === 'pending') {
      order.status = 'confirmed';
    }
    await order.save();

    res.status(200).json({ success: true, order });
  } catch (error) {
    console.error('Error verifying service order payment:', error.response?.data || error.message);
    res.status(500).json({ message: 'Failed to verify payment' });
  }
};

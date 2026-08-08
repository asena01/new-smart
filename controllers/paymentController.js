import axios from 'axios';
import Booking from '../models/Booking.js';

const FLUTTERWAVE_BASE_URL = 'https://api.flutterwave.com/v3';

// Expose the public key so the frontend can launch the Flutterwave checkout modal
export const getPaymentConfig = (req, res) => {
  res.status(200).json({
    publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY
  });
};

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

    const verifyResponse = await axios.get(
      `${FLUTTERWAVE_BASE_URL}/transactions/${transactionId}/verify`,
      { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } }
    );

    const transaction = verifyResponse.data?.data;

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

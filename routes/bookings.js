import express from 'express';
import {
  createBooking,
  getBookings,
  getBookingById,
  cancelBooking,
  setupContactlessCheckIn,
  confirmCheckIn,
  checkOutGuest,
  createWalkInBooking,
  getHotelBookings,
  startVerification,
  getVerificationStatus,
  getVerificationDecision,
  getUpgradeOptions,
  getLockCredentials,
} from '../controllers/bookingController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.post('/', protect, createBooking);
router.get('/', protect, getBookings);
router.post('/hotel/:hotelId/walk-in', protect, createWalkInBooking);
router.get('/hotel/:hotelId', protect, getHotelBookings);
router.get('/:id', protect, getBookingById);
router.put('/:id/cancel', protect, cancelBooking);
router.post('/:id/contactless-checkin', protect, setupContactlessCheckIn);
router.post('/:id/start-verification', protect, startVerification);
router.get('/:id/verification-status', protect, getVerificationStatus);
router.get('/:id/verification-decision', protect, getVerificationDecision);
router.get('/:id/upgrade-options', protect, getUpgradeOptions);
router.get('/:id/lock-credentials', protect, getLockCredentials);
router.put('/:id/confirm-checkin', protect, confirmCheckIn);
router.put('/:id/checkout', protect, checkOutGuest);

export default router;

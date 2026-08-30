import express from 'express';
import * as paymentController from '../controllers/paymentController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.get('/config', protect, paymentController.getPaymentConfig);
router.post('/initiate-booking', protect, paymentController.initiateBookingPayment);
router.post('/initiate-service-order', protect, paymentController.initiateServiceOrderPayment);
router.post('/verify', protect, paymentController.verifyPayment);
router.post('/verify-service-order', protect, paymentController.verifyServiceOrderPayment);

export default router;

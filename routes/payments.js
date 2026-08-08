import express from 'express';
import * as paymentController from '../controllers/paymentController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.get('/config', protect, paymentController.getPaymentConfig);
router.post('/verify', protect, paymentController.verifyPayment);

export default router;

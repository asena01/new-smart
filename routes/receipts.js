import express from 'express';
import * as receiptController from '../controllers/receiptController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.get('/booking/:bookingId', protect, receiptController.getBookingReceipt);
router.get('/service-order/:orderId', protect, receiptController.getServiceOrderReceipt);

export default router;

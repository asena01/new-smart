import express from 'express';
import * as requestController from '../controllers/requestController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// Staff: submit, view, and cancel own requests
router.post('/', protect, requestController.createRequest);
router.get('/me', protect, requestController.getMyRequests);
router.delete('/:requestId', protect, requestController.cancelRequest);

// Host/Manager: view and review hotel requests
router.get('/hotel/:hotelId', protect, requestController.getHotelRequests);
router.patch('/:requestId/review', protect, requestController.reviewRequest);

export default router;

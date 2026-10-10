import express from 'express';
import * as reviewController from '../controllers/reviewController.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

router.get('/hotel/:hotelId', reviewController.getHotelReviews);
router.get('/hotel/:hotelId/mine', protect, reviewController.getMyReviewForHotel);
router.get('/mine/hotel', protect, authorize('host', 'admin'), reviewController.getMyHotelReviews);
router.post('/', protect, reviewController.createReview);
router.put('/:reviewId/respond', protect, authorize('host', 'admin'), reviewController.respondToReview);

export default router;

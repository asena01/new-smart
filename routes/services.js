import express from 'express';
import * as serviceOrderController from '../controllers/serviceOrderController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// Create service order
router.post('/orders', protect, serviceOrderController.createServiceOrder);

// Get guest's service orders
router.get('/guest/:guestId/orders', protect, serviceOrderController.getGuestServiceOrders);

// Get hotel's service orders
router.get('/hotel/:hotelId/orders', protect, serviceOrderController.getHotelServiceOrders);

// Get specific service order
router.get('/orders/:orderId', protect, serviceOrderController.getServiceOrder);

// Update service order status
router.patch('/orders/:orderId/status', protect, serviceOrderController.updateServiceOrderStatus);

// Assign the staff member responsible for fulfilling this order
router.patch('/orders/:orderId/assign-staff', protect, serviceOrderController.assignStaffToOrder);

// Update payment status
router.patch('/orders/:orderId/payment', protect, serviceOrderController.updatePaymentStatus);

// Cancel service order
router.post('/orders/:orderId/cancel', protect, serviceOrderController.cancelServiceOrder);

// Get hotel service statistics
router.get('/hotel/:hotelId/stats', protect, serviceOrderController.getServiceStats);

// Get daily revenue report
router.get('/hotel/:hotelId/revenue-report', protect, serviceOrderController.getDailyRevenueReport);

export default router;

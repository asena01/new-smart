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

// Self-service claim of a ready, unassigned order
router.patch('/orders/:orderId/claim', protect, serviceOrderController.claimServiceOrder);

// Ready, unassigned orders eligible staff can claim
router.get('/hotel/:hotelId/orders/claimable', protect, serviceOrderController.getClaimableOrders);

// Update payment status
router.patch('/orders/:orderId/payment', protect, serviceOrderController.updatePaymentStatus);

// Cancel service order
router.post('/orders/:orderId/cancel', protect, serviceOrderController.cancelServiceOrder);

// Deletion is permanently disallowed — see deleteServiceOrder's comment for why. Registered
// explicitly (rather than left as an undefined route) so DELETE /orders/:orderId returns a
// clear 403 instead of a 404 that could read as "not implemented yet".
router.delete('/orders/:orderId', protect, serviceOrderController.deleteServiceOrder);

// Get hotel service statistics
router.get('/hotel/:hotelId/stats', protect, serviceOrderController.getServiceStats);

// Get daily revenue report
router.get('/hotel/:hotelId/revenue-report', protect, serviceOrderController.getDailyRevenueReport);

export default router;

import express from 'express';
import {
  getDashboard,
  getAnalytics,
  getAllUsers,
  getHotelsList,
  getHotelGuests,
  getAllGuests,
  createUser,
  updateUser,
  deleteUser,
  bulkDeleteUsers,
  updateUserRole,
  updateUserStatus,
  updateHotelStatus,
  getHotelPaymentDetails,
  getSettings,
  updateSettings
} from '../controllers/adminController.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

router.get('/dashboard', protect, authorize('admin'), getDashboard);
router.get('/analytics', protect, authorize('admin'), getAnalytics);
router.get('/users', protect, authorize('admin'), getAllUsers);
router.get('/hotels', protect, authorize('admin'), getHotelsList);
router.get('/hotels/:id/guests', protect, authorize('admin'), getHotelGuests);
router.get('/guests', protect, authorize('admin'), getAllGuests);
router.post('/users', protect, authorize('admin'), createUser);
router.post('/users/bulk-delete', protect, authorize('admin'), bulkDeleteUsers);
router.put('/users/:id', protect, authorize('admin'), updateUser);
router.delete('/users/:id', protect, authorize('admin'), deleteUser);
router.patch('/users/:id/role', protect, authorize('admin'), updateUserRole);
router.patch('/users/:id/status', protect, authorize('admin'), updateUserStatus);
router.patch('/hotels/:id/status', protect, authorize('admin'), updateHotelStatus);
router.get('/hotels/:id/payment-details', protect, authorize('admin'), getHotelPaymentDetails);
router.get('/settings', protect, authorize('admin'), getSettings);
router.put('/settings', protect, authorize('admin'), updateSettings);

export default router;

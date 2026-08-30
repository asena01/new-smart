import express from 'express';
import {
  getAllHotels,
  getHotelById,
  getMyHotel,
  getHostDashboard,
  getHostRevenue,
  getMyRooms,
  addMyRoom,
  updateMyRoom,
  deleteMyRoom,
  createHotel,
  updateHotel,
  updateHotelPaymentSubaccount,
  updateHotelBankDetails,
  deleteHotel,
  searchHotels,
} from '../controllers/hotelController.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

router.get('/search', searchHotels);
router.get('/host/mine', protect, authorize('host', 'admin'), getMyHotel);
router.get('/host/dashboard', protect, authorize('host', 'admin', 'staff'), getHostDashboard);
router.get('/host/revenue', protect, authorize('host', 'admin'), getHostRevenue);
router.get('/host/rooms', protect, authorize('host', 'admin', 'staff'), getMyRooms);
router.post('/host/rooms', protect, authorize('host', 'admin'), addMyRoom);
router.put('/host/rooms/:roomId', protect, authorize('host', 'admin', 'staff'), updateMyRoom);
router.delete('/host/rooms/:roomId', protect, authorize('host', 'admin'), deleteMyRoom);
router.get('/', getAllHotels);
router.get('/:id', getHotelById);
router.post('/', protect, authorize('host', 'admin'), createHotel);
// Not role-restricted at the route level — a staff member with canChangeHotelSettings can
// reach this too (see updateHotel's own authorization check); bank/payout details stay on a
// separate, host/admin-only route (PATCH /:id/bank-details) regardless.
router.put('/:id', protect, updateHotel);
router.patch('/:id/payment-subaccount', protect, authorize('admin'), updateHotelPaymentSubaccount);
router.patch('/:id/bank-details', protect, authorize('host', 'admin'), updateHotelBankDetails);
router.delete('/:id', protect, authorize('host', 'admin'), deleteHotel);

export default router;

import express from 'express';
import {
  getAllHotels,
  getHotelById,
  getMyHotel,
  getHostDashboard,
  getMyRooms,
  addMyRoom,
  updateMyRoom,
  deleteMyRoom,
  createHotel,
  updateHotel,
  deleteHotel,
  searchHotels,
} from '../controllers/hotelController.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

router.get('/search', searchHotels);
router.get('/host/mine', protect, authorize('host', 'admin'), getMyHotel);
router.get('/host/dashboard', protect, authorize('host', 'admin'), getHostDashboard);
router.get('/host/rooms', protect, authorize('host', 'admin'), getMyRooms);
router.post('/host/rooms', protect, authorize('host', 'admin'), addMyRoom);
router.put('/host/rooms/:roomId', protect, authorize('host', 'admin'), updateMyRoom);
router.delete('/host/rooms/:roomId', protect, authorize('host', 'admin'), deleteMyRoom);
router.get('/', getAllHotels);
router.get('/:id', getHotelById);
router.post('/', protect, authorize('host', 'admin'), createHotel);
router.put('/:id', protect, authorize('host', 'admin'), updateHotel);
router.delete('/:id', protect, authorize('host', 'admin'), deleteHotel);

export default router;

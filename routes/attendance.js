import express from 'express';
import * as attendanceController from '../controllers/attendanceController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// Staff: clock in/out and view own history
router.post('/clock-in', protect, attendanceController.clockIn);
router.post('/clock-out', protect, attendanceController.clockOut);
router.get('/me', protect, attendanceController.getMyAttendance);

// Host/Manager: view hotel-wide attendance log
router.get('/hotel/:hotelId', protect, attendanceController.getHotelAttendance);
router.get('/hotel/:hotelId/export', protect, attendanceController.exportHotelAttendance);

export default router;

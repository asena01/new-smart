import express from 'express';
import * as staffController from '../controllers/staffController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// Staff management endpoints
router.post('/hotel/:hotelId/staff', protect, staffController.addStaffMember);
router.get('/hotel/:hotelId/staff', protect, staffController.getHotelStaff);
router.get('/staff/me', protect, staffController.getMyStaffProfile);
router.get('/staff/:staffId', protect, staffController.getStaffMember);
router.patch('/staff/:staffId', protect, staffController.updateStaffMember);
router.delete('/staff/:staffId', protect, staffController.deleteStaffMember);

// TTLock key management
router.patch('/staff/:staffId/ttlock-key', protect, staffController.assignTTLockKey);
router.patch('/staff/:staffId/revoke-key', protect, staffController.revokeTTLockKey);

// Schedule management
router.post('/staff/:staffId/hotel/:hotelId/schedule', protect, staffController.addSchedule);
router.get('/staff/:staffId/schedules', protect, staffController.getStaffSchedules);
router.patch('/schedule/:scheduleId', protect, staffController.updateSchedule);
router.delete('/schedule/:scheduleId', protect, staffController.deleteSchedule);

// Statistics
router.get('/hotel/:hotelId/stats', protect, staffController.getStaffStats);

// Staff invitation (public - the invitee has no auth token yet)
router.get('/staff/invite/:token', staffController.getStaffInvite);
router.post('/staff/invite/:token/accept', staffController.acceptStaffInvite);
router.post('/staff/:staffId/resend-invite', protect, staffController.resendStaffInvite);

export default router;

import express from 'express';
import {
  listDevices,
  discoverTuyaDevices,
  discoverTTLockDevices,
  createDevice,
  updateDevice,
  deleteDevice,
  assignDevice,
  testConnection,
  getDeviceLogs,
  lockRemote,
  unlockRemote,
  getHotelCardInfo
} from '../controllers/deviceController.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

// Widened to include 'staff' so a receptionist with canRemoteUnlock can list their hotel's
// devices and lock/unlock a room (see listDevices/lockRemote/unlockRemote's own permission
// checks). Every other route below explicitly excludes staff again via its own authorize(),
// same as they already excluded everyone but admin.
router.use(protect, authorize('admin', 'host', 'staff'));

// Device control (rename/reassign/create/delete/test) stays admin-only. Hosts get read-only
// visibility into devices already assigned to their own hotels (status/logs on the Rooms
// page); staff get that same visibility plus lock/unlock, gated on canRemoteUnlock inside
// the controllers themselves (not every staff member — see staffPermissions.js).
router.get('/', listDevices);
router.get('/tuya/discover', authorize('admin'), discoverTuyaDevices);
router.get('/ttlock/discover', authorize('admin'), discoverTTLockDevices);
router.post('/', authorize('admin'), createDevice);
router.put('/:id', authorize('admin'), updateDevice);
router.delete('/:id', authorize('admin'), deleteDevice);
router.patch('/:id/assign', authorize('admin'), assignDevice);
router.post('/:id/test', authorize('admin'), testConnection);
router.patch('/:id/lock', lockRemote);
router.patch('/:id/unlock', unlockRemote);
router.get('/:id/logs', authorize('admin', 'host'), getDeviceLogs);
// Admin/host/staff all reach this — staff needs it to provision a lock over Bluetooth from
// the mobile app (see mobile/src/screens), gated on canManageDevices inside the controller
// itself (not every staff member — see staffPermissions.js).
router.get('/:id/hotel-card-info', getHotelCardInfo);

export default router;

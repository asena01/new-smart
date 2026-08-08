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
  getDeviceLogs
} from '../controllers/deviceController.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

router.use(protect, authorize('admin', 'host'));

// Raw platform discovery/creation/deletion touch the shared TTLock/Tuya inventory
// directly (not partitioned per hotel), so they stay admin-only. Hosts only get
// visibility into devices already assigned to their own hotels, plus the ability
// to test/reassign/rename those.
router.get('/', listDevices);
router.get('/tuya/discover', authorize('admin'), discoverTuyaDevices);
router.get('/ttlock/discover', authorize('admin'), discoverTTLockDevices);
router.post('/', authorize('admin'), createDevice);
router.put('/:id', updateDevice);
router.delete('/:id', authorize('admin'), deleteDevice);
router.patch('/:id/assign', authorize('admin'), assignDevice);
router.post('/:id/test', testConnection);
router.get('/:id/logs', getDeviceLogs);

export default router;

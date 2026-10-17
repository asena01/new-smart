import express from 'express';
import {
  listStaffKeys,
  grantStaffKeys,
  revokeStaffKey,
  getMyKeys,
  getKeyCredentials,
  remoteUnlockWithKey
} from '../controllers/staffDoorKeyController.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

// Staff: their own keys, and using one.
router.get('/mine', protect, authorize('staff'), getMyKeys);
router.get('/:id/credentials', protect, authorize('staff'), getKeyCredentials);
router.post('/:id/remote-unlock', protect, authorize('staff'), remoteUnlockWithKey);

// Host / admin: giving, listing and revoking.
router.get('/', protect, authorize('host', 'admin'), listStaffKeys);
router.post('/', protect, authorize('host', 'admin'), grantStaffKeys);
router.patch('/:id/revoke', protect, authorize('host', 'admin'), revokeStaffKey);

export default router;

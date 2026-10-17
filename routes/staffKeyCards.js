import express from 'express';
import { issueKeyCard, issueOfflineCard, listCardsForStaff, listKeyCards, revokeKeyCard } from '../controllers/staffKeyCardController.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

// Admin-only, same as every other device-control action in this app. The windows-card-encoder
// companion app authenticates as an admin (email+password login, same as the web admin) and
// calls POST /offline after physically writing a card.
// Read-only: a host may see the cards of their own hotel's staff (shown next to app door keys).
router.get('/for-staff/:staffId', protect, authorize('host', 'admin'), listCardsForStaff);

router.use(protect, authorize('admin'));

router.get('/', listKeyCards);
router.post('/', issueKeyCard);
router.post('/offline', issueOfflineCard);
router.patch('/:id/revoke', revokeKeyCard);

export default router;

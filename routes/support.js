import express from 'express';
import * as supportController from '../controllers/supportController.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

// Live chat between a host and the platform admin
router.post('/messages', protect, supportController.sendSupportMessage);
router.get('/host/:hostId/history', protect, supportController.getSupportHistory);
router.get('/threads', protect, authorize('admin'), supportController.getSupportThreads);
router.get('/summary', protect, authorize('admin'), supportController.getSupportSummary);
router.patch('/host/:hostId/read', protect, supportController.markSupportRead);

// Incidents (tracked support tickets)
router.post('/incidents', protect, supportController.createIncident);
router.get('/incidents/mine', protect, supportController.getMyIncidents);
router.get('/incidents', protect, authorize('admin'), supportController.getAllIncidents);
router.get('/incidents/:id', protect, supportController.getIncidentById);
router.post('/incidents/:id/replies', protect, supportController.addIncidentReply);
router.patch('/incidents/:id/status', protect, authorize('admin'), supportController.updateIncidentStatus);

export default router;

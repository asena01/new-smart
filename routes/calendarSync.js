import express from 'express';
import {
  getRoomCalendar,
  addFeed,
  removeFeed,
  syncNow,
  rotateExportToken,
  getHotelStays,
  getHotelCalendars,
  syncHotelCalendars,
  addHotelFeeds,
  exportCalendar
} from '../controllers/calendarSyncController.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

// Public: other platforms fetch this without an account; the token in the URL is the credential.
router.get('/export/:token', exportCalendar);

router.get('/hotel', protect, authorize('host'), getHotelCalendars);
router.post('/hotel/sync', protect, authorize('host'), syncHotelCalendars);
router.post('/hotel/feeds', protect, authorize('host'), addHotelFeeds);
router.get('/hotels/:hotelId/stays', protect, authorize('host', 'admin', 'staff'), getHotelStays);
router.get('/rooms/:roomId', protect, authorize('host'), getRoomCalendar);
router.post('/rooms/:roomId/feeds', protect, authorize('host'), addFeed);
router.delete('/rooms/:roomId/feeds/:feedId', protect, authorize('host'), removeFeed);
router.post('/rooms/:roomId/sync', protect, authorize('host'), syncNow);
router.post('/rooms/:roomId/rotate-token', protect, authorize('host'), rotateExportToken);

export default router;

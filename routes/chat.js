import express from 'express';
import * as chatController from '../controllers/chatController.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

// Send a message
router.post('/messages', protect, chatController.sendMessage);

// Get chat history for a booking
router.get('/booking/:bookingId/history', protect, chatController.getChatHistory);

// Get chat history for hotel
router.get('/hotel/:hotelId/history', protect, chatController.getHotelChatHistory);

// Get one row per conversation for a hotel's inbox view
router.get('/hotel/:hotelId/conversations', protect, chatController.getHotelConversations);

// SSE Stream - Subscribe to real-time messages (token passed as query param)
router.get('/booking/:bookingId/stream', chatController.streamMessages);

// Mark messages as read
router.patch('/booking/:bookingId/read', protect, chatController.markMessagesAsRead);

// Get unread message count
router.get('/booking/:bookingId/unread-count', protect, chatController.getUnreadCount);

// Delete a message
router.delete('/messages/:messageId', protect, chatController.deleteMessage);

// Get SSE connection stats (admin only)
router.get('/stats', protect, authorize('admin'), chatController.getConnectionStats);

export default router;

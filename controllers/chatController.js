import jwt from 'jsonwebtoken';
import ChatMessage from '../models/Chat.js';
import Booking from '../models/Booking.js';
import Hotel from '../models/Hotel.js';
import { sendToHotel, sendToUser } from '../utils/sseHub.js';

// Store active SSE connections
const sseConnections = new Map();

// A caller may post as 'guest' only for their own booking, or as 'hotel-staff'
// only if they own the hotel the booking belongs to
const canSendAs = async (req, senderType, hotelId, guestId) => {
  if (senderType === 'guest') {
    return guestId === req.user.userId;
  }
  if (senderType === 'hotel-staff') {
    const hotel = await Hotel.findOne({ _id: hotelId, hostId: req.user.userId });
    return !!hotel;
  }
  return false;
};

// Send message
export const sendMessage = async (req, res) => {
  try {
    const { bookingId, hotelId, guestId, senderType, senderName, messageText } = req.body;

    // Validate booking exists
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (!(await canSendAs(req, senderType, hotelId, guestId))) {
      return res.status(403).json({ error: 'Not authorized to send this message' });
    }

    const message = new ChatMessage({
      bookingId,
      hotelId,
      guestId,
      senderType,
      senderName,
      senderId: req.user.userId,
      messageText
    });

    await message.save();

    // Broadcast to clients watching this specific conversation (the shared, per-booking
    // chat stream) plus a lightweight ping on the shared events stream so the host's
    // conversation list (and the guest's own notification bell) know to refresh.
    broadcastMessage(bookingId, message);
    sendToHotel(hotelId, 'chat-message', { bookingId });
    sendToUser(guestId, 'chat-message', { bookingId });

    res.status(201).json({
      message: 'Message sent successfully',
      data: message
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
};

// Get chat history
export const getChatHistory = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const messages = await ChatMessage.find({ bookingId })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .exec();

    const total = await ChatMessage.countDocuments({ bookingId });

    res.json({
      messages: messages.reverse(),
      total,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error fetching chat history:', error);
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
};

// Get hotel chat history
export const getHotelChatHistory = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const hotel = await Hotel.findOne({ _id: hotelId, hostId: req.user.userId });
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    const messages = await ChatMessage.find({ hotelId })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .populate('guestId', 'firstName lastName')
      .populate('bookingId', 'roomId')
      .exec();

    const total = await ChatMessage.countDocuments({ hotelId });

    res.json({
      messages: messages.reverse(),
      total,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error fetching hotel chat history:', error);
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
};

// Get one row per conversation (booking) for a hotel's inbox view
export const getHotelConversations = async (req, res) => {
  try {
    const { hotelId } = req.params;

    const hotel = await Hotel.findOne({ _id: hotelId, hostId: req.user.userId });
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    const conversations = await ChatMessage.aggregate([
      { $match: { hotelId: hotel._id } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$bookingId',
          lastMessage: { $first: '$messageText' },
          lastMessageAt: { $first: '$createdAt' },
          lastSenderType: { $first: '$senderType' },
          guestId: { $first: '$guestId' },
          unreadCount: {
            $sum: {
              $cond: [{ $and: [{ $eq: ['$senderType', 'guest'] }, { $eq: ['$isRead', false] }] }, 1, 0]
            }
          }
        }
      },
      { $lookup: { from: 'users', localField: 'guestId', foreignField: '_id', as: 'guest' } },
      { $lookup: { from: 'bookings', localField: '_id', foreignField: '_id', as: 'booking' } },
      { $unwind: { path: '$guest', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$booking', preserveNullAndEmptyArrays: true } },
      { $sort: { lastMessageAt: -1 } },
      {
        $project: {
          bookingId: '$_id',
          guestId: 1,
          lastMessage: 1,
          lastMessageAt: 1,
          lastSenderType: 1,
          unreadCount: 1,
          guest: { firstName: 1, lastName: 1, email: 1 },
          booking: { roomId: 1, bookingReference: 1, checkInDate: 1, checkOutDate: 1 }
        }
      }
    ]);

    res.json({ conversations });
  } catch (error) {
    console.error('Error fetching hotel conversations:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
};

// SSE Endpoint - Stream messages
// EventSource can't set an Authorization header, so the token travels as a query param
export const streamMessages = async (req, res) => {
  const { bookingId } = req.params;
  const { token } = req.query;

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ error: 'Not authorized to access this stream' });
  }

  const booking = await Booking.findById(bookingId).populate('hotelId');
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  const isGuest = booking.userId && booking.userId.toString() === decoded.userId;
  const isHost = decoded.role === 'host' && booking.hotelId?.hostId?.toString() === decoded.userId;
  if (!isGuest && !isHost && decoded.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized to access this stream' });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Create connection object
  const connection = {
    res,
    bookingId,
    createdAt: Date.now()
  };

  // Store connection
  const connectionId = `${bookingId}-${Date.now()}`;
  sseConnections.set(connectionId, connection);

  // Send initial connection message
  res.write('data: {"type":"connected","message":"Connected to chat stream"}\n\n');

  // Handle client disconnect
  req.on('close', () => {
    sseConnections.delete(connectionId);
    res.end();
  });

  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
};

// Broadcast message to all SSE clients
function broadcastMessage(bookingId, message) {
  const messageData = JSON.stringify({
    type: 'new-message',
    data: message
  });

  sseConnections.forEach((connection, connectionId) => {
    if (connection.bookingId === bookingId) {
      try {
        connection.res.write(`data: ${messageData}\n\n`);
      } catch (error) {
        console.error('Error broadcasting to client:', error);
        sseConnections.delete(connectionId);
      }
    }
  });
}

// Mark messages as read
export const markMessagesAsRead = async (req, res) => {
  try {
    const { bookingId } = req.params;

    await ChatMessage.updateMany(
      { bookingId, isRead: false },
      { 
        isRead: true,
        readAt: new Date()
      }
    );

    res.json({ message: 'Messages marked as read' });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
};

// Get unread message count
export const getUnreadCount = async (req, res) => {
  try {
    const { bookingId } = req.params;

    const count = await ChatMessage.countDocuments({
      bookingId,
      isRead: false,
      senderType: 'hotel-staff'
    });

    res.json({ unreadCount: count });
  } catch (error) {
    console.error('Error getting unread count:', error);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
};

// Delete message (soft delete by marking)
export const deleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;

    const message = await ChatMessage.findByIdAndUpdate(
      messageId,
      { 
        messageText: '[Message deleted]',
        updatedAt: new Date()
      },
      { new: true }
    );

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ message: 'Message deleted', data: message });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
};

// Get active connections count
export const getConnectionStats = (req, res) => {
  res.json({
    activeConnections: sseConnections.size,
    connections: Array.from(sseConnections.entries()).map(([id, conn]) => ({
      id,
      bookingId: conn.bookingId,
      connectedSince: new Date(conn.createdAt)
    }))
  });
};

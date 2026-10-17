import mongoose from 'mongoose';

// Platform-support live chat between a host and the platform admin — mirrors ChatMessage
// (guest↔hotel-staff chat, models/Chat.js) but keyed by hostId instead of bookingId, since
// there's no booking tying the two sides together here. Each host has exactly one ongoing
// conversation with the platform (no per-topic threads), matching the same 1:1
// Hotel.hostId assumption every other host-scoped query in this codebase already makes.
const supportMessageSchema = new mongoose.Schema({
  hostId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel'
  },
  senderType: {
    type: String,
    enum: ['host', 'admin'],
    required: true
  },
  senderName: String,
  senderId: mongoose.Schema.Types.ObjectId,
  messageText: {
    type: String,
    required: true
  },
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: Date,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

supportMessageSchema.index({ hostId: 1, createdAt: -1 });

export default mongoose.model('SupportMessage', supportMessageSchema);

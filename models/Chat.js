import mongoose from 'mongoose';

const chatMessageSchema = new mongoose.Schema({
  // Conversation identifiers
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: true
  },
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true
  },
  guestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Message content
  senderType: {
    type: String,
    enum: ['guest', 'hotel-staff'],
    required: true
  },
  senderName: String,
  senderId: mongoose.Schema.Types.ObjectId,
  
  messageText: {
    type: String,
    required: true
  },
  
  // Media attachments (optional)
  attachments: [{
    type: String,
    url: String,
    fileName: String
  }],
  
  // Message metadata
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: Date,
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Index for faster queries
chatMessageSchema.index({ bookingId: 1, createdAt: -1 });
chatMessageSchema.index({ hotelId: 1, createdAt: -1 });
chatMessageSchema.index({ guestId: 1, createdAt: -1 });

// Pre-save middleware
chatMessageSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.model('ChatMessage', chatMessageSchema);

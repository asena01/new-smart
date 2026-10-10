import mongoose from 'mongoose';

// One reply on an incident's thread — embedded rather than a separate collection, since
// incident threads are low-volume (a handful of back-and-forth replies to resolve one
// issue), unlike the high-volume live chat in SupportMessage.
const incidentReplySchema = new mongoose.Schema({
  senderType: {
    type: String,
    enum: ['host', 'admin'],
    required: true
  },
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  senderName: String,
  message: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

// A tracked support ticket a host files against the platform — the "more robust" companion
// to SupportMessage's live chat: has a subject/category/priority/status lifecycle instead of
// being a free-flowing conversation, for issues that need to be followed up on rather than
// resolved in one sitting.
const supportIncidentSchema = new mongoose.Schema({
  hostId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel'
  },
  subject: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true
  },
  category: {
    type: String,
    enum: ['billing', 'technical', 'booking', 'device', 'other'],
    default: 'other'
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  status: {
    type: String,
    enum: ['open', 'in-progress', 'resolved', 'closed'],
    default: 'open'
  },
  replies: [incidentReplySchema],
  resolvedAt: Date
}, { timestamps: true });

supportIncidentSchema.index({ hostId: 1, createdAt: -1 });
supportIncidentSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('SupportIncident', supportIncidentSchema);

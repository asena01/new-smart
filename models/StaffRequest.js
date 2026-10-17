import mongoose from 'mongoose';

const staffRequestSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true
  },
  staffId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Staff',
    required: true
  },
  type: {
    type: String,
    enum: ['time-off', 'shift-change'],
    required: true
  },
  startDate: {
    type: Date,
    required: true
  },
  endDate: {
    type: Date,
    required: true
  },
  proposedShift: {
    startTime: String,
    endTime: String
  },
  reason: {
    type: String,
    required: true,
    trim: true
  },

  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  reviewNotes: String,
  reviewedAt: Date
}, { timestamps: true });

staffRequestSchema.index({ hotelId: 1, status: 1 });
staffRequestSchema.index({ staffId: 1, createdAt: -1 });

export default mongoose.model('StaffRequest', staffRequestSchema);

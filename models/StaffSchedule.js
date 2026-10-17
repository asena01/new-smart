import mongoose from 'mongoose';

const staffScheduleSchema = new mongoose.Schema({
  // References
  staffId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Staff',
    required: true
  },
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true
  },

  // Schedule Details
  scheduleType: {
    type: String,
    enum: ['recurring', 'one-time', 'on-call'],
    default: 'recurring'
  },

  // Recurring Schedule
  dayOfWeek: {
    type: [String],
    enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  },

  // One-time Schedule
  date: Date,

  // Time
  startTime: String, // HH:MM format
  endTime: String,   // HH:MM format
  breakTime: Number, // in minutes
  duration: Number,  // in hours

  // Additional Info
  shiftName: String, // e.g., "Morning Shift", "Night Shift"
  assignedAreas: [String], // Floors or specific areas
  notes: String,

  // Status
  status: {
    type: String,
    enum: ['scheduled', 'completed', 'cancelled', 'no-show'],
    default: 'scheduled'
  },
  isRecurring: {
    type: Boolean,
    default: true
  },
  recurrenceEndDate: Date,

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
staffScheduleSchema.index({ staffId: 1, date: 1 });
staffScheduleSchema.index({ hotelId: 1, date: 1 });

staffScheduleSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.model('StaffSchedule', staffScheduleSchema);

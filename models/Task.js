import mongoose from 'mongoose';

const taskSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true
  },
  // null while unassigned/claimable — see taskController.claimTask.
  staffId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Staff',
    default: null
  },
  assignedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  title: {
    type: String,
    required: true,
    trim: true
  },
  description: String,
  assignedRooms: [String],

  priority: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium'
  },
  dueDate: Date,

  // Lets completing a task drive a type-specific side effect elsewhere — currently only
  // 'cleaning' does anything (see taskController.updateTaskStatus, which syncs the room's
  // housekeepingStatus back to Front Desk when one of these is marked completed).
  category: {
    type: String,
    enum: ['cleaning', 'maintenance', 'general'],
    default: 'general'
  },

  status: {
    type: String,
    enum: ['pending', 'in-progress', 'completed', 'cancelled'],
    default: 'pending'
  },
  completedAt: Date,

  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

taskSchema.index({ hotelId: 1, status: 1 });
taskSchema.index({ staffId: 1, status: 1 });

taskSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.model('Task', taskSchema);

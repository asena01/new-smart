import mongoose from 'mongoose';

const staffSchema = new mongoose.Schema({
  // Basic Info
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  // Personal Info
  firstName: {
    type: String,
    required: true
  },
  lastName: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  phone: String,
  profileImage: String,

  // Employment Info
  position: {
    type: String,
    enum: ['receptionist', 'housekeeping', 'maintenance', 'security', 'manager', 'chef', 'bar-attendant', 'other'],
    required: true
  },
  department: String,
  employmentType: {
    type: String,
    enum: ['full-time', 'part-time', 'contract'],
    default: 'full-time'
  },
  salary: Number,
  joinDate: {
    type: Date,
    default: Date.now
  },

  // Access & Permissions
  permissions: {
    canManageStaff: { type: Boolean, default: false },
    canManageBookings: { type: Boolean, default: false },
    canManageOrders: { type: Boolean, default: false },
    canAccessRooms: { type: Boolean, default: true },
    canViewGuests: { type: Boolean, default: true }
  },

  // TTLock Key
  ttlockKeyId: String,
  ttlockKeyName: String,
  ttlockAccessLevel: String, // all-rooms, assigned-rooms, specific-rooms
  ttlockKeyStatus: {
    type: String,
    enum: ['active', 'inactive', 'revoked'],
    default: 'active'
  },
  keyGeneratedAt: Date,
  keyExpiresAt: Date,

  // Assigned Areas
  assignedRooms: [String], // Room numbers
  assignedFloors: [String], // Floor numbers

  // Status
  status: {
    type: String,
    enum: ['active', 'inactive', 'terminated'],
    default: 'active'
  },
  isAvailable: {
    type: Boolean,
    default: true
  },

  // Login Invitation
  invitationStatus: {
    type: String,
    enum: ['pending', 'accepted'],
    default: 'pending'
  },
  invitationTokenHash: String,
  invitationTokenExpires: Date,
  invitedAt: Date,

  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  terminatedAt: Date
});

// Index for faster queries
staffSchema.index({ hotelId: 1 });
staffSchema.index({ email: 1 });
staffSchema.index({ position: 1 });

staffSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.model('Staff', staffSchema);

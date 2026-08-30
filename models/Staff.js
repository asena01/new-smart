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
    enum: ['receptionist', 'housekeeping', 'maintenance', 'security', 'manager', 'chef', 'bar-attendant', 'waiter', 'other'],
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

  // Access & Permissions — role (position, above) picks a sensible starting set of these
  // (see backend/utils/staffPermissions.js), but they're stored and checked independently,
  // so a host can grant/revoke any individual capability regardless of position.
  permissions: {
    // Front-of-house
    canCheckInGuests: { type: Boolean, default: false },
    canManageReservations: { type: Boolean, default: false },
    canAccessRooms: { type: Boolean, default: true },
    // Operations
    canManageOrders: { type: Boolean, default: false },
    canPrepareOrders: { type: Boolean, default: false },
    canPrepareBarOrders: { type: Boolean, default: false },
    canDeliverOrders: { type: Boolean, default: false },
    canManageLaundry: { type: Boolean, default: false },
    canManageTransportation: { type: Boolean, default: false },
    canClaimTransportation: { type: Boolean, default: false },
    canManageGuestServices: { type: Boolean, default: false },
    canClaimHousekeepingTasks: { type: Boolean, default: false },
    canClaimMaintenanceTasks: { type: Boolean, default: false },
    canManageTasks: { type: Boolean, default: false },
    // Management-tier
    canManageStaff: { type: Boolean, default: false },
    canManageSchedules: { type: Boolean, default: false },
    canApproveRequests: { type: Boolean, default: false },
    canChangeHotelSettings: { type: Boolean, default: false }
  },

  // TTLock Key
  ttlockKeyId: String,
  // Which physical lock ttlockKeyId's eKey was actually issued against — TTLock's key/delete
  // API requires both lockId and keyId to revoke a key, so without this a termination or
  // Revoke Key action has no way to call the real API and can only ever flip our own DB flag.
  ttlockLockId: String,
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

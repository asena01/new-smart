import mongoose from 'mongoose';

// A digital door key a host gives one staff member for one room's lock, to use from the staff
// mobile app. Like a guest's key, it is NOT a TTLock eKey on the staff member's own account: the
// phone asks our server for the lock's data right before each unlock, and the server only hands
// it over while this record is active and inside its time window (see staffDoorKeyController.js).
// That is also what makes revoking instant — the next unlock attempt is simply refused.
const staffDoorKeySchema = new mongoose.Schema({
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', required: true },
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'SmartLockDevice', required: true },
  // Copied at grant time so lists still read sensibly if the lock is later moved to another room.
  roomNumber: { type: String, required: true },
  startsAt: { type: Date, default: Date.now },
  // null = valid until a host revokes it.
  expiresAt: { type: Date, default: null },
  status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  revokedAt: { type: Date, default: null },
  revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now }
});

staffDoorKeySchema.index({ staffId: 1, status: 1 });
staffDoorKeySchema.index({ hotelId: 1, status: 1 });
// Granting the same room again extends the existing key instead of creating a second one.
staffDoorKeySchema.index(
  { staffId: 1, deviceId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);

export default mongoose.model('StaffDoorKey', staffDoorKeySchema);

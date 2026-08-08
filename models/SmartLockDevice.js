import mongoose from 'mongoose';

const smartLockDeviceSchema = new mongoose.Schema({
  provider: {
    type: String,
    enum: ['ttlock', 'tuya'],
    required: true
  },
  deviceId: { type: String, required: true, trim: true },
  deviceName: { type: String, required: true, trim: true },
  clientId: { type: String, trim: true },
  region: { type: String, trim: true },
  location: { type: String, trim: true },
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', default: null },
  roomNumber: { type: String, default: null },
  connectionStatus: {
    type: String,
    enum: ['unknown', 'online', 'offline', 'error'],
    default: 'unknown'
  },
  lastError: { type: String, default: null },
  lastCheckedAt: { type: Date, default: null },
  batteryLevel: { type: Number, default: null },
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

smartLockDeviceSchema.index({ provider: 1 });

smartLockDeviceSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.model('SmartLockDevice', smartLockDeviceSchema);

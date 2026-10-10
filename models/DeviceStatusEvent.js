import mongoose from 'mongoose';

// One row per actual connectionStatus change (not per poll) — lets the Access Logs panel show
// "no data here, the device was offline" instead of a gap just silently looking like nothing
// happened. Written by both deviceMonitor.js's periodic poll and testConnection's manual
// check, for either provider — whichever one notices the status actually flip.
const deviceStatusEventSchema = new mongoose.Schema({
  device: { type: mongoose.Schema.Types.ObjectId, ref: 'SmartLockDevice', required: true },
  status: { type: String, enum: ['online', 'offline', 'error', 'unknown'], required: true },
  occurredAt: { type: Date, default: Date.now }
});

deviceStatusEventSchema.index({ device: 1, occurredAt: 1 });

export default mongoose.model('DeviceStatusEvent', deviceStatusEventSchema);

import mongoose from 'mongoose';

// Best-effort record of who triggered a remote lock/unlock through OUR OWN system —
// TTLock's own access log has no way to say this: every gateway-routed command we send shows
// up under our one shared service account, identical whether it was an admin, a host, a
// receptionist, or a guest's "let someone in" request. This is cross-referenced against
// TTLock's log by device + action + closest timestamp (see deviceController.getDeviceLogs's
// attachAccessAttribution) rather than being a source of truth on its own — TTLock's log stays
// authoritative on whether the door actually locked/unlocked.
const deviceAccessEventSchema = new mongoose.Schema({
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'SmartLockDevice', required: true },
  action: { type: String, enum: ['lock', 'unlock'], required: true },
  actorRole: { type: String, enum: ['admin', 'host', 'staff', 'guest'], required: true },
  // Denormalized at write time rather than populated later — the actor (a Staff record, a
  // User account) can be edited or deleted long after this event happened, and the log should
  // keep showing who it was at the time, not "(removed)".
  actorName: { type: String, required: true },
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },
  triggeredAt: { type: Date, default: Date.now }
});

deviceAccessEventSchema.index({ deviceId: 1, action: 1, triggeredAt: -1 });

export default mongoose.model('DeviceAccessEvent', deviceAccessEventSchema);

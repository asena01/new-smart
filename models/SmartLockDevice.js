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
  // TTLock-only: whether a gateway is currently bridging this lock to WiFi/cloud, so remote
  // (non-Bluetooth) lock/unlock commands can reach it. Not applicable to Tuya devices, which
  // connect directly over WiFi with no separate gateway concept in this integration.
  hasGateway: { type: Boolean, default: null },
  // The lock's own self-reported timestamp (TTLock's lockUpdateDate/electricQuantityUpdateDate),
  // not when WE last polled it — a gateway-connected lock that's gone dark (dead battery, out of
  // gateway range) keeps answering /lock/detail successfully with its last cached report forever,
  // so this is what actually detects staleness. See jobs/deviceMonitor.js.
  lastReportedAt: { type: Date, default: null },
  // Real gateway identity/signal for this lock, looked up by lockId (works even though the
  // gateway is registered to a different TTLock account) — refreshed on manual Test only, not
  // by the background poll, since it's a look-when-you-look detail, not worth extra API load
  // every 2 minutes for every device.
  gatewayName: { type: String, default: null },
  gatewaySignal: { type: Number, default: null },
  // TTLock-only, for the offline hotel-card scheme (E3 card encoder): arbitrary numbers an
  // admin assigns to place this lock in a building/floor hierarchy — not fetched from TTLock,
  // just written onto every card encoded for this lock (and once into the lock itself via the
  // Bluetooth APP SDK) so the lock can verify a card offline, with no gateway/cloud involved.
  buildingNumber: { type: Number, min: 0, max: 254, default: null },
  floorNumber: { type: Number, min: 0, max: 255, default: null },
  // Tuya-only: Tuya's own product category code (e.g. 'wg2' = Zigbee gateway, 'mcs' = contact
  // sensor) plus the two derived flags used to keep a Zigbee gateway from being presented as
  // an importable/manageable sensor alongside the real door/window sensors that connect
  // through it. Captured once at import time (from the discovery list, which reads these from
  // Tuya's API) rather than re-fetched live on every page load.
  category: { type: String, default: null },
  isGateway: { type: Boolean, default: false },
  isZigbeeSubDevice: { type: Boolean, default: false },
  // Tuya-only: which gateway (its own deviceId) this Zigbee sub-device is actually paired
  // through, resolved at import time via tuyaService.getSubDevices(gatewayId) — a sub-device's
  // own detail response only says `sub: true`, never which gateway. Null for standalone
  // devices and for the gateway device itself.
  gatewayDeviceId: { type: String, default: null },
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

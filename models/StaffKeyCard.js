import mongoose from 'mongoose';

// Tracks a physical IC card that's been authorized on a specific lock and handed to a staff
// member. Two independent encoding methods feed this same table:
//   'gateway' — the card's factory UID is registered with TTLock's cloud via identityCard/add
//     (see ttlockService.addIdentityCard); cardId is TTLock's own identifier for that cloud
//     authorization, needed to call identityCard/delete later. Only works on gateway/WiFi
//     locks, and revocation is instant.
//   'offline' — the card was physically encoded via the E3 card encoder (CardEncoder.dll,
//     see windows-card-encoder/), which writes the authorization directly onto the card; the
//     lock verifies it with no cloud/gateway involved. Works on Bluetooth-only locks too, but
//     has no cardId (nothing is registered in TTLock's cloud) and revoking it is NOT instant —
//     see revokeKeyCard's comment in staffKeyCardController.js.
const staffKeyCardSchema = new mongoose.Schema({
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', required: true },
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'SmartLockDevice', required: true },
  cardNumber: { type: String, required: true, trim: true },
  method: { type: String, enum: ['gateway', 'offline'], default: 'gateway' },
  cardId: { type: Number, default: null },
  cardName: { type: String, trim: true },
  startDate: { type: Date, default: null },
  endDate: { type: Date, default: null },
  status: {
    type: String,
    enum: ['active', 'revoked'],
    default: 'active'
  },
  issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  revokedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

staffKeyCardSchema.index({ staffId: 1, status: 1 });
staffKeyCardSchema.index({ hotelId: 1, status: 1 });

export default mongoose.model('StaffKeyCard', staffKeyCardSchema);

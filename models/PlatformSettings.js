import mongoose from 'mongoose';

const platformSettingsSchema = new mongoose.Schema({
  commissionRate: { type: Number, default: 0.1 },
  updatedAt: { type: Date, default: Date.now }
});

export default mongoose.model('PlatformSettings', platformSettingsSchema);

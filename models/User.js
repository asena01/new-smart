import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  firstName: {
    type: String,
    required: [true, 'First name is required'],
    trim: true,
  },
  lastName: {
    type: String,
    required: [true, 'Last name is required'],
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,})+$/, 'Please provide a valid email'],
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 6,
    select: false,
  },
  phone: {
    type: String,
    trim: true,
  },
  profileImage: {
    type: String,
    default: null,
  },
  isVerified: {
    type: Boolean,
    default: false,
  },
  identityVerificationStatus: {
    type: String,
    enum: ['pending', 'verified', 'rejected'],
    default: 'pending',
  },
  identityVerificationData: {
    diditWorkflowId: String,
    verificationDate: Date,
    expiryDate: Date,
  },
  role: {
    type: String,
    enum: ['guest', 'host', 'admin', 'staff'],
    default: 'guest',
  },
  // Platform-level account control (separate from Hotel.isActive, which only turns a
  // hotel's own listing on/off) — an admin suspending a host blocks that person from
  // logging in or using any existing session at all, regardless of what happens to their
  // hotel's listing.
  status: {
    type: String,
    enum: ['active', 'suspended', 'deleted'],
    default: 'active',
  },
  wishlist: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
  }],
  // One user can have several registered devices (phone + tablet, or a reinstall that gets a
  // fresh FCM token before the old one expires) — an array rather than a single field so none
  // of them get silently dropped. See utils/pushNotifications.js for how these get used, and
  // controllers/userController.js's registerDeviceToken/unregisterDeviceToken for how they're
  // added/removed.
  pushTokens: [{
    token: { type: String, required: true },
    platform: { type: String, enum: ['ios', 'android'], required: true },
    addedAt: { type: Date, default: Date.now },
  }],
  // Forgot-password flow (see authController's forgotPassword/resetPassword): a 6-digit code
  // is emailed and only its SHA-256 hash is stored, with an expiry and a wrong-guess counter so
  // the 1-in-a-million code can't be brute-forced within its 15-minute window.
  passwordReset: {
    codeHash: { type: String, select: false },
    expiresAt: { type: Date, select: false },
    attempts: { type: Number, default: 0, select: false },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

userSchema.methods.comparePassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

export default mongoose.model('User', userSchema);

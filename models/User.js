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
    enum: ['active', 'suspended'],
    default: 'active',
  },
  wishlist: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
  }],
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

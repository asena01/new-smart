import mongoose from 'mongoose';

const roomSchema = new mongoose.Schema({
  roomNumber: String,
  type: String,
  capacity: Number,
  basePrice: Number,
  discountPrice: Number, // optional discounted nightly rate shown to guests when set and lower than basePrice
  description: String,
  status: {
    type: String,
    enum: ['available', 'occupied', 'maintenance'],
    default: 'available',
  },
  housekeepingStatus: {
    type: String,
    enum: ['clean', 'dirty', 'inspected'],
    default: 'clean',
  },
  currency: {
    type: String,
    default: 'NGN',
  },
  images: [String],
  checkInType: {
    type: String,
    enum: ['standard', 'ttlock', 'tuya', 'both'],
    default: 'standard',
  },
  smartLockIntegration: {
    provider: {
      type: String,
      enum: ['ttlock', 'tuya', 'none'],
      default: 'none',
    },
    deviceId: String,
    clientId: String,
    isActive: {
      type: Boolean,
      default: false,
    },
  },
});

const hotelSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Hotel name is required'],
    trim: true,
  },
  description: {
    type: String,
    required: [true, 'Hotel description is required'],
  },
  category: {
    type: String,
    enum: ['5star', '4star', '3star', '2star', 'boutique'],
    default: '4star',
  },
  location: {
    address: {
      type: String,
      required: true,
    },
    city: {
      type: String,
      required: true,
    },
    country: {
      type: String,
      required: true,
    },
    postalCode: String,
    coordinates: {
      latitude: Number,
      longitude: Number,
    },
  },
  hostId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  images: [String],
  amenities: [String],
  rating: {
    type: Number,
    default: 0,
    min: 0,
    max: 5,
  },
  reviewCount: {
    type: Number,
    default: 0,
  },
  rooms: [roomSchema],
  policies: {
    checkInTime: {
      type: String,
      default: '15:00',
    },
    checkOutTime: {
      type: String,
      default: '11:00',
    },
    cancellationPolicy: String,
    refundable: Boolean,
  },
  isActive: {
    type: Boolean,
    default: true,
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

export default mongoose.model('Hotel', hotelSchema);

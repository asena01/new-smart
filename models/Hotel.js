import mongoose from 'mongoose';

const roomSchema = new mongoose.Schema({
  roomNumber: String,
  type: String,
  capacity: Number,
  basePrice: {
    type: Number,
    min: [0, 'Base price cannot be negative'],
  },
  // Optional discounted nightly rate shown to guests when set and lower than basePrice — 0
  // (or absent) means "no discount set", the same convention the room-management UI already
  // uses, not a literal free room.
  discountPrice: {
    type: Number,
    min: [0, 'Discount price cannot be negative'],
    validate: {
      validator: function (value) {
        if (value == null || value === 0) return true;
        return value < this.basePrice;
      },
      message: 'Discount price must be lower than the base price',
    },
  },
  description: String,
  // The host's own sellability intent — separate from occupancy/reservation, which are
  // derived from actual bookings (see attachRoomOccupancy in hotelController.js), and
  // separate from each other: Out of Order (OOO) means the room cannot be sold or used at
  // all (e.g. structural damage); Out of Service (OOS) means it's only temporarily
  // unavailable (e.g. awaiting a minor repair or inspection) — a lesser, shorter-lived block
  // than OOO. 'occupied' and 'maintenance' are legacy values kept only so older rooms that
  // still hold them don't break; new writes always use one of the first three.
  status: {
    type: String,
    enum: ['available', 'out-of-order', 'out-of-service', 'occupied', 'maintenance'],
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
    // IANA timezone used to interpret the wall-clock policy times above. UTC remains the
    // compatibility fallback for existing hotel documents until the host saves a timezone.
    timeZone: {
      type: String,
      default: 'UTC',
    },
    // Earliest/latest time-of-day a paid early-checkin/late-checkout order can move a
    // guest's effective key window to. Unset = the hotel doesn't bound these paid requests.
    earlyCheckInFrom: String,
    lateCheckOutUntil: String,
    // Legacy early-checkin hourly field retained for old hotel records. New settings use
    // earlyCheckInFee as one fixed charge. Late checkout remains hourly.
    earlyCheckInRatePerHour: {
      type: Number,
      default: 0,
    },
    earlyCheckInFee: {
      type: Number,
      default: 0,
      min: 0,
    },
    lateCheckOutRatePerHour: {
      type: Number,
      default: 0,
    },
    autoCheckoutEnabled: {
      type: Boolean,
      default: true,
    },
    // Minutes past the effective checkout deadline before the scheduler auto-checks a
    // guest out and revokes their key — absorbs clock drift/a guest running a few minutes late.
    autoCheckoutGraceMinutes: {
      type: Number,
      default: 15,
      min: 0,
      max: 180,
    },
    cancellationPolicy: String,
    refundable: Boolean,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  // Set only by an admin (see PATCH /hotels/:id/payment-subaccount) after creating the
  // subaccount directly on Flutterwave's own merchant dashboard — never host-writable, since
  // updateHotel strips this field out of the request body before saving. Null means bookings
  // at this hotel still go 100% to the platform's own Flutterwave account (today's behavior).
  flutterwaveSubaccountId: {
    type: String,
    default: null,
  },
  // Host-submitted (see PATCH /hotels/:id/bank-details) so an admin has what they need to
  // actually create the Flutterwave subaccount above — this is the hotel's own bank details,
  // not payment credentials, so it's fine for the host to set/update it themselves. Never
  // returned by the public hotel endpoints (getAllHotels/getHotelById/searchHotels) —
  // explicitly excluded there alongside flutterwaveSubaccountId.
  bankDetails: {
    bankName: String,
    accountNumber: String,
    accountName: String,
    submittedAt: Date,
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

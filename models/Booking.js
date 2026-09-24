import mongoose from 'mongoose';

const bookingSchema = new mongoose.Schema({
  bookingReference: {
    type: String,
    unique: true,
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  // Guest contact info for reception/walk-in bookings with no user account
  guestName: String,
  guestEmail: String,
  guestPhone: String,
  source: {
    type: String,
    enum: ['guest-portal', 'host-reception'],
    default: 'guest-portal',
  },
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
  },
  roomId: String,
  checkInDate: {
    type: Date,
    required: true,
  },
  checkOutDate: {
    type: Date,
    required: true,
  },
  numberOfGuests: Number,
  specialRequests: String,
  totalPrice: {
    type: Number,
    required: true,
  },
  currency: {
    type: String,
    default: 'NGN',
  },
  status: {
    type: String,
    enum: ['confirmed', 'pending', 'cancelled', 'completed'],
    default: 'pending',
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'refunded'],
    default: 'pending',
  },
  paymentMethod: {
    type: String,
    enum: ['stripe', 'paypal', 'credit_card', 'flutterwave', 'cash'],
  },
  paymentId: String,
  contactlessCheckIn: {
    enabled: {
      type: Boolean,
      default: false,
    },
    smartLockCode: String,
    // TTLock's numeric IDs for the passcode/eKey above — needed to revoke either one
    // early (e.g. on checkout before the original check-out date), since TTLock's delete
    // endpoints target these IDs, not the passcode string or email itself.
    keyboardPwdId: Number,
    ekeyId: Number,
    accessToken: String,
    expiryTime: Date,
    diditSessionId: String,
    ekeySent: Boolean,
    ekeyError: String,
  },
  checkInInfo: {
    actualCheckInTime: Date,
    lockUnlockedAt: Date,
    guestVerified: Boolean,
    // Set once a paid early-checkin ServiceOrder is confirmed — the effective start of the
    // guest's key window, in place of the hotel's standard checkInTime. Actual key issuance
    // still waits for the room to be marked ready (see serviceOrderController.js).
    approvedEarlyCheckInTime: Date,
    // True while an approved early check-in is waiting on the room to actually be marked
    // ready — cleared once the key is issued for the early time (see updateRoom's
    // housekeeping-status hook in hotelController.js).
    pendingRoomReady: Boolean,
  },
  checkOutInfo: {
    actualCheckOutTime: Date,
    // Set once a paid late-checkout ServiceOrder is confirmed — the effective checkout
    // deadline the auto-checkout scheduler and key window use instead of the hotel's
    // standard checkOutTime.
    approvedLateCheckOutTime: Date,
    // True when the auto-checkout scheduler (not a front-desk action) performed the checkout.
    autoCheckedOut: Boolean,
  },
  cancellationReason: String,
  cancellationDate: Date,
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Must run pre-validate, not pre-save: bookingReference is required, and
// Mongoose runs schema validation before pre-save hooks fire.
bookingSchema.pre('validate', function(next) {
  if (!this.bookingReference) {
    this.bookingReference = `BK-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
  }
  next();
});

bookingSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.model('Booking', bookingSchema);

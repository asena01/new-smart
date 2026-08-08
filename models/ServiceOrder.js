import mongoose from 'mongoose';

const serviceOrderSchema = new mongoose.Schema({
  // Basic Info
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: true
  },
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true
  },
  guestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  // Staff member responsible for fulfilling this order. Must be set before the
  // order's status can move past 'pending' — see updateServiceOrderStatus.
  staffId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Staff',
    default: null
  },

  // Service Type
  serviceType: {
    type: String,
    enum: ['restaurant', 'bar', 'laundry', 'transportation', 'early-checkin', 'late-checkout', 'room-upgrade', 'custom'],
    required: true
  },
  
  // Service Details (varies by service type)
  serviceDetails: {
    // For restaurant/bar
    items: [{
      itemId: String,
      name: String,
      quantity: Number,
      price: Number,
      specialRequests: String
    }],
    
    // For laundry
    laundryItems: [{
      itemType: String, // shirt, pants, dress, etc.
      quantity: Number,
      price: Number
    }],
    serviceLevel: String, // standard, express, same-day
    
    // For transportation
    serviceOption: String, // airport, city-tour, restaurant, shopping, business
    pickupLocation: String,
    destination: String,
    pickupDate: Date,
    pickupTime: String,
    passengers: Number,
    luggage: Number,
    
    // For early check-in
    requestedTime: String,
    standardTime: String,
    
    // For room upgrade
    currentRoom: String,
    upgradedRoom: String,
    newRoomType: String,
    newRoomNumber: String,
    currentRoomPrice: Number,
    newRoomPrice: Number,
    nights: Number,

    // For custom (host-defined) services
    customServiceId: mongoose.Schema.Types.ObjectId,
    customServiceName: String,
    requiresScheduling: Boolean,
    scheduledDate: String,
    scheduledTime: String,
    durationHours: Number,
    quantity: Number
  },
  
  // Pricing
  subtotal: {
    type: Number,
    required: true
  },
  tax: {
    type: Number,
    default: 0
  },
  total: {
    type: Number,
    required: true
  },
  
  // Status
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'preparing', 'in-progress', 'ready', 'completed', 'cancelled', 'delivered'],
    default: 'pending'
  },
  
  // Special Requests
  specialRequests: String,
  
  // Payment
  paymentMethod: String,
  paymentStatus: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'pending'
  },
  paidAt: Date,

  // Estimated time the order should be ready/fulfilled by, computed at creation time
  estimatedReadyAt: Date,

  // Laundry-specific: when housekeeping is expected to collect the dirty laundry — a
  // loose ~1hr window from order time rather than a guest-picked specific time slot.
  estimatedPickupAt: Date,

  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  completedAt: Date,
  
  // Revenue tracking
  revenueRecorded: {
    type: Boolean,
    default: false
  }
});

// Update timestamp on save
serviceOrderSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.model('ServiceOrder', serviceOrderSchema);

import mongoose from 'mongoose';

const serviceCatalogItemSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true
  },
  serviceType: {
    type: String,
    enum: ['restaurant', 'bar', 'laundry', 'transportation', 'early-checkin', 'late-checkout', 'room-upgrade', 'custom'],
    required: true
  },

  name: {
    type: String,
    required: true,
    trim: true
  },
  description: String,
  category: String, // e.g. Appetizers/Cocktails for restaurant+bar, 'service-level' for laundry surcharges
  icon: String, // emoji shown in guest-facing cards

  price: {
    type: Number,
    required: true,
    min: [0, 'Price cannot be negative']
  },
  // Optional discounted price shown to guests instead of `price` when set and lower — 0 (or
  // absent) means "no discount set", not a literal free item.
  discountPrice: {
    type: Number,
    min: [0, 'Discount price cannot be negative'],
    validate: {
      validator: function (value) {
        if (value == null || value === 0) return true;
        return value < this.price;
      },
      message: 'Discount price must be lower than the price'
    }
  },
  currency: {
    type: String,
    default: 'NGN'
  },
  images: [String],

  // Type-specific extras (only relevant fields are set per serviceType)
  prepTime: Number,        // restaurant/bar: minutes
  capacity: Number,        // room-upgrade: max guests
  perPassengerFee: Number, // transportation: extra fee per passenger beyond the first
  perLuggageFee: Number,   // transportation: extra fee per luggage item
  vehicleCapacity: Number, // transportation: max passengers this vehicle can carry
  timeSlot: String,        // early-checkin/late-checkout: 24h "HH:MM" the slot actually falls at

  // custom: when true, guests book this service for a specific date/time/duration
  // (e.g. Conference Room Rental) and `price` is treated as an hourly rate rather
  // than a flat fee.
  requiresScheduling: {
    type: Boolean,
    default: false
  },

  isAvailable: {
    type: Boolean,
    default: true
  },
  sortOrder: {
    type: Number,
    default: 0
  },

  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

serviceCatalogItemSchema.index({ hotelId: 1, serviceType: 1, sortOrder: 1 });

serviceCatalogItemSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.model('ServiceCatalogItem', serviceCatalogItemSchema);

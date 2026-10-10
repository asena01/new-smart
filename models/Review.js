import mongoose from 'mongoose';

const reviewSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: true,
  },
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5,
  },
  cleanliness: Number,
  comfort: Number,
  amenities: Number,
  staff: Number,
  value: Number,
  title: String,
  comment: String,
  images: [String],
  helpful: {
    type: Number,
    default: 0,
  },
  hostReply: {
    text: String,
    respondedAt: Date,
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

// A guest may only review a given hotel once, ever — enforced at the DB level so a race
// between two concurrent requests can't both succeed (the controller also checks this
// up front for a friendlier error message, but this index is the actual guarantee).
reviewSchema.index({ userId: 1, hotelId: 1 }, { unique: true });

export default mongoose.model('Review', reviewSchema);

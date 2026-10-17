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

// A guest may review each booking once — enforced at the DB level so a race between two
// concurrent requests can't both succeed (the controller also checks up front for a friendlier
// error message, but this index is the actual guarantee). It used to be one review per guest per
// hotel, which stopped someone who stayed twice from reviewing the second stay; that older unique
// index is dropped at startup if present (see utils/reviewIndexMigration.js).
// Partial so it only covers documents that actually have both fields: this database's reviews
// collection also holds older records with no guest or booking at all, which would otherwise all
// collide on "null/null" and stop the index from being built.
reviewSchema.index(
  { userId: 1, bookingId: 1 },
  { unique: true, partialFilterExpression: { userId: { $exists: true }, bookingId: { $exists: true } } }
);
reviewSchema.index({ hotelId: 1, createdAt: -1 });

export default mongoose.model('Review', reviewSchema);

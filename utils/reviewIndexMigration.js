import Review from '../models/Review.js';

// Reviews used to be unique per (guest, hotel); they are now unique per (guest, booking). Mongoose
// creates the new index on its own but never removes an old one, and the old one would keep
// rejecting a guest's second review at the same hotel — so it is dropped here, once. Safe to run
// on every start: if the index is already gone, that is the expected outcome and nothing happens.
export async function migrateReviewIndexes() {
  try {
    await Review.collection.dropIndex('userId_1_hotelId_1');
    console.log('✅ Dropped the old one-review-per-hotel index');
  } catch (error) {
    if (error.codeName !== 'IndexNotFound' && error.code !== 27 && !/index not found/i.test(error.message || '')) {
      console.error('Review index migration skipped:', error.message);
    }
  }
  try {
    await Review.createIndexes();
  } catch (error) {
    console.error('Review index creation failed:', error.message);
  }
}

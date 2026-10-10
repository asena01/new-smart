import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Hotel from '../models/Hotel.js';

dotenv.config();

if (!process.env.MONGODB_URI) {
  throw new Error('MONGODB_URI is required.');
}

await mongoose.connect(process.env.MONGODB_URI);

try {
  // The current application dataset is Nigeria-based. Keep this migration deliberately
  // country-scoped instead of guessing timezones for hotels elsewhere.
  const result = await Hotel.updateMany(
    { 'location.country': /^Nigeria$/i },
    {
      $set: {
        'policies.timeZone': 'Africa/Lagos',
        'policies.autoCheckoutGraceMinutes': 15
      }
    }
  );

  console.log(`Matched ${result.matchedCount} Nigerian hotel(s); updated ${result.modifiedCount}.`);
} finally {
  await mongoose.disconnect();
}

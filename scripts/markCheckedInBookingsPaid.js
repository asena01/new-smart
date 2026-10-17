// One-off backfill — NOT wired into the API. Run manually:
//
//   node scripts/markCheckedInBookingsPaid.js            (dry run: only lists what it would change)
//   node scripts/markCheckedInBookingsPaid.js --confirm  (actually changes it)
//
// The front desk checks a guest in once their payment is confirmed, so a booking that has been
// checked in is paid. Bookings checked in before the server started recording that still read
// "payment pending" (and so show no receipt). This marks them completed, with the payment method
// left as it was or set to bank_transfer if it was never set.
//
// Only touches: not cancelled, has a real check-in time, payment status pending or failed.

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Booking from '../models/Booking.js';

dotenv.config();

async function main() {
  const confirm = process.argv.includes('--confirm');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to: ${mongoose.connection.name}`);

  const filter = {
    status: { $ne: 'cancelled' },
    'checkInInfo.actualCheckInTime': { $ne: null },
    paymentStatus: { $in: ['pending', 'failed'] }
  };
  const bookings = await Booking.find(filter).select('bookingReference paymentStatus paymentMethod totalPrice currency');
  console.log(`${bookings.length} checked-in booking(s) still marked unpaid.`);
  bookings.slice(0, 50).forEach(b => console.log(`  ${b.bookingReference}  ${b.paymentStatus}  ${b.currency} ${b.totalPrice}`));

  if (!confirm) {
    console.log('\nDry run — nothing changed. Re-run with --confirm to mark them paid.');
  } else {
    const noMethod = await Booking.updateMany({ ...filter, $or: [{ paymentMethod: null }, { paymentMethod: { $exists: false } }] }, { $set: { paymentMethod: 'bank_transfer' } });
    const result = await Booking.updateMany(filter, { $set: { paymentStatus: 'completed' } });
    console.log(`\nMarked ${result.modifiedCount} booking(s) paid (${noMethod.modifiedCount} also had no payment method set).`);
  }
  await mongoose.disconnect();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

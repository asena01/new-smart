// One-off cleanup utility — NOT wired into the API. Run manually from your own machine:
//
//   node scripts/deleteAllGuestData.js
//   node scripts/deleteAllGuestData.js --confirm
//
// Without --confirm it only prints what it *would* delete (dry run). Pass --confirm
// to actually delete. Deletes EVERY guest account, no exceptions — this includes guests
// with real booking/review/order history, not just empty test signups.
//
// Deletes:
//   - Every User document with role: 'guest'
//   - Booking documents for those guests (userId)
//   - ServiceOrder / Chat documents for those guests (guestId)
//   - Review documents for those guests (userId), then resets rating/reviewCount to 0 on
//     every hotel that had one of those reviews (since every review is guest-authored,
//     once all guest reviews are gone the hotel genuinely has zero reviews left)
//   - Notification documents for those guests (userId)
//
// Does NOT touch: Staff/Task/Attendance/StaffRequest data (unrelated to guests — see
// deleteAllStaffData.js for that), or the legacy/unused "prearrivalcheckins",
// "smartaccessgrants", or "finances" collections (no current model or controller code
// references any of them, so nothing in the live app reads or writes them).

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Booking from '../models/Booking.js';
import ServiceOrder from '../models/ServiceOrder.js';
import Review from '../models/Review.js';
import Chat from '../models/Chat.js';
import Notification from '../models/Notification.js';
import Hotel from '../models/Hotel.js';

dotenv.config();

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    args[key] = rest.length ? rest.join('=').replace(/^"|"$/g, '') : true;
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const confirm = Boolean(args.confirm);

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to: ${mongoose.connection.name}`);

  const guests = await User.find({ role: 'guest' }).select('_id firstName lastName email');
  const guestIds = guests.map(g => g._id);

  const [bookingCount, serviceOrderCount, reviews, chatCount, notificationCount] = await Promise.all([
    Booking.countDocuments({ userId: { $in: guestIds } }),
    ServiceOrder.countDocuments({ guestId: { $in: guestIds } }),
    Review.find({ userId: { $in: guestIds } }).select('hotelId'),
    Chat.countDocuments({ guestId: { $in: guestIds } }),
    Notification.countDocuments({ userId: { $in: guestIds } })
  ]);

  const affectedHotelIds = [...new Set(reviews.map(r => String(r.hotelId)))];

  console.log(`\nFound:`);
  console.log(`  ${guestIds.length} guest accounts`);
  guests.slice(0, 20).forEach(g => console.log(`    - ${g.firstName} ${g.lastName} <${g.email}>`));
  if (guests.length > 20) console.log(`    ... and ${guests.length - 20} more`);
  console.log(`  ${bookingCount} bookings`);
  console.log(`  ${serviceOrderCount} service orders`);
  console.log(`  ${reviews.length} reviews (across ${affectedHotelIds.length} hotels — those hotels' rating/reviewCount will reset to 0)`);
  console.log(`  ${chatCount} chat messages`);
  console.log(`  ${notificationCount} notifications`);

  if (!confirm) {
    console.log('\nDry run only — nothing deleted. Re-run with --confirm to actually delete.');
    await mongoose.disconnect();
    return;
  }

  const [bookingResult, serviceOrderResult, reviewResult, chatResult, notificationResult, userResult] = await Promise.all([
    Booking.deleteMany({ userId: { $in: guestIds } }),
    ServiceOrder.deleteMany({ guestId: { $in: guestIds } }),
    Review.deleteMany({ userId: { $in: guestIds } }),
    Chat.deleteMany({ guestId: { $in: guestIds } }),
    Notification.deleteMany({ userId: { $in: guestIds } }),
    User.deleteMany({ role: 'guest' })
  ]);

  if (affectedHotelIds.length) {
    await Hotel.updateMany(
      { _id: { $in: affectedHotelIds } },
      { $set: { rating: 0, reviewCount: 0 } }
    );
  }

  console.log('\nDeleted:');
  console.log(`  ${userResult.deletedCount} guest accounts`);
  console.log(`  ${bookingResult.deletedCount} bookings`);
  console.log(`  ${serviceOrderResult.deletedCount} service orders`);
  console.log(`  ${reviewResult.deletedCount} reviews`);
  console.log(`  ${chatResult.deletedCount} chat messages`);
  console.log(`  ${notificationResult.deletedCount} notifications`);
  console.log(`  Reset rating/reviewCount to 0 on ${affectedHotelIds.length} hotels`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

// One-off cleanup utility — NOT wired into the API. Run manually from your own machine:
//
//   node scripts/cleanup-hotel-bookings.js --hotel-name="grand hotel"
//   node scripts/cleanup-hotel-bookings.js --hotel-name="grand hotel" --confirm
//
// Without --confirm it only prints what it *would* delete (dry run). Pass --confirm
// to actually delete. Scoped to a single hotel so it can't touch other hosts' data.
//
// Deletes, for the matched hotel only:
//   - Booking documents
//   - ServiceOrder / Review / Chat documents that reference one of those bookings
// Then resets every room on the hotel back to status: 'available', housekeepingStatus: 'clean'.

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Hotel from '../models/Hotel.js';
import User from '../models/User.js'; // registers the 'User' model so Hotel.populate('hostId') resolves
import Booking from '../models/Booking.js';
import ServiceOrder from '../models/ServiceOrder.js';
import Review from '../models/Review.js';
import Chat from '../models/Chat.js';

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

  if (!args['hotel-id'] && !args['hotel-name']) {
    console.error('Usage: node cleanup-hotel-bookings.js --hotel-name="..." [--confirm]');
    console.error('   or: node cleanup-hotel-bookings.js --hotel-id=<id> [--confirm]');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  let hotel;
  if (args['hotel-id']) {
    hotel = await Hotel.findById(args['hotel-id']).populate('hostId', 'email firstName lastName');
    if (!hotel) {
      console.error(`No hotel found with id ${args['hotel-id']}`);
      process.exit(1);
    }
  } else {
    const matches = await Hotel.find({ name: { $regex: args['hotel-name'], $options: 'i' } })
      .populate('hostId', 'email firstName lastName');
    if (matches.length === 0) {
      console.error(`No hotel name matches "${args['hotel-name']}"`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`Multiple hotels match "${args['hotel-name']}" — re-run with --hotel-id instead:`);
      matches.forEach(h => console.error(`  ${h._id}  ${h.name}  (host: ${h.hostId?.email || 'unknown'})`));
      process.exit(1);
    }
    hotel = matches[0];
  }

  console.log(`Target hotel: "${hotel.name}" (${hotel._id})`);
  console.log(`Host: ${hotel.hostId?.email || 'unknown'}`);

  const bookings = await Booking.find({ hotelId: hotel._id }).select('_id');
  const bookingIds = bookings.map(b => b._id);

  const [serviceOrderCount, reviewCount, chatCount] = await Promise.all([
    ServiceOrder.countDocuments({ bookingId: { $in: bookingIds } }),
    Review.countDocuments({ bookingId: { $in: bookingIds } }),
    Chat.countDocuments({ bookingId: { $in: bookingIds } })
  ]);

  console.log(`\nFound:`);
  console.log(`  ${bookingIds.length} bookings`);
  console.log(`  ${serviceOrderCount} service orders`);
  console.log(`  ${reviewCount} reviews`);
  console.log(`  ${chatCount} chat messages`);
  console.log(`  ${hotel.rooms.length} rooms will have status/housekeepingStatus reset`);

  if (!confirm) {
    console.log('\nDry run only — nothing deleted. Re-run with --confirm to actually delete.');
    await mongoose.disconnect();
    return;
  }

  const [serviceOrderResult, reviewResult, chatResult, bookingResult] = await Promise.all([
    ServiceOrder.deleteMany({ bookingId: { $in: bookingIds } }),
    Review.deleteMany({ bookingId: { $in: bookingIds } }),
    Chat.deleteMany({ bookingId: { $in: bookingIds } }),
    Booking.deleteMany({ hotelId: hotel._id })
  ]);

  await Hotel.updateOne(
    { _id: hotel._id },
    { $set: { 'rooms.$[].status': 'available', 'rooms.$[].housekeepingStatus': 'clean' } }
  );

  console.log('\nDeleted:');
  console.log(`  ${bookingResult.deletedCount} bookings`);
  console.log(`  ${serviceOrderResult.deletedCount} service orders`);
  console.log(`  ${reviewResult.deletedCount} reviews`);
  console.log(`  ${chatResult.deletedCount} chat messages`);
  console.log('Room statuses reset to available/clean.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

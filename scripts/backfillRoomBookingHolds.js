// One-off migration — NOT wired into the API. Run once, manually, after deploying the
// RoomBookingHold-based booking-conflict fix (backend/controllers/bookingController.js):
//
//   node scripts/backfillRoomBookingHolds.js
//   node scripts/backfillRoomBookingHolds.js --confirm
//
// Without --confirm it only prints what it *would* insert (dry run). Pass --confirm to
// actually insert.
//
// Why this is needed: createBooking/createWalkInBooking now enforce "no double-booking" via
// RoomBookingHold's unique (hotelId, roomId, night) index, inserted atomically alongside each
// new Booking. Every booking that existed BEFORE that change has no corresponding holds, so a
// brand-new booking racing against one of them would only be caught by the non-atomic
// findOne fast-path (see the comment in createBooking), not by the unique index. This script
// closes that gap once by backfilling holds for every currently-active (non-cancelled,
// non-completed) booking, so the atomic guarantee covers the whole active booking set going
// forward. Safe to re-run — it skips any booking that already has holds.

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import RoomBookingHold from '../models/RoomBookingHold.js';
import { nightsBetween } from '../controllers/bookingController.js';

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
  const confirm = Boolean(parseArgs().confirm);

  await mongoose.connect(process.env.MONGODB_URI);

  // 'completed' bookings still occupy their booked range for the same reason the overlap
  // query in bookingController.js excludes only 'cancelled' — an early checkout doesn't free
  // up the remaining originally-booked nights.
  const activeBookings = await Booking.find({ status: { $ne: 'cancelled' } })
    .select('_id hotelId roomId checkInDate checkOutDate');

  let toInsert = 0;
  let alreadyHeld = 0;
  let inserted = 0;

  for (const booking of activeBookings) {
    const existing = await RoomBookingHold.countDocuments({ bookingId: booking._id });
    if (existing > 0) {
      alreadyHeld++;
      continue;
    }

    const holds = nightsBetween(new Date(booking.checkInDate), new Date(booking.checkOutDate))
      .map(night => ({ hotelId: booking.hotelId, roomId: booking.roomId, night, bookingId: booking._id }));
    toInsert += holds.length;

    if (confirm) {
      // Two legacy bookings that already (incorrectly) overlap would collide here — that's
      // an existing data problem this script surfaces rather than silently papering over.
      // insertMany with ordered:false lets unrelated bookings keep backfilling past one
      // failure instead of aborting the whole run.
      try {
        await RoomBookingHold.insertMany(holds, { ordered: false });
        inserted++;
      } catch (error) {
        console.error(`Booking ${booking._id} (room ${booking.roomId}): failed to backfill holds — ${error.message}`);
      }
    }
  }

  console.log(`Active bookings: ${activeBookings.length}`);
  console.log(`Already backfilled: ${alreadyHeld}`);
  console.log(`${confirm ? 'Inserted' : 'Would insert'} holds for: ${activeBookings.length - alreadyHeld} bookings (${toInsert} night-holds)`);
  if (!confirm) {
    console.log('\nDry run only — nothing inserted. Re-run with --confirm to actually insert.');
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

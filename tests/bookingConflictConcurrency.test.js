// Regression tests for booking-conflict concurrency safety
// (backend/controllers/bookingController.js, backend/models/RoomBookingHold.js).
//
// Bug this guards against: createBooking/createWalkInBooking ran a plain findOne overlap
// check followed by a separate Booking.create, with no atomicity or DB-level uniqueness
// between the two. Two near-simultaneous requests for the same room/date range (e.g. one
// online, one front-desk) could both pass the findOne check before either had written its
// booking, and both would then succeed — double-booking the room. The fix adds a
// RoomBookingHold collection with a unique (hotelId, roomId, night) index and inserts one
// hold per night inside the same transaction as the Booking.create, so the second of two
// racing requests always gets a real duplicate-key error instead of a false "no conflict"
// (see reserveRoomNights/runInTransaction in bookingController.js/utils/transactionUtils.js).
//
// Hits a real MongoDB for the same reason as the other tests in this directory — and this
// fix specifically requires a genuine replica-set-backed MongoDB, since multi-document
// transactions aren't supported on a standalone mongod. The shared Atlas test_copy database
// is a replica set, so this works there; it will NOT work against a bare local `mongod`.
// Creates and deletes its own Hotel/Booking/RoomBookingHold/User documents, but MONGODB_URI
// must still point at the isolated test_copy database.
//
// Run with (from backend/):
//   MONGODB_URI="<atlas-uri>/test_copy" node --test tests/bookingConflictConcurrency.test.js

import { test, before, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI || !MONGO_URI.includes('test_copy')) {
  throw new Error(
    'Refusing to run: these tests create and delete real Hotel/Booking/User documents, so ' +
    'MONGODB_URI must point at the isolated test_copy database, never the production "test" ' +
    'database. Run: MONGODB_URI="<your-atlas-uri>/test_copy" node --test tests/bookingConflictConcurrency.test.js'
  );
}

const mongoose = (await import('mongoose')).default;
const { default: Hotel } = await import('../models/Hotel.js');
const { default: Booking } = await import('../models/Booking.js');
const { default: User } = await import('../models/User.js');
const { default: RoomBookingHold } = await import('../models/RoomBookingHold.js');
const { createBooking, createWalkInBooking, cancelBooking } = await import('../controllers/bookingController.js');

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    }
  };
  return res;
}

const hostId = new mongoose.Types.ObjectId();
let hotel;

before(async () => {
  await mongoose.connect(MONGO_URI);
  hotel = await Hotel.create({
    name: 'Concurrency Test Hotel',
    description: 'desc',
    location: { address: '1 St', city: 'Lagos', country: 'Nigeria' },
    hostId,
    rooms: [
      { roomNumber: 'room-1', type: 'Standard', capacity: 2, basePrice: 100, currency: 'NGN' },
      { roomNumber: 'room-2', type: 'Standard', capacity: 2, basePrice: 100, currency: 'NGN' }
    ]
  });
});

afterEach(async () => {
  const bookingIds = (await Booking.find({ hotelId: hotel._id }).select('_id')).map(b => b._id);
  await RoomBookingHold.deleteMany({ bookingId: { $in: bookingIds } });
  await Booking.deleteMany({ hotelId: hotel._id });
  await User.deleteMany({ email: /^concurrency-test-.*@example\.com$/ });
});

after(async () => {
  await Hotel.deleteOne({ _id: hotel._id });
  await mongoose.disconnect();
});

function bookingReq(overrides = {}) {
  return {
    body: {
      hotelId: hotel._id.toString(),
      roomId: 'room-1',
      checkInDate: '2027-03-01',
      checkOutDate: '2027-03-04',
      numberOfGuests: 1,
      ...overrides
    },
    user: { userId: new mongoose.Types.ObjectId().toString(), role: 'guest' }
  };
}

test('two concurrent online bookings for the same room/dates: exactly one succeeds', async () => {
  const res1 = fakeRes();
  const res2 = fakeRes();

  await Promise.all([
    createBooking(bookingReq(), res1),
    createBooking(bookingReq(), res2)
  ]);

  const statuses = [res1.statusCode, res2.statusCode].sort();
  assert.deepEqual(statuses, [201, 409], `expected one 201 and one 409, got ${JSON.stringify(statuses)}: ${JSON.stringify([res1.body, res2.body])}`);

  const winner = res1.statusCode === 201 ? res1 : res2;
  const loser = res1.statusCode === 201 ? res2 : res1;
  assert.match(loser.body.message, /already booked/i);

  const activeBookings = await Booking.find({ hotelId: hotel._id, roomId: 'room-1', status: { $ne: 'cancelled' } });
  assert.equal(activeBookings.length, 1, 'only one booking should have been persisted');
  assert.equal(String(activeBookings[0]._id), String(winner.body.booking._id));

  const holds = await RoomBookingHold.find({ hotelId: hotel._id, roomId: 'room-1' });
  assert.equal(holds.length, 3, 'the 3-night stay should hold exactly 3 nights, not 6 (no duplicate holds from the loser)');
});

test('one online and one front-desk booking racing for the same room/dates: exactly one succeeds', async () => {
  const onlineReq = bookingReq();
  const walkInReq = {
    params: { hotelId: hotel._id.toString() },
    body: {
      guestName: 'Front Desk Guest',
      guestEmail: `concurrency-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      roomId: 'room-1',
      checkInDate: '2027-03-01',
      checkOutDate: '2027-03-04',
      numberOfGuests: 1
    },
    user: { userId: hostId.toString(), role: 'host' }
  };

  const resOnline = fakeRes();
  const resWalkIn = fakeRes();

  await Promise.all([
    createBooking(onlineReq, resOnline),
    createWalkInBooking(walkInReq, resWalkIn)
  ]);

  const statuses = [resOnline.statusCode, resWalkIn.statusCode].sort();
  assert.deepEqual(statuses, [201, 409], `expected one 201 and one 409, got ${JSON.stringify(statuses)}: ${JSON.stringify([resOnline.body, resWalkIn.body])}`);

  const activeBookings = await Booking.find({ hotelId: hotel._id, roomId: 'room-1', status: { $ne: 'cancelled' } });
  assert.equal(activeBookings.length, 1, 'only one booking should have won the race, across both booking paths');
});

test('non-overlapping bookings are unaffected: different rooms, same dates both succeed', async () => {
  const res1 = fakeRes();
  const res2 = fakeRes();

  await Promise.all([
    createBooking(bookingReq({ roomId: 'room-1' }), res1),
    createBooking(bookingReq({ roomId: 'room-2' }), res2)
  ]);

  assert.equal(res1.statusCode, 201, `expected 201, got ${res1.statusCode}: ${JSON.stringify(res1.body)}`);
  assert.equal(res2.statusCode, 201, `expected 201, got ${res2.statusCode}: ${JSON.stringify(res2.body)}`);
});

test('non-overlapping bookings are unaffected: same room, back-to-back date ranges both succeed', async () => {
  const res1 = fakeRes();
  const res2 = fakeRes();

  await Promise.all([
    createBooking(bookingReq({ checkInDate: '2027-03-01', checkOutDate: '2027-03-04' }), res1),
    createBooking(bookingReq({ checkInDate: '2027-03-04', checkOutDate: '2027-03-06' }), res2)
  ]);

  assert.equal(res1.statusCode, 201, `expected 201, got ${res1.statusCode}: ${JSON.stringify(res1.body)}`);
  assert.equal(res2.statusCode, 201, `expected 201, got ${res2.statusCode}: ${JSON.stringify(res2.body)}`);
});

test('cancelling a booking releases its holds so a new booking for the same slot succeeds', async () => {
  const createRes = fakeRes();
  await createBooking(bookingReq(), createRes);
  assert.equal(createRes.statusCode, 201, `expected 201, got ${createRes.statusCode}: ${JSON.stringify(createRes.body)}`);
  const bookingId = createRes.body.booking._id;

  const holdsBefore = await RoomBookingHold.countDocuments({ bookingId });
  assert.ok(holdsBefore > 0, 'booking should hold at least one night');

  const cancelReq = { params: { id: bookingId }, body: {}, user: { userId: hostId.toString(), role: 'host' } };
  const cancelRes = fakeRes();
  await cancelBooking(cancelReq, cancelRes);
  assert.equal(cancelRes.statusCode, 200, `expected 200, got ${cancelRes.statusCode}: ${JSON.stringify(cancelRes.body)}`);

  const holdsAfter = await RoomBookingHold.countDocuments({ bookingId });
  assert.equal(holdsAfter, 0, 'cancelling must release the room-night holds');

  const rebookRes = fakeRes();
  await createBooking(bookingReq(), rebookRes);
  assert.equal(rebookRes.statusCode, 201, `expected the freed slot to be rebookable, got ${rebookRes.statusCode}: ${JSON.stringify(rebookRes.body)}`);
});

test('load: 8 concurrent requests for the same room/dates — exactly one succeeds', async () => {
  const attempts = Array.from({ length: 8 }, () => fakeRes());

  await Promise.all(attempts.map(res => createBooking(bookingReq(), res)));

  const succeeded = attempts.filter(res => res.statusCode === 201);
  const conflicted = attempts.filter(res => res.statusCode === 409);
  const unexpected = attempts.filter(res => res.statusCode !== 201 && res.statusCode !== 409);

  assert.equal(unexpected.length, 0, `expected only 201/409, got: ${JSON.stringify(unexpected.map(r => [r.statusCode, r.body]))}`);
  assert.equal(succeeded.length, 1, `expected exactly 1 success, got ${succeeded.length}`);
  assert.equal(conflicted.length, 7, `expected exactly 7 conflicts, got ${conflicted.length}`);

  const activeBookings = await Booking.find({ hotelId: hotel._id, roomId: 'room-1', status: { $ne: 'cancelled' } });
  assert.equal(activeBookings.length, 1, 'exactly one booking should have been persisted despite 8 racing attempts');
});

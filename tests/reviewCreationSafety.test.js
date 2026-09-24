// Regression tests for createReview (backend/controllers/reviewController.js).
//
// Bug this guards against: createReview never took a bookingId from the guest at all — it
// silently picked "whichever completed booking at this hotel sorts last by checkOutDate" and
// attached the review to THAT one. A guest with more than one completed stay at the same
// hotel had no guarantee the review ended up connected to the stay they actually clicked
// "Write a Review" from. The fix requires an explicit bookingId, validated server-side to
// actually belong to this guest and this hotel before it's trusted.
//
// Hits a real MongoDB for the same reason as the other tests in this directory. Creates and
// deletes its own Hotel/Booking/Review/User documents, but MONGODB_URI must still point at the
// isolated test_copy database.
//
// Run with (from backend/):
//   MONGODB_URI="<atlas-uri>/test_copy" node --test tests/reviewCreationSafety.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI || !MONGO_URI.includes('test_copy')) {
  throw new Error(
    'Refusing to run: these tests create and delete real Hotel/Booking/Review documents, so ' +
    'MONGODB_URI must point at the isolated test_copy database, never the production "test" ' +
    'database. Run: MONGODB_URI="<your-atlas-uri>/test_copy" node --test tests/reviewCreationSafety.test.js'
  );
}

const mongoose = (await import('mongoose')).default;
const { default: Hotel } = await import('../models/Hotel.js');
const { default: Booking } = await import('../models/Booking.js');
const { default: Review } = await import('../models/Review.js');
const { createReview } = await import('../controllers/reviewController.js');

function fakeRes() {
  const res = {
    statusCode: 200,
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

const hotelIds = [];
const bookingIds = [];
const reviewIds = [];

async function makeHotel(name) {
  const hostId = new mongoose.Types.ObjectId();
  const hotel = await Hotel.create({
    name, description: 'desc',
    location: { address: '1 St', city: 'Lagos', country: 'Nigeria' },
    hostId
  });
  hotelIds.push(hotel._id);
  return hotel;
}

async function makeBooking(hotel, userId, { completed = true, roomId = '101' } = {}) {
  const booking = await Booking.create({
    hotelId: hotel._id, userId, roomId,
    checkInDate: new Date(Date.now() - 2 * 86400000),
    checkOutDate: new Date(Date.now() - 86400000),
    totalPrice: 100,
    status: completed ? 'completed' : 'confirmed',
    ...(completed ? { checkOutInfo: { actualCheckOutTime: new Date(Date.now() - 86400000) } } : {})
  });
  bookingIds.push(booking._id);
  return booking;
}

before(async () => {
  await mongoose.connect(MONGO_URI);
});

after(async () => {
  await Review.deleteMany({ _id: { $in: reviewIds } });
  await Booking.deleteMany({ _id: { $in: bookingIds } });
  await Hotel.deleteMany({ _id: { $in: hotelIds } });
  await mongoose.disconnect();
});

test('a review is created against exactly the booking the guest submitted', async () => {
  const hotel = await makeHotel('Review Safety Test Hotel A');
  const userId = new mongoose.Types.ObjectId();
  const booking = await makeBooking(hotel, userId);

  const req = {
    body: { hotelId: hotel._id.toString(), bookingId: booking._id.toString(), rating: 5, title: 'Great stay', comment: 'Loved it' },
    user: { userId: userId.toString() }
  };
  const res = fakeRes();

  await createReview(req, res);

  assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.review.bookingId.toString(), booking._id.toString());
  reviewIds.push(res.body.review._id);
});

test('reviewing with a different completed booking at the SAME hotel still links to the booking actually submitted, not an unrelated one', async () => {
  const hotel = await makeHotel('Review Safety Test Hotel B');
  const userId = new mongoose.Types.ObjectId();
  // Two completed stays — an older one and a newer one. The guest reviews from the OLDER
  // booking's card; before the fix, the backend would have silently picked the newer one
  // instead (it always sorted by checkOutDate desc and ignored which booking was clicked).
  const olderBooking = await makeBooking(hotel, userId, { roomId: '101' });
  const newerBooking = await Booking.create({
    hotelId: hotel._id, userId, roomId: '102',
    checkInDate: new Date(Date.now() - 5 * 86400000),
    checkOutDate: new Date(),
    totalPrice: 100, status: 'completed',
    checkOutInfo: { actualCheckOutTime: new Date() }
  });
  bookingIds.push(newerBooking._id);

  const req = {
    body: { hotelId: hotel._id.toString(), bookingId: olderBooking._id.toString(), rating: 4 },
    user: { userId: userId.toString() }
  };
  const res = fakeRes();

  await createReview(req, res);

  assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.review.bookingId.toString(), olderBooking._id.toString(), 'must link to the booking actually clicked, not the most recent one');
  reviewIds.push(res.body.review._id);
});

test('a bookingId belonging to a different guest is rejected, not misattributed', async () => {
  const hotel = await makeHotel('Review Safety Test Hotel C');
  const ownerUserId = new mongoose.Types.ObjectId();
  const attackerUserId = new mongoose.Types.ObjectId();
  const booking = await makeBooking(hotel, ownerUserId);

  const req = {
    body: { hotelId: hotel._id.toString(), bookingId: booking._id.toString(), rating: 1, comment: 'not my booking' },
    user: { userId: attackerUserId.toString() }
  };
  const res = fakeRes();

  await createReview(req, res);

  assert.equal(res.statusCode, 404);
  const reviews = await Review.find({ hotelId: hotel._id });
  assert.equal(reviews.length, 0, 'no review should have been created');
});

test('a bookingId at a different hotel than hotelId is rejected', async () => {
  const hotelA = await makeHotel('Review Safety Test Hotel D1');
  const hotelB = await makeHotel('Review Safety Test Hotel D2');
  const userId = new mongoose.Types.ObjectId();
  const bookingAtA = await makeBooking(hotelA, userId);

  const req = {
    body: { hotelId: hotelB._id.toString(), bookingId: bookingAtA._id.toString(), rating: 3 },
    user: { userId: userId.toString() }
  };
  const res = fakeRes();

  await createReview(req, res);

  assert.equal(res.statusCode, 404);
});

test('a not-yet-completed booking cannot be used to submit a review', async () => {
  const hotel = await makeHotel('Review Safety Test Hotel E');
  const userId = new mongoose.Types.ObjectId();
  const upcomingBooking = await makeBooking(hotel, userId, { completed: false });

  const req = {
    body: { hotelId: hotel._id.toString(), bookingId: upcomingBooking._id.toString(), rating: 5 },
    user: { userId: userId.toString() }
  };
  const res = fakeRes();

  await createReview(req, res);

  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /completing a stay/i);
});

test('a second review attempt for the same hotel is still blocked (duplicate prevention unaffected by the bookingId change)', async () => {
  const hotel = await makeHotel('Review Safety Test Hotel F');
  const userId = new mongoose.Types.ObjectId();
  const firstBooking = await makeBooking(hotel, userId, { roomId: '101' });
  const secondBooking = await makeBooking(hotel, userId, { roomId: '102' });

  const firstReq = {
    body: { hotelId: hotel._id.toString(), bookingId: firstBooking._id.toString(), rating: 5 },
    user: { userId: userId.toString() }
  };
  const firstRes = fakeRes();
  await createReview(firstReq, firstRes);
  assert.equal(firstRes.statusCode, 201);
  reviewIds.push(firstRes.body.review._id);

  const secondReq = {
    body: { hotelId: hotel._id.toString(), bookingId: secondBooking._id.toString(), rating: 2 },
    user: { userId: userId.toString() }
  };
  const secondRes = fakeRes();
  await createReview(secondReq, secondRes);

  assert.equal(secondRes.statusCode, 409);
  assert.match(secondRes.body.error, /already reviewed/i);
  const reviews = await Review.find({ hotelId: hotel._id, userId });
  assert.equal(reviews.length, 1, 'only the first review should exist');
});

test('missing bookingId is rejected with a clear 400', async () => {
  const hotel = await makeHotel('Review Safety Test Hotel G');
  const userId = new mongoose.Types.ObjectId();

  const req = { body: { hotelId: hotel._id.toString(), rating: 5 }, user: { userId: userId.toString() } };
  const res = fakeRes();

  await createReview(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /bookingId/i);
});

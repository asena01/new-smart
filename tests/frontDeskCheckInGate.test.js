// Regression tests for confirmCheckIn's identity-verification gate
// (backend/controllers/bookingController.js).
//
// Bug this guards against: front desk's manual check-in endpoint had zero verification
// awareness — a guest whose Didit session came back 'Declined' could still be checked in by
// clicking straight past it, and the endpoint would blindly set guestVerified = true anyway.
//
// diditService.getSessionDecision makes a real call to Didit's external API, which a test
// can't (and shouldn't) depend on — diditService is a mutable singleton instance
// (`export default new DiditService()`), so its method is monkey-patched here for the
// duration of the test instead. bookingController.js imports the same singleton object, so
// the patch is visible to it without touching module resolution at all.
//
// Hits a real MongoDB for the same reason as the other tests in this directory. Creates and
// deletes its own Hotel/Booking documents, but MONGODB_URI must still point at the isolated
// test_copy database.
//
// Run with (from backend/):
//   MONGODB_URI="<atlas-uri>/test_copy" node --test tests/frontDeskCheckInGate.test.js

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI || !MONGO_URI.includes('test_copy')) {
  throw new Error(
    'Refusing to run: these tests create and delete real Hotel/Booking documents, so ' +
    'MONGODB_URI must point at the isolated test_copy database, never the production "test" ' +
    'database. Run: MONGODB_URI="<your-atlas-uri>/test_copy" node --test tests/frontDeskCheckInGate.test.js'
  );
}

const mongoose = (await import('mongoose')).default;
const { default: Hotel } = await import('../models/Hotel.js');
const { default: Booking } = await import('../models/Booking.js');
const { default: diditService } = await import('../services/diditService.js');
const { confirmCheckIn } = await import('../controllers/bookingController.js');

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
let booking;
const originalGetSessionDecision = diditService.getSessionDecision.bind(diditService);

before(async () => {
  await mongoose.connect(MONGO_URI);
  hotel = await Hotel.create({
    name: 'Check-In Gate Test Hotel',
    description: 'desc',
    location: { address: '1 St', city: 'Lagos', country: 'Nigeria' },
    hostId
  });
});

beforeEach(async () => {
  booking = await Booking.create({
    hotelId: hotel._id,
    roomId: 'room-1',
    checkInDate: new Date(),
    checkOutDate: new Date(Date.now() + 86400000),
    totalPrice: 100,
    status: 'confirmed',
    paymentStatus: 'completed',
    contactlessCheckIn: { enabled: false, diditSessionId: 'fake-session-id' }
  });
});

after(async () => {
  diditService.getSessionDecision = originalGetSessionDecision;
  await Booking.deleteMany({ hotelId: hotel._id });
  await Hotel.deleteOne({ _id: hotel._id });
  await mongoose.disconnect();
});

test('a declined verification blocks a host from checking the guest in', async () => {
  diditService.getSessionDecision = async () => ({ status: 'Declined' });

  const req = { params: { id: booking._id.toString() }, user: { userId: hostId.toString(), role: 'host' } };
  const res = fakeRes();

  await confirmCheckIn(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /declined/i);

  const fromDb = await Booking.findById(booking._id);
  assert.equal(fromDb.checkInInfo?.actualCheckInTime, undefined, 'check-in must not have gone through');
  assert.notEqual(fromDb.checkInInfo?.guestVerified, true, 'guestVerified must not be forced true on a decline');
});

test('an approved verification allows check-in to proceed normally', async () => {
  diditService.getSessionDecision = async () => ({ status: 'Approved' });

  const req = { params: { id: booking._id.toString() }, user: { userId: hostId.toString(), role: 'host' } };
  const res = fakeRes();

  await confirmCheckIn(req, res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const fromDb = await Booking.findById(booking._id);
  assert.ok(fromDb.checkInInfo?.actualCheckInTime, 'check-in should have gone through');
});

test('a still-pending/in-review verification does not block a manual front-desk check-in', async () => {
  diditService.getSessionDecision = async () => ({ status: 'In Review' });

  const req = { params: { id: booking._id.toString() }, user: { userId: hostId.toString(), role: 'host' } };
  const res = fakeRes();

  await confirmCheckIn(req, res);

  assert.equal(res.statusCode, 200, 'staff can still manually check a guest in while verification is only in review');
  const fromDb = await Booking.findById(booking._id);
  assert.ok(fromDb.checkInInfo?.actualCheckInTime);
});

test('a booking with no verification session at all checks in normally (standard check-in)', async () => {
  const noSessionBooking = await Booking.create({
    hotelId: hotel._id,
    roomId: 'room-2',
    checkInDate: new Date(),
    checkOutDate: new Date(Date.now() + 86400000),
    totalPrice: 100,
    status: 'confirmed',
    paymentStatus: 'completed'
  });

  const req = { params: { id: noSessionBooking._id.toString() }, user: { userId: hostId.toString(), role: 'host' } };
  const res = fakeRes();

  await confirmCheckIn(req, res);

  assert.equal(res.statusCode, 200);
  const fromDb = await Booking.findById(noSessionBooking._id);
  assert.ok(fromDb.checkInInfo?.actualCheckInTime);

  await Booking.deleteOne({ _id: noSessionBooking._id });
});

test('an admin can override a declined verification', async () => {
  diditService.getSessionDecision = async () => ({ status: 'Declined' });

  const req = { params: { id: booking._id.toString() }, user: { userId: new mongoose.Types.ObjectId().toString(), role: 'admin' } };
  const res = fakeRes();

  await confirmCheckIn(req, res);

  assert.equal(res.statusCode, 200, 'admin override should still succeed despite the decline');
  const fromDb = await Booking.findById(booking._id);
  assert.ok(fromDb.checkInInfo?.actualCheckInTime);
});

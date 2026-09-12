// Regression tests for the early-checkin/late-checkout confirm gate in updateServiceOrderStatus
// (backend/controllers/serviceOrderController.js).
//
// Bug this guards against: confirming an early-checkin/late-checkout order always wrote
// status: 'confirmed' to the ServiceOrder unconditionally, THEN ran finalizeEarlyCheckIn/
// finalizeLateCheckOut, which silently no-op'd (a bare `return`, no error) if the order's
// requestedTime or its underlying booking was missing. The order ended up marked confirmed
// even though the guest's key window was never actually extended, with no error surfaced
// to the host and no way for the guest to know their request wasn't really applied.
//
// The fix moves finalize to run BEFORE the status write commits, and finalize now throws an
// explicit Error instead of silently returning — updateServiceOrderStatus catches that and
// responds 422 without ever writing status: 'confirmed'.
//
// Hits a real MongoDB for the same reason as the other tests in this directory. Creates and
// deletes its own Hotel/Booking/ServiceOrder documents, but MONGODB_URI must still point at
// the isolated test_copy database.
//
// Run with (from backend/):
//   MONGODB_URI="<atlas-uri>/test_copy" node --test tests/finalizeCheckInOutSafety.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI || !MONGO_URI.includes('test_copy')) {
  throw new Error(
    'Refusing to run: these tests create and delete real Hotel/Booking/ServiceOrder documents, ' +
    'so MONGODB_URI must point at the isolated test_copy database, never the production "test" ' +
    'database. Run: MONGODB_URI="<your-atlas-uri>/test_copy" node --test tests/finalizeCheckInOutSafety.test.js'
  );
}

const mongoose = (await import('mongoose')).default;
const { default: Hotel } = await import('../models/Hotel.js');
const { default: Booking } = await import('../models/Booking.js');
const { default: ServiceOrder } = await import('../models/ServiceOrder.js');
const { updateServiceOrderStatus } = await import('../controllers/serviceOrderController.js');

function fakeRes() {
  const res = {
    statusCode: 200, // Express defaults to 200 when .status() is never explicitly called
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

let hotel;
const bookingIds = [];
const orderIds = [];
const adminReq = { user: { userId: new mongoose.Types.ObjectId().toString(), role: 'admin' } };

before(async () => {
  await mongoose.connect(MONGO_URI);
  hotel = await Hotel.create({
    name: 'Finalize Safety Test Hotel',
    description: 'desc',
    location: { address: '1 St', city: 'Lagos', country: 'Nigeria' },
    hostId: new mongoose.Types.ObjectId()
  });
});

after(async () => {
  await ServiceOrder.deleteMany({ _id: { $in: orderIds } });
  await Booking.deleteMany({ _id: { $in: bookingIds } });
  await Hotel.deleteOne({ _id: hotel._id });
  await mongoose.disconnect();
});

test('confirming an early-checkin order with no requestedTime is rejected, not silently confirmed', async () => {
  const booking = await Booking.create({
    hotelId: hotel._id, roomId: '101', checkInDate: new Date(), checkOutDate: new Date(Date.now() + 86400000), totalPrice: 100
  });
  bookingIds.push(booking._id);

  const order = await ServiceOrder.create({
    bookingId: booking._id, hotelId: hotel._id, guestId: new mongoose.Types.ObjectId(),
    serviceType: 'early-checkin',
    serviceDetails: {}, // no requestedTime — this is the broken/missing-data case
    subtotal: 20, tax: 0, total: 20, status: 'pending', staffId: new mongoose.Types.ObjectId()
  });
  orderIds.push(order._id);

  const req = { params: { orderId: order._id.toString() }, body: { status: 'confirmed' }, user: adminReq.user };
  const res = fakeRes();

  await updateServiceOrderStatus(req, res);

  assert.equal(res.statusCode, 422, `expected 422, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.error, /requested check-in time/i);

  const orderFromDb = await ServiceOrder.findById(order._id);
  assert.equal(orderFromDb.status, 'pending', 'the order must not have been marked confirmed');
  const bookingFromDb = await Booking.findById(booking._id);
  assert.equal(bookingFromDb.checkInInfo?.approvedEarlyCheckInTime, undefined, 'the key window must not have been touched');
});

test('confirming an early-checkin order whose booking no longer exists is rejected', async () => {
  const orphanBookingId = new mongoose.Types.ObjectId();
  const order = await ServiceOrder.create({
    bookingId: orphanBookingId, hotelId: hotel._id, guestId: new mongoose.Types.ObjectId(),
    serviceType: 'early-checkin',
    serviceDetails: { requestedTime: '12:00' },
    subtotal: 20, tax: 0, total: 20, status: 'pending', staffId: new mongoose.Types.ObjectId()
  });
  orderIds.push(order._id);

  const req = { params: { orderId: order._id.toString() }, body: { status: 'confirmed' }, user: adminReq.user };
  const res = fakeRes();

  await updateServiceOrderStatus(req, res);

  assert.equal(res.statusCode, 422);
  assert.match(res.body.error, /booking.*could not be found/i);
  const orderFromDb = await ServiceOrder.findById(order._id);
  assert.equal(orderFromDb.status, 'pending');
});

test('confirming a valid early-checkin order succeeds and actually extends the key window', async () => {
  const booking = await Booking.create({
    hotelId: hotel._id, roomId: '102', checkInDate: new Date(), checkOutDate: new Date(Date.now() + 86400000), totalPrice: 100
  });
  bookingIds.push(booking._id);

  const order = await ServiceOrder.create({
    bookingId: booking._id, hotelId: hotel._id, guestId: new mongoose.Types.ObjectId(),
    serviceType: 'early-checkin',
    serviceDetails: { requestedTime: '12:00' },
    subtotal: 20, tax: 0, total: 20, status: 'pending', staffId: new mongoose.Types.ObjectId()
  });
  orderIds.push(order._id);

  const req = { params: { orderId: order._id.toString() }, body: { status: 'confirmed' }, user: adminReq.user };
  const res = fakeRes();

  await updateServiceOrderStatus(req, res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const orderFromDb = await ServiceOrder.findById(order._id);
  assert.equal(orderFromDb.status, 'confirmed');
  const bookingFromDb = await Booking.findById(booking._id);
  assert.ok(bookingFromDb.checkInInfo?.approvedEarlyCheckInTime, 'the key window should actually be set');
});

test('confirming a late-checkout order with no requestedTime is rejected, not silently confirmed', async () => {
  const booking = await Booking.create({
    hotelId: hotel._id, roomId: '103', checkInDate: new Date(), checkOutDate: new Date(Date.now() + 86400000), totalPrice: 100
  });
  bookingIds.push(booking._id);

  const order = await ServiceOrder.create({
    bookingId: booking._id, hotelId: hotel._id, guestId: new mongoose.Types.ObjectId(),
    serviceType: 'late-checkout',
    serviceDetails: {},
    subtotal: 20, tax: 0, total: 20, status: 'pending', staffId: new mongoose.Types.ObjectId()
  });
  orderIds.push(order._id);

  const req = { params: { orderId: order._id.toString() }, body: { status: 'confirmed' }, user: adminReq.user };
  const res = fakeRes();

  await updateServiceOrderStatus(req, res);

  assert.equal(res.statusCode, 422);
  assert.match(res.body.error, /requested check-out time/i);
  const orderFromDb = await ServiceOrder.findById(order._id);
  assert.equal(orderFromDb.status, 'pending');
  const bookingFromDb = await Booking.findById(booking._id);
  assert.equal(bookingFromDb.checkOutInfo?.approvedLateCheckOutTime, undefined);
});

test('confirming a valid late-checkout order succeeds and actually extends the key window', async () => {
  const booking = await Booking.create({
    hotelId: hotel._id, roomId: '104', checkInDate: new Date(), checkOutDate: new Date(Date.now() + 86400000), totalPrice: 100
  });
  bookingIds.push(booking._id);

  const order = await ServiceOrder.create({
    bookingId: booking._id, hotelId: hotel._id, guestId: new mongoose.Types.ObjectId(),
    serviceType: 'late-checkout',
    serviceDetails: { requestedTime: '14:00' },
    subtotal: 20, tax: 0, total: 20, status: 'pending', staffId: new mongoose.Types.ObjectId()
  });
  orderIds.push(order._id);

  const req = { params: { orderId: order._id.toString() }, body: { status: 'confirmed' }, user: adminReq.user };
  const res = fakeRes();

  await updateServiceOrderStatus(req, res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const orderFromDb = await ServiceOrder.findById(order._id);
  assert.equal(orderFromDb.status, 'confirmed');
  const bookingFromDb = await Booking.findById(booking._id);
  assert.ok(bookingFromDb.checkOutInfo?.approvedLateCheckOutTime, 'the key window should actually be set');
});

// Regression tests for the guest-facing service order cancellation lock point
// (backend/controllers/serviceOrderController.js: cancelServiceOrder).
//
// Bug this guards against: cancelServiceOrder only blocked cancellation once an order reached
// a terminal status (completed/delivered/cancelled) — a guest could still cancel a restaurant
// order after it moved to 'confirmed'/'preparing', i.e. after the kitchen had already started
// making the food. The fix aligns the guest lock point with the one already enforced on the
// staff side (updateServiceOrderStatus): 'pending' (no staff assigned yet) is the last status
// a non-admin can cancel from. The fix also closes a TOCTOU race — the actual status write is
// now an atomic findOneAndUpdate filtered on status still being 'pending', not a separate
// read-then-write, so a losing race can't cancel an order that moved on in between.
//
// Hits a real MongoDB for the same reason as the other tests in this directory. Creates and
// deletes its own Hotel/Booking/ServiceOrder/User documents, but MONGODB_URI must still point
// at the isolated test_copy database.
//
// Run with (from backend/):
//   MONGODB_URI="<atlas-uri>/test_copy" node --test tests/serviceOrderCancellationLock.test.js

import { test, before, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI || !MONGO_URI.includes('test_copy')) {
  throw new Error(
    'Refusing to run: these tests create and delete real Hotel/Booking/ServiceOrder/User ' +
    'documents, so MONGODB_URI must point at the isolated test_copy database, never the ' +
    'production "test" database. Run: MONGODB_URI="<your-atlas-uri>/test_copy" node --test tests/serviceOrderCancellationLock.test.js'
  );
}

const mongoose = (await import('mongoose')).default;
const { default: Hotel } = await import('../models/Hotel.js');
const { default: Booking } = await import('../models/Booking.js');
const { default: ServiceOrder } = await import('../models/ServiceOrder.js');
const { cancelServiceOrder } = await import('../controllers/serviceOrderController.js');

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

const hostId = new mongoose.Types.ObjectId();
const guestId = new mongoose.Types.ObjectId();
let hotel, booking;

before(async () => {
  await mongoose.connect(MONGO_URI);
  hotel = await Hotel.create({
    name: 'Cancellation Lock Test Hotel',
    description: 'desc',
    location: { address: '1 St', city: 'Lagos', country: 'Nigeria' },
    hostId
  });
  booking = await Booking.create({
    hotelId: hotel._id,
    roomId: 'room-1',
    checkInDate: new Date(),
    checkOutDate: new Date(Date.now() + 86400000),
    totalPrice: 1000,
    status: 'confirmed',
    paymentStatus: 'completed'
  });
});

afterEach(async () => {
  await ServiceOrder.deleteMany({ hotelId: hotel._id });
});

after(async () => {
  await Booking.deleteOne({ _id: booking._id });
  await Hotel.deleteOne({ _id: hotel._id });
  await mongoose.disconnect();
});

function makeOrder(overrides = {}) {
  return ServiceOrder.create({
    bookingId: booking._id,
    hotelId: hotel._id,
    guestId,
    serviceType: 'restaurant',
    serviceDetails: { items: [{ itemId: 'i1', name: 'Burger', quantity: 1, price: 100 }] },
    subtotal: 100,
    tax: 0,
    total: 100,
    status: 'pending',
    ...overrides
  });
}

function cancelReq(orderId, overrides = {}) {
  return {
    params: { orderId: orderId.toString() },
    body: { reason: 'Changed my mind' },
    user: { userId: guestId.toString(), role: 'guest' },
    ...overrides
  };
}

test('a guest can cancel a still-pending order', async () => {
  const order = await makeOrder({ status: 'pending' });
  const res = fakeRes();

  await cancelServiceOrder(cancelReq(order._id), res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const reloaded = await ServiceOrder.findById(order._id);
  assert.equal(reloaded.status, 'cancelled');
});

test('a guest cannot cancel a confirmed order — the kitchen has already started', async () => {
  const order = await makeOrder({ status: 'confirmed' });
  const res = fakeRes();

  await cancelServiceOrder(cancelReq(order._id), res);

  assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.error, /can no longer be cancelled/i);

  const reloaded = await ServiceOrder.findById(order._id);
  assert.equal(reloaded.status, 'confirmed', 'the order must be untouched, not partially cancelled');
});

test('a guest cannot cancel a preparing/ready/delivered order either', async () => {
  for (const status of ['preparing', 'ready', 'delivered']) {
    const order = await makeOrder({ status });
    const res = fakeRes();

    await cancelServiceOrder(cancelReq(order._id), res);

    assert.equal(res.statusCode, 400, `status=${status}: expected 400, got ${res.statusCode}`);
    const reloaded = await ServiceOrder.findById(order._id);
    assert.equal(reloaded.status, status, `status=${status}: order must be untouched`);
  }
});

test('an admin can still cancel an order that has already entered production', async () => {
  const order = await makeOrder({ status: 'preparing' });
  const res = fakeRes();

  await cancelServiceOrder(cancelReq(order._id, { user: { userId: new mongoose.Types.ObjectId().toString(), role: 'admin' } }), res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const reloaded = await ServiceOrder.findById(order._id);
  assert.equal(reloaded.status, 'cancelled');
});

test('cancelling an already-cancelled order is rejected, not silently re-applied', async () => {
  const order = await makeOrder({ status: 'cancelled' });
  const res = fakeRes();

  await cancelServiceOrder(cancelReq(order._id), res);

  assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
});

test('a guest cannot cancel another guest\'s order', async () => {
  const order = await makeOrder({ status: 'pending' });
  const res = fakeRes();

  await cancelServiceOrder(cancelReq(order._id, { user: { userId: new mongoose.Types.ObjectId().toString(), role: 'guest' } }), res);

  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const reloaded = await ServiceOrder.findById(order._id);
  assert.equal(reloaded.status, 'pending', 'an unauthorized attempt must not change anything');
});

test('race: two concurrent cancel attempts on the same pending order — exactly one succeeds, no inconsistent state', async () => {
  const order = await makeOrder({ status: 'pending' });
  const res1 = fakeRes();
  const res2 = fakeRes();

  await Promise.all([
    cancelServiceOrder(cancelReq(order._id), res1),
    cancelServiceOrder(cancelReq(order._id), res2)
  ]);

  const statuses = [res1.statusCode, res2.statusCode].sort();
  assert.deepEqual(statuses, [200, 409], `expected one 200 and one 409, got ${JSON.stringify(statuses)}: ${JSON.stringify([res1.body, res2.body])}`);

  const reloaded = await ServiceOrder.findById(order._id);
  assert.equal(reloaded.status, 'cancelled', 'the order ends up cancelled exactly once, not double-processed');
});

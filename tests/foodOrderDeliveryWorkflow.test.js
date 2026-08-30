// Regression tests for the extended restaurant/bar delivery workflow
// (backend/controllers/serviceOrderController.js: updateServiceOrderStatus).
//
// This ticket extended the pipeline past 'ready' — a waiter now explicitly moves a claimed
// order through 'on-the-way' before the final 'delivered' ("Guest Received") step, instead of
// jumping straight from ready to delivered. Three things this guards against:
//   1. An out-of-order or skipped transition (e.g. 'ready' -> 'delivered' directly, or
//      'pending' -> 'ready') silently succeeding for a restaurant/bar order — the pipeline is
//      now a strict ordered state machine for those two service types only.
//   2. A duplicate/retried request (same status sent twice) being rejected as an "invalid
//      transition" instead of treated as an idempotent no-op.
//   3. The final 'delivered' transition not recording who confirmed it (deliveredBy) or
//      leaving a gap in the append-only statusHistory audit trail.
//
// Hits a real MongoDB for the same reason as the other tests in this directory. Creates and
// deletes its own Hotel/Staff/Booking/ServiceOrder/User documents, but MONGODB_URI must still
// point at the isolated test_copy database.
//
// Run with (from backend/):
//   MONGODB_URI="<atlas-uri>/test_copy" node --test tests/foodOrderDeliveryWorkflow.test.js

import { test, before, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI || !MONGO_URI.includes('test_copy')) {
  throw new Error(
    'Refusing to run: these tests create and delete real Hotel/Staff/Booking/ServiceOrder/User ' +
    'documents, so MONGODB_URI must point at the isolated test_copy database, never the ' +
    'production "test" database. Run: MONGODB_URI="<your-atlas-uri>/test_copy" node --test tests/foodOrderDeliveryWorkflow.test.js'
  );
}

const mongoose = (await import('mongoose')).default;
const { default: Hotel } = await import('../models/Hotel.js');
const { default: Staff } = await import('../models/Staff.js');
const { default: Booking } = await import('../models/Booking.js');
const { default: ServiceOrder } = await import('../models/ServiceOrder.js');
const { updateServiceOrderStatus } = await import('../controllers/serviceOrderController.js');

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
const staffUserId = new mongoose.Types.ObjectId();
let hotel, booking, staff;

before(async () => {
  await mongoose.connect(MONGO_URI);
  hotel = await Hotel.create({
    name: 'Delivery Workflow Test Hotel',
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
  staff = await Staff.create({
    hotelId: hotel._id,
    userId: staffUserId,
    firstName: 'Test', lastName: 'Waiter', email: `waiter-${Date.now()}@example.com`,
    position: 'waiter', employmentType: 'full-time',
    permissions: { canDeliverOrders: true },
    status: 'active'
  });
});

afterEach(async () => {
  await ServiceOrder.deleteMany({ hotelId: hotel._id });
});

after(async () => {
  await Staff.deleteOne({ _id: staff._id });
  await Booking.deleteOne({ _id: booking._id });
  await Hotel.deleteOne({ _id: hotel._id });
  await mongoose.disconnect();
});

function makeOrder(overrides = {}) {
  return ServiceOrder.create({
    bookingId: booking._id,
    hotelId: hotel._id,
    guestId: new mongoose.Types.ObjectId(),
    staffId: staff._id,
    serviceType: 'restaurant',
    serviceDetails: { items: [{ itemId: 'i1', name: 'Burger', quantity: 1, price: 100 }] },
    subtotal: 100,
    tax: 0,
    total: 100,
    status: 'ready',
    ...overrides
  });
}

function statusReq(orderId, status, overrides = {}) {
  return {
    params: { orderId: orderId.toString() },
    body: { status },
    user: { userId: staffUserId.toString(), role: 'staff' },
    ...overrides
  };
}

test('a claimed ready order can move to on-the-way', async () => {
  const order = await makeOrder({ status: 'ready' });
  const res = fakeRes();

  await updateServiceOrderStatus(statusReq(order._id, 'on-the-way'), res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.order.status, 'on-the-way');
});

test('on-the-way can move to delivered, recording deliveredBy and completedAt', async () => {
  const order = await makeOrder({ status: 'on-the-way' });
  const res = fakeRes();

  await updateServiceOrderStatus(statusReq(order._id, 'delivered'), res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.order.status, 'delivered');
  assert.equal(String(res.body.order.deliveredBy), String(staff._id), 'deliveredBy should record the staff member who confirmed it');
  assert.ok(res.body.order.completedAt, 'completedAt should be set on final delivery');
});

test('a ready order cannot jump straight to delivered, skipping on-the-way', async () => {
  const order = await makeOrder({ status: 'ready' });
  const res = fakeRes();

  await updateServiceOrderStatus(statusReq(order._id, 'delivered'), res);

  assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const reloaded = await ServiceOrder.findById(order._id);
  assert.equal(reloaded.status, 'ready', 'the order must be untouched, not partially advanced');
});

test('a pending order cannot jump straight to ready, skipping confirmed and preparing', async () => {
  const order = await makeOrder({ status: 'pending' });
  const res = fakeRes();

  await updateServiceOrderStatus(statusReq(order._id, 'ready'), res);

  assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const reloaded = await ServiceOrder.findById(order._id);
  assert.equal(reloaded.status, 'pending');
});

test('a pending order cannot jump straight to preparing — the hotel must accept it first', async () => {
  const order = await makeOrder({ status: 'pending' });
  const res = fakeRes();

  await updateServiceOrderStatus(statusReq(order._id, 'preparing'), res);

  assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const reloaded = await ServiceOrder.findById(order._id);
  assert.equal(reloaded.status, 'pending');
});

test('a pending order can be accepted (confirmed), then moved to preparing', async () => {
  const order = await makeOrder({ status: 'pending' });

  const acceptRes = fakeRes();
  await updateServiceOrderStatus(statusReq(order._id, 'confirmed'), acceptRes);
  assert.equal(acceptRes.statusCode, 200, `expected 200, got ${acceptRes.statusCode}: ${JSON.stringify(acceptRes.body)}`);
  assert.equal(acceptRes.body.order.status, 'confirmed');

  const prepRes = fakeRes();
  await updateServiceOrderStatus(statusReq(order._id, 'preparing'), prepRes);
  assert.equal(prepRes.statusCode, 200, `expected 200, got ${prepRes.statusCode}: ${JSON.stringify(prepRes.body)}`);
  assert.equal(prepRes.body.order.status, 'preparing');
});

test('a delivered order cannot be moved backward to on-the-way', async () => {
  const order = await makeOrder({ status: 'delivered' });
  const res = fakeRes();

  await updateServiceOrderStatus(statusReq(order._id, 'on-the-way'), res);

  assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const reloaded = await ServiceOrder.findById(order._id);
  assert.equal(reloaded.status, 'delivered');
});

test('an admin can still force a non-sequential transition', async () => {
  const order = await makeOrder({ status: 'ready' });
  const res = fakeRes();

  await updateServiceOrderStatus(statusReq(order._id, 'delivered', { user: { userId: new mongoose.Types.ObjectId().toString(), role: 'admin' } }), res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.order.status, 'delivered');
});

test('a duplicate/retried request for the current status is an idempotent no-op, not an error', async () => {
  const order = await makeOrder({ status: 'on-the-way' });
  const res = fakeRes();

  await updateServiceOrderStatus(statusReq(order._id, 'on-the-way'), res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const reloaded = await ServiceOrder.findById(order._id);
  assert.equal(reloaded.status, 'on-the-way');
  assert.equal(reloaded.statusHistory.length, 0, 'a no-op retry must not add a duplicate audit entry');
});

test('every real transition appends exactly one entry to the audit trail, recording who and when', async () => {
  const order = await makeOrder({ status: 'ready' });

  await updateServiceOrderStatus(statusReq(order._id, 'on-the-way'), fakeRes());
  await updateServiceOrderStatus(statusReq(order._id, 'delivered'), fakeRes());

  const reloaded = await ServiceOrder.findById(order._id);
  assert.equal(reloaded.statusHistory.length, 2, 'expected exactly one audit entry per real transition');
  assert.equal(reloaded.statusHistory[0].status, 'on-the-way');
  assert.equal(reloaded.statusHistory[1].status, 'delivered');
  for (const entry of reloaded.statusHistory) {
    assert.equal(String(entry.changedBy), staffUserId.toString());
    assert.equal(entry.changedByRole, 'staff');
    assert.ok(entry.at, 'each audit entry must record when the change happened');
  }
});

test('non-restaurant/bar service types are unaffected by the strict sequencing', async () => {
  const order = await ServiceOrder.create({
    bookingId: booking._id,
    hotelId: hotel._id,
    guestId: new mongoose.Types.ObjectId(),
    staffId: staff._id,
    serviceType: 'laundry',
    serviceDetails: {},
    subtotal: 50,
    tax: 0,
    total: 50,
    status: 'pending'
  });
  const res = fakeRes();

  // Laundry has no ordered pipeline enforced — jumping straight to 'completed' must still work.
  await updateServiceOrderStatus(statusReq(order._id, 'completed'), res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.order.status, 'completed');
});

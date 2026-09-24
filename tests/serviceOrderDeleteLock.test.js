// Regression tests for deleteServiceOrder (backend/controllers/serviceOrderController.js).
//
// This ticket's core requirement: a guest transaction record must never be hard-deletable —
// only cancel-while-pending is a legitimate reversal, and every other status is a permanent
// record (revenue, statusHistory audit trail). Unlike cancellation, deletion has no admin
// override and no status check: it is unconditionally rejected for every role and every
// status, so there is exactly one behavior to verify, checked here across the full matrix of
// roles and statuses that could plausibly be tried against it.
//
// Hits a real MongoDB for the same reason as the other tests in this directory — deleteServiceOrder
// itself never touches the DB (it rejects before any query), but the test still needs a real
// order to confirm the record is untouched afterward. Creates and deletes its own
// Hotel/Booking/ServiceOrder/User documents, but MONGODB_URI must still point at the isolated
// test_copy database.
//
// Run with (from backend/):
//   MONGODB_URI="<atlas-uri>/test_copy" node --test tests/serviceOrderDeleteLock.test.js

import { test, before, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI || !MONGO_URI.includes('test_copy')) {
  throw new Error(
    'Refusing to run: these tests create and delete real Hotel/Booking/ServiceOrder documents, ' +
    'so MONGODB_URI must point at the isolated test_copy database, never the production "test" ' +
    'database. Run: MONGODB_URI="<your-atlas-uri>/test_copy" node --test tests/serviceOrderDeleteLock.test.js'
  );
}

const mongoose = (await import('mongoose')).default;
const { default: Hotel } = await import('../models/Hotel.js');
const { default: Booking } = await import('../models/Booking.js');
const { default: ServiceOrder } = await import('../models/ServiceOrder.js');
const { deleteServiceOrder } = await import('../controllers/serviceOrderController.js');

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
    name: 'Delete Lock Test Hotel',
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

function makeOrder(status) {
  return ServiceOrder.create({
    bookingId: booking._id,
    hotelId: hotel._id,
    guestId,
    serviceType: 'restaurant',
    serviceDetails: { items: [{ itemId: 'i1', name: 'Burger', quantity: 1, price: 100 }] },
    subtotal: 100,
    tax: 0,
    total: 100,
    status
  });
}

function deleteReq(orderId, role) {
  return {
    params: { orderId: orderId.toString() },
    body: {},
    user: { userId: role === 'guest' ? guestId.toString() : new mongoose.Types.ObjectId().toString(), role }
  };
}

const ROLES = ['guest', 'staff', 'host', 'admin'];
const STATUSES = ['pending', 'confirmed', 'preparing', 'ready', 'on-the-way', 'delivered', 'completed', 'cancelled'];

for (const role of ROLES) {
  for (const status of STATUSES) {
    test(`${role} cannot delete a ${status} order — deletion is unconditionally disallowed`, async () => {
      const order = await makeOrder(status);
      const res = fakeRes();

      await deleteServiceOrder(deleteReq(order._id, role), res);

      assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, /cannot be deleted/i);

      const reloaded = await ServiceOrder.findById(order._id);
      assert.ok(reloaded, 'the order record must still exist — deletion must never actually happen');
      assert.equal(reloaded.status, status, 'the order must be completely untouched');
    });
  }
}

test('even a request with no matching order still gets the same permanent 403, not a 404 leaking existence', async () => {
  const res = fakeRes();
  await deleteServiceOrder(deleteReq(new mongoose.Types.ObjectId(), 'admin'), res);
  assert.equal(res.statusCode, 403);
});

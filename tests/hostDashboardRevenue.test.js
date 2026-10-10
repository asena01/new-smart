// Regression tests for getHostDashboard's revenue aggregation (backend/controllers/hotelController.js).
//
// Bug this guards against: bookingRevenue only excluded cancelled bookings, so a still-pending
// or failed payment was counted as real revenue — bookings are reliably paid up front via
// Flutterwave, so the fix requires paymentStatus === 'completed' there too. serviceRevenue
// deliberately does NOT carry the same paymentStatus requirement: most service orders are
// charged to the guest's room and settled when the booking is paid at checkout, not paid
// online at order time, so requiring paymentStatus === 'completed' there would hide nearly
// all order revenue instead of filtering out a real "never happened" case (see
// isOrderRevenueEligible in src/app/utils/revenue.ts for the frontend's mirror of this rule).
//
// Hits a real MongoDB for the same reason as updateHotel.test.js — module-level ESM imports
// make mocking Booking/ServiceOrder/Hotel awkward without extra tooling this project doesn't
// otherwise use. Creates and deletes its own Hotel/Booking/ServiceOrder documents, but
// MONGODB_URI must still point at the isolated test_copy database.
//
// Run with (from backend/):
//   MONGODB_URI="<atlas-uri>/test_copy" node --test tests/hostDashboardRevenue.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI || !MONGO_URI.includes('test_copy')) {
  throw new Error(
    'Refusing to run: these tests create and delete real Hotel/Booking/ServiceOrder ' +
    'documents, so MONGODB_URI must point at the isolated test_copy database, never the ' +
    'production "test" database. Run: MONGODB_URI="<your-atlas-uri>/test_copy" node --test tests/hostDashboardRevenue.test.js'
  );
}

const mongoose = (await import('mongoose')).default;
const { default: Hotel } = await import('../models/Hotel.js');
const { default: Booking } = await import('../models/Booking.js');
const { default: ServiceOrder } = await import('../models/ServiceOrder.js');
const { getHostDashboard } = await import('../controllers/hotelController.js');

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
const bookingIds = [];
const orderIds = [];

before(async () => {
  await mongoose.connect(MONGO_URI);

  hotel = await Hotel.create({
    name: 'Revenue Test Hotel',
    description: 'desc',
    location: { address: '1 St', city: 'Lagos', country: 'Nigeria' },
    hostId
  });

  const bookingsData = [
    { totalPrice: 1000, status: 'confirmed', paymentStatus: 'completed' }, // counted
    { totalPrice: 2000, status: 'pending', paymentStatus: 'pending' },     // excluded: unpaid
    { totalPrice: 3000, status: 'confirmed', paymentStatus: 'failed' },    // excluded: failed payment
    { totalPrice: 4000, status: 'cancelled', paymentStatus: 'completed' }, // excluded: cancelled, even though paid
    { totalPrice: 5000, status: 'completed', paymentStatus: 'completed' } // counted
  ];
  for (const data of bookingsData) {
    const booking = await Booking.create({
      hotelId: hotel._id,
      roomId: 'room-1',
      checkInDate: new Date(),
      checkOutDate: new Date(Date.now() + 86400000),
      ...data
    });
    bookingIds.push(booking._id);
  }

  const guestId = new mongoose.Types.ObjectId();
  const bookingIdForOrders = bookingIds[0];
  const ordersData = [
    { total: 100, status: 'confirmed', paymentStatus: 'completed' }, // counted
    { total: 200, status: 'pending', paymentStatus: 'pending' },     // counted: room-charge orders stay 'pending' by design
    { total: 300, status: 'confirmed', paymentStatus: 'failed' },    // counted: paymentStatus isn't meaningful for orders
    { total: 400, status: 'cancelled', paymentStatus: 'completed' }  // excluded: cancelled is still a real exclusion
  ];
  for (const data of ordersData) {
    const order = await ServiceOrder.create({
      bookingId: bookingIdForOrders,
      hotelId: hotel._id,
      guestId,
      serviceType: 'laundry',
      serviceDetails: {},
      subtotal: data.total,
      tax: 0,
      ...data
    });
    orderIds.push(order._id);
  }
});

after(async () => {
  await Booking.deleteMany({ _id: { $in: bookingIds } });
  await ServiceOrder.deleteMany({ _id: { $in: orderIds } });
  await Hotel.deleteOne({ _id: hotel._id });
  await mongoose.disconnect();
});

test('bookingRevenue only counts non-cancelled bookings with a completed payment', async () => {
  const req = { user: { userId: hostId.toString(), role: 'host' } };
  const res = fakeRes();

  await getHostDashboard(req, res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.metrics.bookingRevenue, 6000, 'only the two completed, non-cancelled bookings (1000 + 5000) should count');
});

test('serviceRevenue counts every non-cancelled order regardless of paymentStatus', async () => {
  const req = { user: { userId: hostId.toString(), role: 'host' } };
  const res = fakeRes();

  await getHostDashboard(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.metrics.serviceRevenue, 600, 'the three non-cancelled orders (100 + 200 + 300) should all count');
});

test('serviceStats.active counts only orders not yet completed/delivered/cancelled', async () => {
  const req = { user: { userId: hostId.toString(), role: 'host' } };
  const res = fakeRes();

  await getHostDashboard(req, res);

  assert.equal(res.statusCode, 200);
  const laundryStats = res.body.serviceStats.find(s => s._id === 'laundry');
  assert.ok(laundryStats, 'expected a laundry entry in serviceStats');
  // Seeded: confirmed, pending, confirmed(failed payment), cancelled. None of the first three
  // are in a terminal status (completed/delivered/cancelled), so all three are still "current";
  // only the cancelled one is excluded.
  assert.equal(laundryStats.orders, 4, 'orders is the lifetime count, all 4 seeded orders');
  assert.equal(laundryStats.active, 3, 'active excludes only the cancelled order (a terminal status)');
  // Same three non-terminal orders (100 + 200 + 300); none of them happen to be
  // completed/delivered in this fixture, so activeRevenue matches lifetime revenue here —
  // the two diverge once an order is actually marked completed/delivered (see the
  // "current dashboard reflects live state" test below).
  assert.equal(laundryStats.activeRevenue, 600, 'activeRevenue sums only the non-terminal orders');
});

test('serviceStats.active and activeRevenue read 0 once every order of a type is terminal, despite real past revenue', async () => {
  // Isolated hotel/host/order, separate from the shared fixture above — this specifically
  // reproduces the bug report: a laundry order was delivered (real revenue collected), and the
  // dashboard card kept showing that revenue next to "0 current", which read as contradictory.
  const isolatedHostId = new mongoose.Types.ObjectId();
  const isolatedHotel = await Hotel.create({
    name: 'Isolated Terminal-Order Test Hotel',
    description: 'desc',
    location: { address: '1 St', city: 'Lagos', country: 'Nigeria' },
    hostId: isolatedHostId
  });
  const guestId = new mongoose.Types.ObjectId();
  const booking = await Booking.create({
    hotelId: isolatedHotel._id,
    roomId: 'room-1',
    checkInDate: new Date(),
    checkOutDate: new Date(Date.now() + 86400000),
    totalPrice: 1000,
    status: 'completed',
    paymentStatus: 'completed'
  });
  const deliveredOrder = await ServiceOrder.create({
    bookingId: booking._id,
    hotelId: isolatedHotel._id,
    guestId,
    serviceType: 'laundry',
    serviceDetails: {},
    subtotal: 207,
    tax: 0,
    total: 207,
    status: 'delivered',
    paymentStatus: 'completed'
  });

  try {
    const req = { user: { userId: isolatedHostId.toString(), role: 'host' } };
    const res = fakeRes();

    await getHostDashboard(req, res);

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    const laundryStats = res.body.serviceStats.find(s => s._id === 'laundry');
    assert.ok(laundryStats, 'expected a laundry entry — the order exists, just fully delivered');
    assert.equal(laundryStats.orders, 1, 'orders (lifetime) still reflects the one delivered order');
    assert.equal(laundryStats.revenue, 207, 'revenue (lifetime) still reflects the real 207 collected');
    assert.equal(laundryStats.active, 0, 'active is 0 — nothing is currently in flight');
    assert.equal(laundryStats.activeRevenue, 0, 'activeRevenue is 0, even though real past revenue (207) exists');
  } finally {
    await ServiceOrder.deleteOne({ _id: deliveredOrder._id });
    await Booking.deleteOne({ _id: booking._id });
    await Hotel.deleteOne({ _id: isolatedHotel._id });
  }
});

test('totalBookings and activeBookings still count every non-cancelled booking regardless of payment status', async () => {
  const req = { user: { userId: hostId.toString(), role: 'host' } };
  const res = fakeRes();

  await getHostDashboard(req, res);

  assert.equal(res.statusCode, 200);
  // All 5 seeded bookings exist regardless of payment status.
  assert.equal(res.body.metrics.totalBookings, 5);
  // 'pending' and 'confirmed' bookings are active: 3 of the 5 (excludes the cancelled and the completed-stay one).
  assert.equal(res.body.metrics.activeBookings, 3);
});

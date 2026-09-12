// Regression tests for deleteItem's reference-check (backend/controllers/serviceCatalogController.js).
//
// Bug this guards against: deleting a service-catalog item did a bare findByIdAndDelete with
// no check of whether any in-progress order still referenced it.
//
// Hits a real MongoDB for the same reason as the other tests in this directory. Creates and
// deletes its own Hotel/ServiceCatalogItem/ServiceOrder documents, but MONGODB_URI must still
// point at the isolated test_copy database.
//
// Run with (from backend/):
//   MONGODB_URI="<atlas-uri>/test_copy" node --test tests/deleteCatalogItemSafety.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI || !MONGO_URI.includes('test_copy')) {
  throw new Error(
    'Refusing to run: these tests create and delete real Hotel/ServiceCatalogItem/ServiceOrder ' +
    'documents, so MONGODB_URI must point at the isolated test_copy database, never the ' +
    'production "test" database. Run: MONGODB_URI="<your-atlas-uri>/test_copy" node --test tests/deleteCatalogItemSafety.test.js'
  );
}

const mongoose = (await import('mongoose')).default;
const { default: Hotel } = await import('../models/Hotel.js');
const { default: ServiceCatalogItem } = await import('../models/ServiceCatalogItem.js');
const { default: ServiceOrder } = await import('../models/ServiceOrder.js');
const { deleteItem } = await import('../controllers/serviceCatalogController.js');

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

const hostId = new mongoose.Types.ObjectId();
const guestId = new mongoose.Types.ObjectId();
const bookingId = new mongoose.Types.ObjectId();
let hotel;
const itemIds = [];
const orderIds = [];

before(async () => {
  await mongoose.connect(MONGO_URI);
  hotel = await Hotel.create({
    name: 'Catalog Delete Safety Test Hotel',
    description: 'desc',
    location: { address: '1 St', city: 'Lagos', country: 'Nigeria' },
    hostId
  });
});

after(async () => {
  await ServiceOrder.deleteMany({ _id: { $in: orderIds } });
  await ServiceCatalogItem.deleteMany({ _id: { $in: itemIds } });
  await Hotel.deleteOne({ _id: hotel._id });
  await mongoose.disconnect();
});

test('a restaurant item still referenced by a pending order cannot be deleted', async () => {
  const item = await ServiceCatalogItem.create({
    hotelId: hotel._id, serviceType: 'restaurant', name: 'Grilled Salmon', price: 25
  });
  itemIds.push(item._id);

  const order = await ServiceOrder.create({
    bookingId, hotelId: hotel._id, guestId, serviceType: 'restaurant',
    serviceDetails: { items: [{ itemId: item._id.toString(), name: 'Grilled Salmon', quantity: 1, price: 25 }] },
    subtotal: 25, tax: 0, total: 25, status: 'preparing'
  });
  orderIds.push(order._id);

  const req = { params: { itemId: item._id.toString() }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await deleteItem(req, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /referenced by 1 order/i);
  const stillExists = await ServiceCatalogItem.findById(item._id);
  assert.ok(stillExists, 'the item must not have been deleted');
});

test('a restaurant item only referenced by a completed/cancelled order can be deleted', async () => {
  const item = await ServiceCatalogItem.create({
    hotelId: hotel._id, serviceType: 'restaurant', name: 'Beef Burger', price: 15
  });
  itemIds.push(item._id);

  const completedOrder = await ServiceOrder.create({
    bookingId, hotelId: hotel._id, guestId, serviceType: 'restaurant',
    serviceDetails: { items: [{ itemId: item._id.toString(), name: 'Beef Burger', quantity: 1, price: 15 }] },
    subtotal: 15, tax: 0, total: 15, status: 'completed'
  });
  orderIds.push(completedOrder._id);

  const req = { params: { itemId: item._id.toString() }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await deleteItem(req, res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const stillExists = await ServiceCatalogItem.findById(item._id);
  assert.equal(stillExists, null, 'the item should actually be gone');
});

test('a laundry item matched by name against a pending order cannot be deleted', async () => {
  const item = await ServiceCatalogItem.create({
    hotelId: hotel._id, serviceType: 'laundry', name: 'Dress Shirt', price: 5
  });
  itemIds.push(item._id);

  const order = await ServiceOrder.create({
    bookingId, hotelId: hotel._id, guestId, serviceType: 'laundry',
    serviceDetails: { laundryItems: [{ itemType: 'Dress Shirt', quantity: 2, price: 5 }] },
    subtotal: 10, tax: 0, total: 10, status: 'pending'
  });
  orderIds.push(order._id);

  const req = { params: { itemId: item._id.toString() }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await deleteItem(req, res);

  assert.equal(res.statusCode, 409);
});

test('an unreferenced item deletes normally (no regression on the common case)', async () => {
  const item = await ServiceCatalogItem.create({
    hotelId: hotel._id, serviceType: 'bar', name: 'Mojito', price: 8
  });
  itemIds.push(item._id);

  const req = { params: { itemId: item._id.toString() }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await deleteItem(req, res);

  assert.equal(res.statusCode, 200);
  const stillExists = await ServiceCatalogItem.findById(item._id);
  assert.equal(stillExists, null);
});

test('an early-checkin catalog item is never blocked by pending orders — that service type never references the catalog at all', async () => {
  const item = await ServiceCatalogItem.create({
    hotelId: hotel._id, serviceType: 'early-checkin', name: 'Early Check-in', price: 20, timeSlot: '12:00'
  });
  itemIds.push(item._id);

  // A real pending early-checkin order for the SAME hotel exists, priced entirely off
  // Hotel.policies (see computeAuthoritativePricing) — it has no relationship to this
  // catalog item at all, so it must never block deletion.
  const order = await ServiceOrder.create({
    bookingId, hotelId: hotel._id, guestId, serviceType: 'early-checkin',
    serviceDetails: { requestedTime: '13:00', hours: 2, ratePerHour: 10 },
    subtotal: 20, tax: 0, total: 20, status: 'pending'
  });
  orderIds.push(order._id);

  const req = { params: { itemId: item._id.toString() }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await deleteItem(req, res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
});

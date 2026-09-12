// Regression tests for price validation on rooms (backend/controllers/hotelController.js,
// backend/models/Hotel.js) and service-catalog items
// (backend/controllers/serviceCatalogController.js, backend/models/ServiceCatalogItem.js).
//
// Bug this guards against: basePrice/discountPrice (rooms) and price/discountPrice (catalog
// items) had no bounds at all in either the Mongoose schema or the controllers — a negative
// price, or a discount price >= the real price, was accepted silently by a direct API call.
//
// Hits a real MongoDB for the same reason as the other tests in this directory. Creates and
// deletes its own Hotel/ServiceCatalogItem documents, but MONGODB_URI must still point at the
// isolated test_copy database.
//
// Run with (from backend/):
//   MONGODB_URI="<atlas-uri>/test_copy" node --test tests/priceValidation.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI || !MONGO_URI.includes('test_copy')) {
  throw new Error(
    'Refusing to run: these tests create and delete real Hotel/ServiceCatalogItem documents, ' +
    'so MONGODB_URI must point at the isolated test_copy database, never the production "test" ' +
    'database. Run: MONGODB_URI="<your-atlas-uri>/test_copy" node --test tests/priceValidation.test.js'
  );
}

const mongoose = (await import('mongoose')).default;
const { default: Hotel } = await import('../models/Hotel.js');
const { default: ServiceCatalogItem } = await import('../models/ServiceCatalogItem.js');
const { addMyRoom, updateMyRoom } = await import('../controllers/hotelController.js');
const { createItem, updateItem } = await import('../controllers/serviceCatalogController.js');

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
const itemIds = [];

async function makeHotel() {
  const hostId = new mongoose.Types.ObjectId();
  const hotel = await Hotel.create({
    name: 'Price Validation Test Hotel',
    description: 'desc',
    location: { address: '1 St', city: 'Lagos', country: 'Nigeria' },
    hostId
  });
  hotelIds.push(hotel._id);
  return { hotel, hostId };
}

before(async () => {
  await mongoose.connect(MONGO_URI);
});

after(async () => {
  await ServiceCatalogItem.deleteMany({ _id: { $in: itemIds } });
  await Hotel.deleteMany({ _id: { $in: hotelIds } });
  await mongoose.disconnect();
});

// --- Rooms: controller-level ---

test('addMyRoom rejects a negative base price', async () => {
  const { hotel, hostId } = await makeHotel();
  const req = { body: { roomNumber: '101', type: 'Standard', capacity: 2, basePrice: -50 }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await addMyRoom(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /base price cannot be negative/i);
  const fromDb = await Hotel.findById(hotel._id);
  assert.equal(fromDb.rooms.length, 0);
});

test('addMyRoom rejects a negative discount price', async () => {
  const { hotel, hostId } = await makeHotel();
  const req = { body: { roomNumber: '101', type: 'Standard', capacity: 2, basePrice: 100, discountPrice: -10 }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await addMyRoom(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /discount price cannot be negative/i);
});

test('addMyRoom rejects a discount price that is not lower than the base price', async () => {
  const { hotel, hostId } = await makeHotel();
  const req = { body: { roomNumber: '101', type: 'Standard', capacity: 2, basePrice: 100, discountPrice: 100 }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await addMyRoom(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /discount price must be lower/i);
});

test('addMyRoom accepts valid prices (no regression on the happy path)', async () => {
  const { hotel, hostId } = await makeHotel();
  const req = { body: { roomNumber: '101', type: 'Standard', capacity: 2, basePrice: 100, discountPrice: 80 }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await addMyRoom(req, res);

  assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.room.basePrice, 100);
  assert.equal(res.body.room.discountPrice, 80);
});

test('addMyRoom treats discountPrice: 0 as "no discount", not a negative/invalid value', async () => {
  const { hotel, hostId } = await makeHotel();
  const req = { body: { roomNumber: '101', type: 'Standard', capacity: 2, basePrice: 100, discountPrice: 0 }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await addMyRoom(req, res);

  assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
});

// --- Rooms: partial update uses effective (combined) values ---

test('updateMyRoom rejects a partial update that would make discountPrice exceed the existing basePrice', async () => {
  const { hotel, hostId } = await makeHotel();
  const createReq = { body: { roomNumber: '102', type: 'Standard', capacity: 2, basePrice: 100, discountPrice: 80 }, user: { userId: hostId.toString() } };
  await addMyRoom(createReq, fakeRes());

  const hotelDoc = await Hotel.findById(hotel._id);
  const room = hotelDoc.rooms.find(r => r.roomNumber === '102');

  // Only basePrice is being changed here — discountPrice (80) isn't in this payload at all,
  // but dropping basePrice to 50 would make the room's EXISTING discountPrice invalid.
  const updateReq = { params: { roomId: room._id.toString() }, body: { basePrice: 50 }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await updateMyRoom(updateReq, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /discount price must be lower/i);
  const unchanged = await Hotel.findById(hotel._id);
  const stillRoom = unchanged.rooms.find(r => r.roomNumber === '102');
  assert.equal(stillRoom.basePrice, 100, 'the bad update must not have been applied');
});

test('updateMyRoom rejects a negative discount price on an otherwise-unrelated update', async () => {
  const { hotel, hostId } = await makeHotel();
  const createReq = { body: { roomNumber: '103', type: 'Standard', capacity: 2, basePrice: 100 }, user: { userId: hostId.toString() } };
  await addMyRoom(createReq, fakeRes());

  const hotelDoc = await Hotel.findById(hotel._id);
  const room = hotelDoc.rooms.find(r => r.roomNumber === '103');

  const updateReq = { params: { roomId: room._id.toString() }, body: { discountPrice: -20 }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await updateMyRoom(updateReq, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /discount price cannot be negative/i);
});

// --- Rooms: schema-level backstop (bypassing the controller entirely) ---

test('the Hotel schema itself rejects a negative room base price, independent of the controller', async () => {
  await assert.rejects(
    Hotel.create({
      name: 'Schema-Level Reject Test Hotel',
      description: 'desc',
      location: { address: '1 St', city: 'Lagos', country: 'Nigeria' },
      hostId: new mongoose.Types.ObjectId(),
      rooms: [{ roomNumber: '999', type: 'Standard', capacity: 2, basePrice: -1 }]
    }),
    /base price cannot be negative/i
  );
});

// --- Service catalog: controller-level ---

test('createItem rejects a negative price', async () => {
  const { hotel, hostId } = await makeHotel();
  const req = {
    params: { hotelId: hotel._id.toString() },
    body: { serviceType: 'bar', name: 'Negative Mojito', price: -5 },
    user: { userId: hostId.toString() }
  };
  const res = fakeRes();

  await createItem(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /price cannot be negative/i);
});

test('createItem rejects a discount price that is not lower than the price', async () => {
  const { hotel, hostId } = await makeHotel();
  const req = {
    params: { hotelId: hotel._id.toString() },
    body: { serviceType: 'bar', name: 'Bad Discount Mojito', price: 10, discountPrice: 10 },
    user: { userId: hostId.toString() }
  };
  const res = fakeRes();

  await createItem(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /discount price must be lower/i);
});

test('createItem accepts valid prices (no regression on the happy path)', async () => {
  const { hotel, hostId } = await makeHotel();
  const req = {
    params: { hotelId: hotel._id.toString() },
    body: { serviceType: 'bar', name: 'Valid Mojito', price: 10, discountPrice: 8 },
    user: { userId: hostId.toString() }
  };
  const res = fakeRes();

  await createItem(req, res);

  assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  itemIds.push(res.body.item._id);
});

test('updateItem rejects a partial update that would make discountPrice exceed the existing price', async () => {
  const { hotel, hostId } = await makeHotel();
  const createReq = {
    params: { hotelId: hotel._id.toString() },
    body: { serviceType: 'bar', name: 'Price Drop Mojito', price: 10, discountPrice: 8 },
    user: { userId: hostId.toString() }
  };
  const createRes = fakeRes();
  await createItem(createReq, createRes);
  const item = createRes.body.item;
  itemIds.push(item._id);

  // Only price is being changed — discountPrice (8) isn't in this payload, but dropping
  // price to 5 would make the item's EXISTING discountPrice invalid.
  const updateReq = { params: { itemId: item._id }, body: { price: 5 }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await updateItem(updateReq, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /discount price must be lower/i);
  const unchanged = await ServiceCatalogItem.findById(item._id);
  assert.equal(unchanged.price, 10, 'the bad update must not have been applied');
});

// --- Service catalog: schema-level backstop ---

test('the ServiceCatalogItem schema itself rejects a negative price, independent of the controller', async () => {
  const { hotel } = await makeHotel();
  await assert.rejects(
    ServiceCatalogItem.create({ hotelId: hotel._id, serviceType: 'bar', name: 'Direct Model Test', price: -1 }),
    /price cannot be negative/i
  );
});

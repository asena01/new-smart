// Mass-assignment regression tests for updateHotel (backend/controllers/hotelController.js).
//
// These hit a real MongoDB (via mongoose) rather than mocking the Hotel model, since ESM
// static imports make module-level mocking awkward without extra tooling this project
// doesn't otherwise use. They create and delete their own Hotel document and never touch
// anything else, but MONGODB_URI must still point at the isolated test_copy database (see
// backend/scripts/copyDbForTesting.js) rather than the real "test" database — the guard
// below refuses to run otherwise.
//
// Run with (from backend/):
//   MONGODB_URI="<atlas-uri>/test_copy" node --test tests/updateHotel.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI || !MONGO_URI.includes('test_copy')) {
  throw new Error(
    'Refusing to run: these tests create and delete a real Hotel document, so MONGODB_URI ' +
    'must point at the isolated test_copy database, never the production "test" database. ' +
    'Run: MONGODB_URI="<your-atlas-uri>/test_copy" node --test tests/updateHotel.test.js'
  );
}

const mongoose = (await import('mongoose')).default;
const { default: Hotel } = await import('../models/Hotel.js');
const { updateHotel } = await import('../controllers/hotelController.js');

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

let hotel;
const hostId = new mongoose.Types.ObjectId();
const otherHostId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();

before(async () => {
  await mongoose.connect(MONGO_URI);
});

after(async () => {
  await Hotel.deleteOne({ _id: hotel._id });
  await mongoose.disconnect();
});

test('legitimate fields update while host-controlled/computed fields are dropped', async () => {
  hotel = await Hotel.create({
    name: 'Original Name',
    description: 'Original description',
    location: { address: '1 Main St', city: 'Lagos', country: 'Nigeria' },
    hostId,
    rating: 4.5,
    reviewCount: 120,
    isActive: true,
    flutterwaveSubaccountId: 'RS_ORIGINAL'
  });

  const req = {
    params: { id: hotel._id.toString() },
    user: { userId: hostId.toString(), role: 'host' },
    body: {
      // Legitimate, allow-listed change.
      name: 'Renamed Hotel',
      // Mass-assignment attempt: computed/host-controlled/identity fields.
      rating: 5,
      reviewCount: 999999,
      hostId: otherHostId.toString(),
      isActive: false,
      flutterwaveSubaccountId: 'RS_HIJACKED',
      // Unknown field with no meaning on the schema at all.
      isSuperAdmin: true
    }
  };
  const res = fakeRes();

  await updateHotel(req, res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const updated = res.body.hotel;

  assert.equal(updated.name, 'Renamed Hotel', 'the allow-listed field should have updated');
  assert.equal(updated.rating, 4.5, 'rating must not be host-editable');
  assert.equal(updated.reviewCount, 120, 'reviewCount must not be host-editable');
  assert.equal(updated.hostId.toString(), hostId.toString(), 'hostId must not be changeable through this endpoint');
  assert.equal(updated.isActive, true, 'isActive must not be changeable through this endpoint');
  assert.equal(updated.flutterwaveSubaccountId, 'RS_ORIGINAL', 'flutterwaveSubaccountId must not be changeable through this endpoint');
  assert.equal(updated.isSuperAdmin, undefined, 'unknown fields must not be persisted');

  // Re-fetch independently to confirm the database itself was never written, not just that
  // the response happened to reflect the pre-update values.
  const fromDb = await Hotel.findById(hotel._id);
  assert.equal(fromDb.rating, 4.5);
  assert.equal(fromDb.reviewCount, 120);
  assert.equal(fromDb.hostId.toString(), hostId.toString());
  assert.equal(fromDb.isActive, true);
  assert.equal(fromDb.flutterwaveSubaccountId, 'RS_ORIGINAL');
});

test('mass-assignment is blocked the same way for an admin caller', async () => {
  const req = {
    params: { id: hotel._id.toString() },
    user: { userId: adminId.toString(), role: 'admin' },
    body: {
      description: 'Updated by admin',
      isActive: false,
      rating: 1
    }
  };
  const res = fakeRes();

  await updateHotel(req, res);

  assert.equal(res.statusCode, 200);
  const updated = res.body.hotel;
  assert.equal(updated.description, 'Updated by admin', 'allow-listed field should still update for admin');
  assert.equal(updated.isActive, true, 'isActive is admin-only through the dedicated status endpoint, not this one');
  assert.equal(updated.rating, 4.5, 'rating remains computed-only even for an admin caller');
});

test('a non-owner, non-admin caller is rejected and nothing changes', async () => {
  const req = {
    params: { id: hotel._id.toString() },
    user: { userId: otherHostId.toString(), role: 'host' },
    body: { name: 'Hijacked Name', isActive: false }
  };
  const res = fakeRes();

  await updateHotel(req, res);

  assert.equal(res.statusCode, 403);
  const fromDb = await Hotel.findById(hotel._id);
  assert.equal(fromDb.name, 'Renamed Hotel', 'unauthorized request must not modify the hotel at all');
  assert.equal(fromDb.isActive, true);
});

test('a legitimate update alongside a smuggled isActive:false still leaves isActive untouched', async () => {
  const req = {
    params: { id: hotel._id.toString() },
    user: { userId: hostId.toString(), role: 'host' },
    body: { amenities: ['wifi', 'pool'], isActive: false }
  };
  const res = fakeRes();

  await updateHotel(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.hotel.amenities, ['wifi', 'pool'], 'the allow-listed field should still update');
  assert.equal(res.body.hotel.isActive, true, 'isActive must stay unchanged even when the request tries to flip it');

  const fromDb = await Hotel.findById(hotel._id);
  assert.equal(fromDb.isActive, true);
});

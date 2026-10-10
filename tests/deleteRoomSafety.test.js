// Regression tests for deleteMyRoom's safety checks (backend/controllers/hotelController.js).
//
// Bug this guards against: room deletion used a bare deleteOne() with no awareness of active
// bookings or issued TTLock keys — deleting a room out from under an in-house guest or a
// guest with an upcoming reservation, or discarding the only record of a still-live digital
// key, left both the stay and the physical lock access in a broken/orphaned state.
//
// ttlockService is a mutable singleton instance (`export default new TTLockService()`), so
// its revoke methods are monkey-patched here for the duration of the affected tests instead
// of making real calls to TTLock's API — hotelController.js imports the same singleton
// object, so the patch is visible to it without touching module resolution.
//
// Hits a real MongoDB for the same reason as the other tests in this directory. Creates and
// deletes its own Hotel/Booking documents, but MONGODB_URI must still point at the isolated
// test_copy database.
//
// Run with (from backend/):
//   MONGODB_URI="<atlas-uri>/test_copy" node --test tests/deleteRoomSafety.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI || !MONGO_URI.includes('test_copy')) {
  throw new Error(
    'Refusing to run: these tests create and delete real Hotel/Booking documents, so ' +
    'MONGODB_URI must point at the isolated test_copy database, never the production "test" ' +
    'database. Run: MONGODB_URI="<your-atlas-uri>/test_copy" node --test tests/deleteRoomSafety.test.js'
  );
}

const mongoose = (await import('mongoose')).default;
const { default: Hotel } = await import('../models/Hotel.js');
const { default: Booking } = await import('../models/Booking.js');
const { default: ttlockService } = await import('../services/ttlockService.js');
const { deleteMyRoom } = await import('../controllers/hotelController.js');

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

// Each test gets its OWN hostId (not one shared constant) — deleteMyRoom resolves the hotel
// via Hotel.findOne({ hostId }), and several of this file's hotels are alive at once (each
// test's after-the-fact cleanup happens at the very end), so a shared hostId would make that
// lookup ambiguous between tests.
const hotelIds = [];
const bookingIds = [];
const originalDeleteKeyboardPwd = ttlockService.deleteKeyboardPwd.bind(ttlockService);
const originalRevokeEkey = ttlockService.revokeEkey.bind(ttlockService);

async function makeHotelWithRoom(roomNumber, deviceId) {
  const hostId = new mongoose.Types.ObjectId();
  const hotel = await Hotel.create({
    name: `Delete Room Safety Test Hotel ${roomNumber}`,
    description: 'desc',
    location: { address: '1 St', city: 'Lagos', country: 'Nigeria' },
    hostId,
    rooms: [{
      roomNumber,
      type: 'Standard',
      capacity: 2,
      basePrice: 100,
      smartLockIntegration: deviceId ? { provider: 'ttlock', deviceId, isActive: true } : undefined
    }]
  });
  hotelIds.push(hotel._id);
  return { hotel, hostId };
}

after(async () => {
  ttlockService.deleteKeyboardPwd = originalDeleteKeyboardPwd;
  ttlockService.revokeEkey = originalRevokeEkey;
  await Booking.deleteMany({ _id: { $in: bookingIds } });
  await Hotel.deleteMany({ _id: { $in: hotelIds } });
  await mongoose.disconnect();
});

before(async () => {
  await mongoose.connect(MONGO_URI);
});

test('a room with no bookings at all can be deleted', async () => {
  const { hotel, hostId } = await makeHotelWithRoom('101');
  const room = hotel.rooms[0];

  const req = { params: { roomId: room._id.toString() }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await deleteMyRoom(req, res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const fromDb = await Hotel.findById(hotel._id);
  assert.equal(fromDb.rooms.length, 0, 'the room should actually be gone');
});

test('deletion is blocked when the room has an upcoming (not yet checked-in) reservation', async () => {
  const { hotel, hostId } = await makeHotelWithRoom('102');
  const room = hotel.rooms[0];
  const booking = await Booking.create({
    hotelId: hotel._id,
    roomId: '102',
    guestName: 'Future Guest',
    checkInDate: new Date(Date.now() + 86400000),
    checkOutDate: new Date(Date.now() + 2 * 86400000),
    totalPrice: 100,
    status: 'confirmed'
  });
  bookingIds.push(booking._id);

  const req = { params: { roomId: room._id.toString() }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await deleteMyRoom(req, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /upcoming reservation/i);
  assert.match(res.body.message, /Future Guest/);
  const fromDb = await Hotel.findById(hotel._id);
  assert.equal(fromDb.rooms.length, 1, 'the room must not have been deleted');
});

test('deletion is blocked when a guest is currently checked in', async () => {
  const { hotel, hostId } = await makeHotelWithRoom('103');
  const room = hotel.rooms[0];
  const booking = await Booking.create({
    hotelId: hotel._id,
    roomId: '103',
    guestName: 'In-House Guest',
    checkInDate: new Date(Date.now() - 86400000),
    checkOutDate: new Date(Date.now() + 86400000),
    totalPrice: 100,
    status: 'confirmed',
    checkInInfo: { actualCheckInTime: new Date() }
  });
  bookingIds.push(booking._id);

  const req = { params: { roomId: room._id.toString() }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await deleteMyRoom(req, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /currently checked in/i);
  const fromDb = await Hotel.findById(hotel._id);
  assert.equal(fromDb.rooms.length, 1);
});

test('a room whose only bookings are cancelled/completed, with no active key, can be deleted', async () => {
  const { hotel, hostId } = await makeHotelWithRoom('104');
  const room = hotel.rooms[0];
  const cancelled = await Booking.create({
    hotelId: hotel._id, roomId: '104', checkInDate: new Date(), checkOutDate: new Date(Date.now() + 86400000),
    totalPrice: 100, status: 'cancelled'
  });
  const completed = await Booking.create({
    hotelId: hotel._id, roomId: '104', checkInDate: new Date(), checkOutDate: new Date(Date.now() + 86400000),
    totalPrice: 100, status: 'completed',
    checkInInfo: { actualCheckInTime: new Date() },
    checkOutInfo: { actualCheckOutTime: new Date() }
  });
  bookingIds.push(cancelled._id, completed._id);

  const req = { params: { roomId: room._id.toString() }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await deleteMyRoom(req, res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const fromDb = await Hotel.findById(hotel._id);
  assert.equal(fromDb.rooms.length, 0);
});

test('an orphaned but revocable TTLock key is revoked automatically, then deletion proceeds', async () => {
  ttlockService.deleteKeyboardPwd = async () => ({ success: true });
  ttlockService.revokeEkey = async () => ({ success: true });

  const { hotel, hostId } = await makeHotelWithRoom('105', 'device-105');
  const room = hotel.rooms[0];
  // Completed stay whose checkout-time revoke silently failed (see checkOutGuest's non-fatal
  // try/catch) — enabled is still true even though the guest is long gone.
  const completedWithLiveKey = await Booking.create({
    hotelId: hotel._id, roomId: '105', checkInDate: new Date(Date.now() - 2 * 86400000), checkOutDate: new Date(Date.now() - 86400000),
    totalPrice: 100, status: 'completed',
    checkInInfo: { actualCheckInTime: new Date(Date.now() - 2 * 86400000) },
    checkOutInfo: { actualCheckOutTime: new Date(Date.now() - 86400000) },
    contactlessCheckIn: { enabled: true, keyboardPwdId: 111, ekeyId: 222 }
  });
  bookingIds.push(completedWithLiveKey._id);

  const req = { params: { roomId: room._id.toString() }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await deleteMyRoom(req, res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const fromDb = await Hotel.findById(hotel._id);
  assert.equal(fromDb.rooms.length, 0, 'the room should be deleted once the key is revoked');
  const bookingFromDb = await Booking.findById(completedWithLiveKey._id);
  assert.equal(bookingFromDb.contactlessCheckIn.enabled, false, 'the key should be marked revoked on the booking record');
});

test('deletion is blocked when an active TTLock key fails to revoke', async () => {
  ttlockService.deleteKeyboardPwd = async () => { throw new Error('TTLock API unreachable'); };
  ttlockService.revokeEkey = async () => ({ success: true });

  const { hotel, hostId } = await makeHotelWithRoom('106', 'device-106');
  const room = hotel.rooms[0];
  const completedWithLiveKey = await Booking.create({
    hotelId: hotel._id, roomId: '106', checkInDate: new Date(Date.now() - 2 * 86400000), checkOutDate: new Date(Date.now() - 86400000),
    totalPrice: 100, status: 'completed',
    checkInInfo: { actualCheckInTime: new Date(Date.now() - 2 * 86400000) },
    checkOutInfo: { actualCheckOutTime: new Date(Date.now() - 86400000) },
    contactlessCheckIn: { enabled: true, keyboardPwdId: 333 }
  });
  bookingIds.push(completedWithLiveKey._id);

  const req = { params: { roomId: room._id.toString() }, user: { userId: hostId.toString() } };
  const res = fakeRes();

  await deleteMyRoom(req, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /could not be revoked/i);
  const fromDb = await Hotel.findById(hotel._id);
  assert.equal(fromDb.rooms.length, 1, 'the room must not be deleted while a key remains unrevoked');
  const bookingFromDb = await Booking.findById(completedWithLiveKey._id);
  assert.equal(bookingFromDb.contactlessCheckIn.enabled, true, 'the key must still be marked enabled since revocation failed');
});

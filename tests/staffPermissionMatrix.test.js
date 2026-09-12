// Regression tests locking in the staff-permission fixes from this ticket:
//   1. cancelBooking is gated by 'canManageReservations', not 'canCheckInGuests' — previously
//      every booking action shared one permission check (isAuthorizedForBooking's hardcoded
//      'canCheckInGuests'), so a staff member granted only reservation-management couldn't
//      cancel a booking despite the label, while a receptionist with only check-in/out could.
//   2. Every other isAuthorizedForBooking caller (confirmCheckIn stands in for the group here)
//      is unaffected by that change — still gated by 'canCheckInGuests' as before.
//   3. setupContactlessCheckIn — previously had NO authorization check at all — now rejects an
//      unauthorized caller before doing any TTLock work.
//   4. 'canManageBookings' — labeled on the Manager template but never enforced anywhere in the
//      backend — has been removed from PERMISSION_KEYS entirely, not silently left dead.
//   5. 'canAssignRooms', 'canViewGuests', 'canViewPayroll' — same dead-permission pattern as
//      canManageBookings (labeled in the UI, zero backend enforcement) — also removed from
//      PERMISSION_KEYS. No "reassign room" or payroll feature exists anywhere in the backend,
//      and guest data is already covered by the canCheckInGuests/canManageReservations gates
//      above, so there was no real feature left to wire either permission up to.
//
// Hits a real MongoDB for the same reason as the other tests in this directory. Creates and
// deletes its own Hotel/Staff/Booking documents, but MONGODB_URI must still point at the
// isolated test_copy database.
//
// Run with (from backend/):
//   MONGODB_URI="<atlas-uri>/test_copy" node --test tests/staffPermissionMatrix.test.js

import { test, before, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI || !MONGO_URI.includes('test_copy')) {
  throw new Error(
    'Refusing to run: these tests create and delete real Hotel/Staff/Booking documents, so ' +
    'MONGODB_URI must point at the isolated test_copy database, never the production "test" ' +
    'database. Run: MONGODB_URI="<your-atlas-uri>/test_copy" node --test tests/staffPermissionMatrix.test.js'
  );
}

const mongoose = (await import('mongoose')).default;
const { default: Hotel } = await import('../models/Hotel.js');
const { default: Staff } = await import('../models/Staff.js');
const { default: Booking } = await import('../models/Booking.js');
const { cancelBooking, confirmCheckIn, setupContactlessCheckIn } = await import('../controllers/bookingController.js');
const { updateHotel } = await import('../controllers/hotelController.js');
const { PERMISSION_KEYS, resolvePermissions } = await import('../utils/staffPermissions.js');

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
let hotel;
let checkInOnlyStaff, reservationsOnlyStaff;

before(async () => {
  await mongoose.connect(MONGO_URI);
  hotel = await Hotel.create({
    name: 'Permission Matrix Test Hotel',
    description: 'desc',
    location: { address: '1 St', city: 'Lagos', country: 'Nigeria' },
    hostId
  });
  checkInOnlyStaff = await Staff.create({
    hotelId: hotel._id,
    userId: new mongoose.Types.ObjectId(),
    firstName: 'CheckIn', lastName: 'Only', email: `checkin-only-${Date.now()}@example.com`,
    position: 'other', employmentType: 'full-time',
    permissions: { canCheckInGuests: true, canManageReservations: false },
    status: 'active'
  });
  reservationsOnlyStaff = await Staff.create({
    hotelId: hotel._id,
    userId: new mongoose.Types.ObjectId(),
    firstName: 'Reservations', lastName: 'Only', email: `reservations-only-${Date.now()}@example.com`,
    position: 'other', employmentType: 'full-time',
    permissions: { canCheckInGuests: false, canManageReservations: true },
    status: 'active'
  });
});

function makeBooking(overrides = {}) {
  return Booking.create({
    hotelId: hotel._id,
    roomId: 'room-1',
    checkInDate: new Date(),
    checkOutDate: new Date(Date.now() + 86400000),
    totalPrice: 1000,
    status: 'confirmed',
    paymentStatus: 'completed',
    ...overrides
  });
}

afterEach(async () => {
  await Booking.deleteMany({ hotelId: hotel._id });
});

after(async () => {
  await Staff.deleteMany({ _id: { $in: [checkInOnlyStaff._id, reservationsOnlyStaff._id] } });
  await Hotel.deleteOne({ _id: hotel._id });
  await mongoose.disconnect();
});

function bookingReq(booking, staff) {
  return { params: { id: booking._id.toString() }, body: {}, user: { userId: staff.userId.toString(), role: 'staff' } };
}

test('cancelBooking: a staff member with canManageReservations but NOT canCheckInGuests CAN cancel', async () => {
  const booking = await makeBooking();
  const res = fakeRes();
  await cancelBooking(bookingReq(booking, reservationsOnlyStaff), res);
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
});

test('cancelBooking: a staff member with canCheckInGuests but NOT canManageReservations CANNOT cancel', async () => {
  const booking = await makeBooking();
  const res = fakeRes();
  await cancelBooking(bookingReq(booking, checkInOnlyStaff), res);
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const reloaded = await Booking.findById(booking._id);
  assert.equal(reloaded.status, 'confirmed', 'the booking must be untouched');
});

test('confirmCheckIn: unaffected by the cancellation fix — still requires canCheckInGuests, not canManageReservations', async () => {
  const booking = await makeBooking({ status: 'confirmed' });
  const deniedRes = fakeRes();
  await confirmCheckIn(bookingReq(booking, reservationsOnlyStaff), deniedRes);
  assert.equal(deniedRes.statusCode, 403, `expected 403 for reservations-only staff, got ${deniedRes.statusCode}: ${JSON.stringify(deniedRes.body)}`);

  const allowedRes = fakeRes();
  await confirmCheckIn(bookingReq(booking, checkInOnlyStaff), allowedRes);
  assert.equal(allowedRes.statusCode, 200, `expected 200 for check-in-only staff, got ${allowedRes.statusCode}: ${JSON.stringify(allowedRes.body)}`);
});

test('setupContactlessCheckIn: an unauthorized staff member (different hotel) is rejected before any TTLock work happens', async () => {
  const otherHotel = await Hotel.create({
    name: 'Unrelated Hotel',
    description: 'desc',
    location: { address: '2 St', city: 'Lagos', country: 'Nigeria' },
    hostId: new mongoose.Types.ObjectId()
  });
  const outsiderStaff = await Staff.create({
    hotelId: otherHotel._id,
    userId: new mongoose.Types.ObjectId(),
    firstName: 'Outsider', lastName: 'Staffer', email: `outsider-${Date.now()}@example.com`,
    position: 'receptionist', employmentType: 'full-time',
    status: 'active'
  });

  try {
    const booking = await makeBooking();
    const res = fakeRes();
    await setupContactlessCheckIn(bookingReq(booking, outsiderStaff), res);
    assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    const reloaded = await Booking.findById(booking._id);
    assert.equal(reloaded.contactlessCheckIn?.enabled, false, 'no contactless check-in setup should have occurred (schema default, unchanged)');
  } finally {
    await Staff.deleteOne({ _id: outsiderStaff._id });
    await Hotel.deleteOne({ _id: otherHotel._id });
  }
});

test("'canManageBookings' no longer exists as a permission key — it was labeled but never enforced", () => {
  assert.ok(!PERMISSION_KEYS.includes('canManageBookings'), 'canManageBookings should have been removed, not left dead');
});

test("'canAssignRooms', 'canViewGuests', 'canViewPayroll' no longer exist as permission keys — labeled but never enforced", () => {
  for (const key of ['canAssignRooms', 'canViewGuests', 'canViewPayroll']) {
    assert.ok(!PERMISSION_KEYS.includes(key), `${key} should have been removed, not left dead`);
  }
});

test('resolvePermissions: an explicit false override always sticks, even against the manager template default of true', () => {
  const resolved = resolvePermissions('manager', { canManageStaff: false });
  assert.equal(resolved.canManageStaff, false);
  assert.equal(resolved.canManageOrders, true, 'other manager-template grants should be untouched');
});

test('resolvePermissions: every key in PERMISSION_KEYS is present on every resolved permission set', () => {
  for (const position of ['receptionist', 'housekeeping', 'maintenance', 'security', 'manager', 'chef', 'bar-attendant', 'waiter', 'other']) {
    const resolved = resolvePermissions(position, {});
    for (const key of PERMISSION_KEYS) {
      assert.ok(key in resolved, `${position} template is missing key ${key}`);
    }
  }
});

// updateHotel: canChangeHotelSettings was a real toggle in the staff form with no backend
// enforcement at all — the route itself was host/admin-only, so granting it had zero effect.
// Now a staff member with the permission can update the hotel's profile/policy fields, while
// bank/payout details stay on a completely separate, still host/admin-only route.
test('updateHotel: a staff member WITH canChangeHotelSettings can update the hotel', async () => {
  const grantedStaff = await Staff.create({
    hotelId: hotel._id,
    userId: new mongoose.Types.ObjectId(),
    firstName: 'Settings', lastName: 'Granted', email: `settings-granted-${Date.now()}@example.com`,
    position: 'manager', employmentType: 'full-time',
    permissions: { canChangeHotelSettings: true },
    status: 'active'
  });
  try {
    const res = fakeRes();
    await updateHotel(
      { params: { id: hotel._id.toString() }, body: { description: 'Updated by a manager' }, user: { userId: grantedStaff.userId.toString(), role: 'staff' } },
      res
    );
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.hotel.description, 'Updated by a manager');
  } finally {
    await Staff.deleteOne({ _id: grantedStaff._id });
    await Hotel.findByIdAndUpdate(hotel._id, { description: 'desc' });
  }
});

test('updateHotel: a staff member WITHOUT canChangeHotelSettings cannot update the hotel', async () => {
  const res = fakeRes();
  await updateHotel(
    { params: { id: hotel._id.toString() }, body: { description: 'Should not stick' }, user: { userId: checkInOnlyStaff.userId.toString(), role: 'staff' } },
    res
  );
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const reloaded = await Hotel.findById(hotel._id);
  assert.equal(reloaded.description, 'desc', 'the hotel must be untouched');
});

test('updateHotel: a staff member at a DIFFERENT hotel with canChangeHotelSettings cannot update this one', async () => {
  const otherHotel = await Hotel.create({
    name: 'Settings Cross-Hotel Test',
    description: 'desc',
    location: { address: '3 St', city: 'Lagos', country: 'Nigeria' },
    hostId: new mongoose.Types.ObjectId()
  });
  const crossHotelStaff = await Staff.create({
    hotelId: otherHotel._id,
    userId: new mongoose.Types.ObjectId(),
    firstName: 'Cross', lastName: 'Hotel', email: `cross-hotel-${Date.now()}@example.com`,
    position: 'manager', employmentType: 'full-time',
    permissions: { canChangeHotelSettings: true },
    status: 'active'
  });
  try {
    const res = fakeRes();
    await updateHotel(
      { params: { id: hotel._id.toString() }, body: { description: 'Should not stick' }, user: { userId: crossHotelStaff.userId.toString(), role: 'staff' } },
      res
    );
    assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  } finally {
    await Staff.deleteOne({ _id: crossHotelStaff._id });
    await Hotel.deleteOne({ _id: otherHotel._id });
  }
});

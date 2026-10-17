// Regression tests for getStaffSchedules authorization (backend/controllers/staffController.js).
//
// Reported bug: getStaffSchedules had no authorization check beyond a valid login — any
// authenticated user (guest, staff at an unrelated hotel) could read any staff member's
// schedule just by guessing/enumerating a staffId. The code already carries a fix (a
// canManageHotel(..., 'canManageSchedules') check, plus a self-view carve-out) with a comment
// describing this exact bug as already addressed — these tests exist to actually prove that,
// not just trust the comment, and to lock the behavior in against regression.
//
// Hits a real MongoDB for the same reason as the other tests in this directory. Creates and
// deletes its own Hotel/Staff/StaffSchedule/User documents, but MONGODB_URI must still point
// at the isolated test_copy database.
//
// Run with (from backend/):
//   MONGODB_URI="<atlas-uri>/test_copy" node --test tests/staffScheduleAuthorization.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI || !MONGO_URI.includes('test_copy')) {
  throw new Error(
    'Refusing to run: these tests create and delete real Hotel/Staff/StaffSchedule documents, ' +
    'so MONGODB_URI must point at the isolated test_copy database, never the production "test" ' +
    'database. Run: MONGODB_URI="<your-atlas-uri>/test_copy" node --test tests/staffScheduleAuthorization.test.js'
  );
}

const mongoose = (await import('mongoose')).default;
const { default: Hotel } = await import('../models/Hotel.js');
const { default: Staff } = await import('../models/Staff.js');
const { default: StaffSchedule } = await import('../models/StaffSchedule.js');
const { getStaffSchedules } = await import('../controllers/staffController.js');

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

const hostAId = new mongoose.Types.ObjectId();
const hostBId = new mongoose.Types.ObjectId();
let hotelA, hotelB;
let targetStaff, targetSchedule;
let managerAtHotelA, managerAtHotelB, unprivilegedStaffAtHotelA;

before(async () => {
  await mongoose.connect(MONGO_URI);

  hotelA = await Hotel.create({
    name: 'Schedule Auth Test Hotel A',
    description: 'desc',
    location: { address: '1 St', city: 'Lagos', country: 'Nigeria' },
    hostId: hostAId
  });
  hotelB = await Hotel.create({
    name: 'Schedule Auth Test Hotel B',
    description: 'desc',
    location: { address: '2 St', city: 'Lagos', country: 'Nigeria' },
    hostId: hostBId
  });

  targetStaff = await Staff.create({
    hotelId: hotelA._id,
    userId: new mongoose.Types.ObjectId(),
    firstName: 'Target', lastName: 'Staffer', email: `target-${Date.now()}@example.com`,
    position: 'receptionist', employmentType: 'full-time',
    status: 'active'
  });
  targetSchedule = await StaffSchedule.create({
    staffId: targetStaff._id,
    hotelId: hotelA._id,
    scheduleType: 'recurring',
    dayOfWeek: ['Monday'],
    startTime: '09:00',
    endTime: '17:00'
  });

  managerAtHotelA = await Staff.create({
    hotelId: hotelA._id,
    userId: new mongoose.Types.ObjectId(),
    firstName: 'Manager', lastName: 'AtA', email: `manager-a-${Date.now()}@example.com`,
    position: 'manager', employmentType: 'full-time',
    permissions: { canManageSchedules: true },
    status: 'active'
  });
  managerAtHotelB = await Staff.create({
    hotelId: hotelB._id,
    userId: new mongoose.Types.ObjectId(),
    firstName: 'Manager', lastName: 'AtB', email: `manager-b-${Date.now()}@example.com`,
    position: 'manager', employmentType: 'full-time',
    permissions: { canManageSchedules: true },
    status: 'active'
  });
  unprivilegedStaffAtHotelA = await Staff.create({
    hotelId: hotelA._id,
    userId: new mongoose.Types.ObjectId(),
    firstName: 'NoAccess', lastName: 'Staffer', email: `noaccess-${Date.now()}@example.com`,
    position: 'housekeeping', employmentType: 'full-time',
    permissions: { canManageSchedules: false },
    status: 'active'
  });
});

after(async () => {
  await StaffSchedule.deleteOne({ _id: targetSchedule._id });
  await Staff.deleteMany({ _id: { $in: [targetStaff._id, managerAtHotelA._id, managerAtHotelB._id, unprivilegedStaffAtHotelA._id] } });
  await Hotel.deleteMany({ _id: { $in: [hotelA._id, hotelB._id] } });
  await mongoose.disconnect();
});

function req(role, userId) {
  return { params: { staffId: targetStaff._id.toString() }, query: {}, user: { userId: userId.toString(), role } };
}

test('a guest cannot read another staff member\'s schedule', async () => {
  const res = fakeRes();
  await getStaffSchedules(req('guest', new mongoose.Types.ObjectId()), res);
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
});

test('an active staff member at an UNRELATED hotel cannot read this schedule, even with canManageSchedules there', async () => {
  const res = fakeRes();
  await getStaffSchedules(req('staff', managerAtHotelB.userId), res);
  assert.equal(res.statusCode, 403, `expected 403 — cross-hotel access must be blocked, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
});

test('an active staff member at the SAME hotel without canManageSchedules cannot read another staffer\'s schedule', async () => {
  const res = fakeRes();
  await getStaffSchedules(req('staff', unprivilegedStaffAtHotelA.userId), res);
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
});

test('a manager with canManageSchedules AT THE SAME HOTEL can read the schedule', async () => {
  const res = fakeRes();
  await getStaffSchedules(req('staff', managerAtHotelA.userId), res);
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.length, 1);
});

test('a staff member can read their own schedule without needing canManageSchedules', async () => {
  const res = fakeRes();
  await getStaffSchedules(req('staff', targetStaff.userId), res);
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
});

test('the host who owns the hotel can read the schedule', async () => {
  const res = fakeRes();
  await getStaffSchedules(req('host', hostAId), res);
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
});

test('a host who owns a DIFFERENT hotel cannot read the schedule', async () => {
  const res = fakeRes();
  await getStaffSchedules(req('host', hostBId), res);
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
});

test('admin can read any staff member\'s schedule', async () => {
  const res = fakeRes();
  await getStaffSchedules(req('admin', new mongoose.Types.ObjectId()), res);
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
});

test('a nonexistent staffId returns 404, not a silent 403 or a leak', async () => {
  const res = fakeRes();
  const badReq = req('admin', new mongoose.Types.ObjectId());
  badReq.params.staffId = new mongoose.Types.ObjectId().toString();
  await getStaffSchedules(badReq, res);
  assert.equal(res.statusCode, 404);
});

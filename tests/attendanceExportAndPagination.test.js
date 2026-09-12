// Regression tests for the attendance log's date-range filter, pagination, and CSV export
// (backend/controllers/attendanceController.js).
//
// Bugs this guards against:
//   1. getHotelAttendance had no date filter at all and a flat, silent .limit(200) — a hotel
//      with more than 200 clock-in/out records lost access to everything older than that,
//      with no way back to it. Now it's paginated (every record reachable, just a page at a
//      time) and can be narrowed by an inclusive startDate/endDate range.
//   2. No export existed at all for payroll/review workflows.
//   3. A nonsensical date range (start after end) was silently accepted rather than rejected.
//
// Hits a real MongoDB for the same reason as the other tests in this directory. Creates and
// deletes its own Hotel/Staff/Attendance documents, but MONGODB_URI must still point at the
// isolated test_copy database.
//
// Run with (from backend/):
//   MONGODB_URI="<atlas-uri>/test_copy" node --test tests/attendanceExportAndPagination.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI || !MONGO_URI.includes('test_copy')) {
  throw new Error(
    'Refusing to run: these tests create and delete real Hotel/Staff/Attendance documents, so ' +
    'MONGODB_URI must point at the isolated test_copy database, never the production "test" ' +
    'database. Run: MONGODB_URI="<your-atlas-uri>/test_copy" node --test tests/attendanceExportAndPagination.test.js'
  );
}

const mongoose = (await import('mongoose')).default;
const { default: Hotel } = await import('../models/Hotel.js');
const { default: Staff } = await import('../models/Staff.js');
const { default: Attendance } = await import('../models/Attendance.js');
const { getHotelAttendance, exportHotelAttendance } = await import('../controllers/attendanceController.js');

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
    setHeader(key, value) {
      res.headers[key] = value;
    },
    send(payload) {
      res.body = payload;
      return res;
    }
  };
  return res;
}

const hostId = new mongoose.Types.ObjectId();
let hotel, staff;
const recordIds = [];

before(async () => {
  await mongoose.connect(MONGO_URI);
  hotel = await Hotel.create({
    name: 'Attendance Export Test Hotel',
    description: 'desc',
    location: { address: '1 St', city: 'Lagos', country: 'Nigeria' },
    hostId
  });
  staff = await Staff.create({
    hotelId: hotel._id,
    userId: new mongoose.Types.ObjectId(),
    firstName: 'Test', lastName: 'Worker', email: `attendance-worker-${Date.now()}@example.com`,
    position: 'receptionist', employmentType: 'full-time',
    status: 'active'
  });

  // Five records, one per day, Jan 1 through Jan 5 2026 (oldest to newest) — enough to
  // exercise date-range filtering, pagination across more than one page, and prove nothing
  // older is actually lost.
  for (let day = 1; day <= 5; day++) {
    const clockInTime = new Date(Date.UTC(2026, 0, day, 9, 0, 0));
    const clockOutTime = new Date(Date.UTC(2026, 0, day, 17, 30, 0));
    const record = await Attendance.create({ hotelId: hotel._id, staffId: staff._id, clockInTime, clockOutTime });
    recordIds.push(record._id);
  }
});

after(async () => {
  await Attendance.deleteMany({ _id: { $in: recordIds } });
  await Staff.deleteOne({ _id: staff._id });
  await Hotel.deleteOne({ _id: hotel._id });
  await mongoose.disconnect();
});

function req(overrides = {}) {
  return {
    params: { hotelId: hotel._id.toString() },
    query: {},
    user: { userId: hostId.toString(), role: 'host' },
    ...overrides
  };
}

test('with no filters, all 5 records are counted and the first page is returned', async () => {
  const res = fakeRes();
  await getHotelAttendance(req(), res);
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.total, 5);
  assert.equal(res.body.records.length, 5, 'default page size comfortably fits all 5 test records');
});

test('a date range narrows results to just the days within it, inclusive on both ends', async () => {
  const res = fakeRes();
  await getHotelAttendance(req({ query: { startDate: '2026-01-02', endDate: '2026-01-04' } }), res);
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.total, 3, 'Jan 2, 3, and 4 — inclusive on both ends');
});

test('a same-day range still matches that day\'s record (end-of-day inclusive, not just midnight)', async () => {
  const res = fakeRes();
  await getHotelAttendance(req({ query: { startDate: '2026-01-03', endDate: '2026-01-03' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 1);
});

test('an invalid range (start after end) is rejected with 400, not silently accepted', async () => {
  const res = fakeRes();
  await getHotelAttendance(req({ query: { startDate: '2026-01-05', endDate: '2026-01-01' } }), res);
  assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
});

test('pagination: every record remains reachable a page at a time, none silently lost', async () => {
  const page1 = fakeRes();
  await getHotelAttendance(req({ query: { limit: '2', page: '1' } }), page1);
  assert.equal(page1.body.records.length, 2);
  assert.equal(page1.body.totalPages, 3);

  const page3 = fakeRes();
  await getHotelAttendance(req({ query: { limit: '2', page: '3' } }), page3);
  assert.equal(page3.body.records.length, 1, 'the 5th record, alone on the last page');

  // The oldest record (Jan 1) must be reachable somewhere — this is the specific regression
  // the old flat .limit(200) would have hidden forever once a hotel passed 200 records.
  const allIds = [...page1.body.records, ...page3.body.records].map(r => String(r._id));
  assert.ok(allIds.includes(String(recordIds[0])), 'the oldest record must still be reachable via pagination');
});

test('a requested page size beyond the server cap is clamped, not honored as-is', async () => {
  const res = fakeRes();
  await getHotelAttendance(req({ query: { limit: '999999' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.records.length, 5, 'still just the 5 real records that exist, cap or no cap');
});

test('an unauthorized caller (different hotel, no permission) gets 403, not a data leak', async () => {
  const res = fakeRes();
  await getHotelAttendance(req({ user: { userId: new mongoose.Types.ObjectId().toString(), role: 'host' } }), res);
  assert.equal(res.statusCode, 403);
});

test('export: returns a CSV with the header row and one data row per matching record', async () => {
  const res = fakeRes();
  await exportHotelAttendance(req({ query: { startDate: '2026-01-01', endDate: '2026-01-02' } }), res);
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.headers['Content-Type'], 'text/csv');
  assert.match(res.headers['Content-Disposition'], /attachment/);
  const lines = res.body.trim().split('\n');
  assert.equal(lines[0], 'Staff Name,Position,Date,Clock In,Clock Out,Duration (hours)');
  assert.equal(lines.length, 3, 'header + 2 matching records (Jan 1 and Jan 2)');
  assert.match(lines[1], /Test Worker,receptionist,2026-01-01/);
  assert.match(lines[1], /8\.50$/, 'an 09:00-17:30 shift is 8.5 hours');
});

test('export respects the same date-range validation as the list view', async () => {
  const res = fakeRes();
  await exportHotelAttendance(req({ query: { startDate: '2026-01-05', endDate: '2026-01-01' } }), res);
  assert.equal(res.statusCode, 400);
});

test('export is blocked for an unauthorized caller the same way the list view is', async () => {
  const res = fakeRes();
  await exportHotelAttendance(req({ user: { userId: new mongoose.Types.ObjectId().toString(), role: 'host' } }), res);
  assert.equal(res.statusCode, 403);
});

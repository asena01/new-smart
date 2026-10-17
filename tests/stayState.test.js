import test from 'node:test';
import assert from 'node:assert/strict';
import { isPhysicallyInHouse } from '../utils/stayState.js';

const today = new Date('2026-10-16T12:00:00');
const day = offset => new Date(2026, 9, 16 + offset, 14, 0, 0);
const stay = overrides => ({
  status: 'confirmed',
  checkInDate: day(-1),
  checkOutDate: day(2),
  checkInInfo: { actualCheckInTime: day(-1) },
  checkOutInfo: {},
  ...overrides
});

test('a checked-in guest mid-stay is in-house', () => {
  assert.equal(isPhysicallyInHouse(stay({}), today), true);
});

test('a guest departing today who has not checked out is still in-house', () => {
  assert.equal(isPhysicallyInHouse(stay({ checkOutDate: day(0) }), today), true);
});

test('an overstay (past check-out date, never checked out) is still in-house', () => {
  assert.equal(isPhysicallyInHouse(stay({ checkOutDate: day(-1) }), today), true);
});

test('a guest who verified early for a later arrival day is not in-house yet', () => {
  assert.equal(isPhysicallyInHouse(stay({ checkInDate: day(1) }), today), false);
});

test('checked out, cancelled and never-checked-in bookings are not in-house', () => {
  assert.equal(isPhysicallyInHouse(stay({ checkOutInfo: { actualCheckOutTime: day(0) } }), today), false);
  assert.equal(isPhysicallyInHouse(stay({ status: 'cancelled' }), today), false);
  assert.equal(isPhysicallyInHouse(stay({ checkInInfo: {} }), today), false);
});

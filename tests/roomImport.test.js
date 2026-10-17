import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRoomRows, MAX_IMPORT_ROOMS } from '../utils/roomImport.js';

const good = overrides => ({ roomNumber: '101', type: 'Classic', capacity: '2', basePrice: '70000', ...overrides });

test('a good row is accepted and cleaned up', () => {
  const { rooms, errors } = validateRoomRows([good({ basePrice: '₦70,000', description: ' Sea view ' })]);
  assert.deepEqual(errors, []);
  assert.deepEqual(rooms[0], { roomNumber: '101', type: 'Classic', capacity: 2, basePrice: 70000, description: 'Sea view', checkInType: 'standard', status: 'available' });
});

test('a discount is kept only when it is lower than the price', () => {
  assert.equal(validateRoomRows([good({ discountPrice: '60000' })]).rooms[0].discountPrice, 60000);
  assert.match(validateRoomRows([good({ discountPrice: '70000' })]).errors[0].message, /lower than the price/);
  assert.equal(validateRoomRows([good({ discountPrice: '0' })]).rooms[0].discountPrice, undefined);
});

test('every problem on every row is reported together, with the row number', () => {
  const { rooms, errors } = validateRoomRows([good({ roomNumber: '' }), good({ roomNumber: '102', capacity: '2.5' }), good({ roomNumber: '103', basePrice: 'abc' })]);
  assert.equal(rooms.length, 0);
  assert.deepEqual(errors.map(e => e.row), [1, 2, 3]);
});

test('room numbers already in the hotel, or repeated in the file, are rejected', () => {
  const existing = validateRoomRows([good()], ['101']);
  assert.match(existing.errors[0].message, /already exists/);
  const repeated = validateRoomRows([good(), good()]);
  assert.match(repeated.errors[0].message, /repeated \(also on row 1\)/);
  assert.equal(repeated.errors[0].row, 2);
});

test('room numbers are compared ignoring case and spaces', () => {
  assert.match(validateRoomRows([good({ roomNumber: ' g1 ' })], ['G1']).errors[0].message, /already exists/);
});

test('capacity, check-in type and status are checked', () => {
  assert.match(validateRoomRows([good({ capacity: '0' })]).errors[0].message, /Capacity/);
  assert.match(validateRoomRows([good({ checkInType: 'magic' })]).errors[0].message, /Check-in type/);
  assert.match(validateRoomRows([good({ status: 'occupied' })]).errors[0].message, /Status/);
  assert.equal(validateRoomRows([good({ status: 'Out of order' })]).rooms[0].status, 'out-of-order');
});

test('an empty file and an oversized file are refused', () => {
  assert.match(validateRoomRows([]).errors[0].message, /no rooms/);
  const tooMany = Array.from({ length: MAX_IMPORT_ROOMS + 1 }, (_, i) => good({ roomNumber: String(i + 1) }));
  assert.match(validateRoomRows(tooMany).errors[0].message, /at most/);
});

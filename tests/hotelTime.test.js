import test from 'node:test';
import assert from 'node:assert/strict';
import { combineDateAndTime, isValidTimeZone, resolveHotelTimeZone } from '../utils/hotelTime.js';

test('combines a booking date with Helsinki hotel-local time during daylight saving', () => {
  const result = combineDateAndTime('2026-08-29T00:00:00.000Z', '12:00', 'Europe/Helsinki');
  assert.equal(result.toISOString(), '2026-08-29T09:00:00.000Z');
});

test('combines a booking date with Lagos hotel-local time', () => {
  const result = combineDateAndTime('2026-08-29T00:00:00.000Z', '12:00', 'Africa/Lagos');
  assert.equal(result.toISOString(), '2026-08-29T11:00:00.000Z');
});

test('uses the winter offset for a timezone that observes daylight saving', () => {
  const result = combineDateAndTime('2026-12-15T00:00:00.000Z', '12:00', 'Europe/Helsinki');
  assert.equal(result.toISOString(), '2026-12-15T10:00:00.000Z');
});

test('falls back to UTC for an invalid timezone', () => {
  const result = combineDateAndTime('2026-08-29T00:00:00.000Z', '12:00', 'Not/AZone');
  assert.equal(result.toISOString(), '2026-08-29T12:00:00.000Z');
  assert.equal(isValidTimeZone('Not/AZone'), false);
});

test('derives Lagos time for a Nigerian hotel when an older client drops timezone', () => {
  assert.equal(resolveHotelTimeZone({
    location: { country: 'Nigeria' },
    policies: { timeZone: 'UTC' }
  }), 'Africa/Lagos');
});

// Tests for the forgot-password (forgotPassword/resetPassword) and self-service account
// deletion (deleteAccount) flows in backend/controllers/authController.js.
//
// The reset email itself isn't sent (RESEND_API_KEY is cleared, so sendEmail throws and
// forgotPassword just logs it) — instead the test overwrites the stored code hash with the
// hash of a known code, which exercises exactly the same verification path.
//
// Hits a real MongoDB for the same reason as the other tests in this directory. Creates and
// deletes its own User documents, but MONGODB_URI must still point at the isolated test_copy
// database.
//
// Run with (from backend/):
//   MONGODB_URI="<atlas-uri>/test_copy" node --test tests/passwordResetAndAccountDeletion.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config({ override: false });

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI || !MONGO_URI.includes('test_copy')) {
  throw new Error(
    'Refusing to run: these tests create and delete real User documents, so MONGODB_URI must ' +
    'point at the isolated test_copy database, never the production "test" database. Run: ' +
    'MONGODB_URI="<your-atlas-uri>/test_copy" node --test tests/passwordResetAndAccountDeletion.test.js'
  );
}

delete process.env.RESEND_API_KEY;

const mongoose = (await import('mongoose')).default;
const { default: User } = await import('../models/User.js');
const { forgotPassword, resetPassword, deleteAccount } = await import('../controllers/authController.js');

const mockRes = () => {
  const res = { statusCode: null, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  return res;
};

const call = async (handler, req) => {
  const res = mockRes();
  await handler(req, res);
  return res;
};

const hash = code => crypto.createHash('sha256').update(code).digest('hex');
const email = `reset-test-${Date.now()}@example.com`;
let userId;

before(async () => {
  await mongoose.connect(MONGO_URI);
  const user = await User.create({ firstName: 'Reset', lastName: 'Tester', email, password: 'OldPass123', role: 'guest' });
  userId = user._id;
});

after(async () => {
  await User.deleteOne({ _id: userId });
  await mongoose.disconnect();
});

const setKnownCode = async code => {
  await User.updateOne({ _id: userId }, { $set: { 'passwordReset.codeHash': hash(code) } });
};

test('forgotPassword returns the same generic response for unknown emails', async () => {
  const known = await call(forgotPassword, { body: { email } });
  const unknown = await call(forgotPassword, { body: { email: 'nobody-here@example.com' } });
  assert.equal(known.statusCode, 200);
  assert.equal(unknown.statusCode, 200);
  assert.deepEqual(known.body, unknown.body);

  const stored = await User.findById(userId).select('+passwordReset.codeHash +passwordReset.expiresAt');
  assert.ok(stored.passwordReset.codeHash, 'a code hash should be stored');
  assert.ok(stored.passwordReset.expiresAt > new Date(), 'expiry should be in the future');
});

test('resetPassword rejects a wrong code and counts the attempt', async () => {
  await call(forgotPassword, { body: { email } });
  await setKnownCode('123456');
  const res = await call(resetPassword, { body: { email, code: '000000', newPassword: 'NewPass123' } });
  assert.equal(res.statusCode, 400);
  const stored = await User.findById(userId).select('+passwordReset.attempts');
  assert.equal(stored.passwordReset.attempts, 1);
});

test('resetPassword locks out after 5 wrong attempts even with the right code', async () => {
  await call(forgotPassword, { body: { email } });
  await setKnownCode('123456');
  for (let i = 0; i < 5; i++) {
    await call(resetPassword, { body: { email, code: '999999', newPassword: 'NewPass123' } });
  }
  const res = await call(resetPassword, { body: { email, code: '123456', newPassword: 'NewPass123' } });
  assert.equal(res.statusCode, 400);
});

test('resetPassword rejects an expired code', async () => {
  await call(forgotPassword, { body: { email } });
  await setKnownCode('123456');
  await User.updateOne({ _id: userId }, { $set: { 'passwordReset.expiresAt': new Date(Date.now() - 1000) } });
  const res = await call(resetPassword, { body: { email, code: '123456', newPassword: 'NewPass123' } });
  assert.equal(res.statusCode, 400);
});

test('resetPassword enforces the password rules', async () => {
  await call(forgotPassword, { body: { email } });
  await setKnownCode('123456');
  const res = await call(resetPassword, { body: { email, code: '123456', newPassword: 'short' } });
  assert.equal(res.statusCode, 400);
});

test('resetPassword with the right code changes the password and clears the code', async () => {
  await call(forgotPassword, { body: { email } });
  await setKnownCode('123456');
  const res = await call(resetPassword, { body: { email, code: '123456', newPassword: 'NewPass123' } });
  assert.equal(res.statusCode, 200);

  const stored = await User.findById(userId).select('+password +passwordReset.codeHash');
  assert.ok(await stored.comparePassword('NewPass123'));
  assert.ok(!stored.passwordReset?.codeHash, 'code should be single-use');

  const reuse = await call(resetPassword, { body: { email, code: '123456', newPassword: 'Another123' } });
  assert.equal(reuse.statusCode, 400);
});

test('deleteAccount requires the correct password', async () => {
  const res = await call(deleteAccount, { user: { userId }, body: { password: 'wrong' } });
  assert.equal(res.statusCode, 401);
});

test('deleteAccount refuses non-guest accounts', async () => {
  await User.updateOne({ _id: userId }, { role: 'staff' });
  const res = await call(deleteAccount, { user: { userId }, body: { password: 'NewPass123' } });
  assert.equal(res.statusCode, 403);
  await User.updateOne({ _id: userId }, { role: 'guest' });
});

test('deleteAccount scrubs personal data and blocks reset for the old email', async () => {
  const res = await call(deleteAccount, { user: { userId }, body: { password: 'NewPass123' } });
  assert.equal(res.statusCode, 200);

  const stored = await User.findById(userId).select('+password');
  assert.equal(stored.status, 'deleted');
  assert.equal(stored.firstName, 'Deleted');
  assert.notEqual(stored.email, email);
  assert.ok(!(await stored.comparePassword('NewPass123')));

  const forgot = await call(forgotPassword, { body: { email } });
  assert.equal(forgot.statusCode, 200);
  const again = await User.findById(userId).select('+passwordReset.codeHash');
  assert.ok(!again.passwordReset?.codeHash, 'no reset code should be issued for a deleted account');
});

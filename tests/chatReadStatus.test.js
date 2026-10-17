// Regression tests for chat read-status (backend/controllers/chatController.js).
//
// Bug this guards against: markMessagesAsRead matched on `{ bookingId, isRead: false }` with
// no senderType filter and no authorization check at all — opening a conversation from EITHER
// side marked BOTH sides' messages as read, and any authenticated caller could mark any
// booking's messages read by guessing/knowing its id.
//
// Hits a real MongoDB for the same reason as the other tests in this directory. Creates and
// deletes its own Hotel/Booking/ChatMessage documents, but MONGODB_URI must still point at the
// isolated test_copy database.
//
// Run with (from backend/):
//   MONGODB_URI="<atlas-uri>/test_copy" node --test tests/chatReadStatus.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI || !MONGO_URI.includes('test_copy')) {
  throw new Error(
    'Refusing to run: these tests create and delete real Hotel/Booking/ChatMessage documents, ' +
    'so MONGODB_URI must point at the isolated test_copy database, never the production "test" ' +
    'database. Run: MONGODB_URI="<your-atlas-uri>/test_copy" node --test tests/chatReadStatus.test.js'
  );
}

const mongoose = (await import('mongoose')).default;
const { default: Hotel } = await import('../models/Hotel.js');
const { default: Booking } = await import('../models/Booking.js');
const { default: ChatMessage } = await import('../models/Chat.js');
const { markMessagesAsRead, getUnreadCount } = await import('../controllers/chatController.js');

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
const bookingIds = [];
const messageIds = [];

async function makeConversation() {
  const hostId = new mongoose.Types.ObjectId();
  const guestId = new mongoose.Types.ObjectId();
  const hotel = await Hotel.create({
    name: 'Chat Read Status Test Hotel',
    description: 'desc',
    location: { address: '1 St', city: 'Lagos', country: 'Nigeria' },
    hostId
  });
  hotelIds.push(hotel._id);

  const booking = await Booking.create({
    hotelId: hotel._id, userId: guestId, roomId: '101',
    checkInDate: new Date(), checkOutDate: new Date(Date.now() + 86400000), totalPrice: 100
  });
  bookingIds.push(booking._id);

  const guestMessage = await ChatMessage.create({
    bookingId: booking._id, hotelId: hotel._id, guestId,
    senderType: 'guest', senderName: 'Test Guest', senderId: guestId,
    messageText: 'Hi, is my room ready?', isRead: false
  });
  const staffMessage = await ChatMessage.create({
    bookingId: booking._id, hotelId: hotel._id, guestId,
    senderType: 'hotel-staff', senderName: 'Front Desk', senderId: hostId,
    messageText: 'Yes, whenever you arrive!', isRead: false
  });
  messageIds.push(guestMessage._id, staffMessage._id);

  return { hotel, booking, hostId, guestId, guestMessage, staffMessage };
}

before(async () => {
  await mongoose.connect(MONGO_URI);
});

after(async () => {
  await ChatMessage.deleteMany({ _id: { $in: messageIds } });
  await Booking.deleteMany({ _id: { $in: bookingIds } });
  await Hotel.deleteMany({ _id: { $in: hotelIds } });
  await mongoose.disconnect();
});

test('a guest opening the conversation only marks the hotel-staff message read, not their own', async () => {
  const { booking, guestId, guestMessage, staffMessage } = await makeConversation();

  const req = { params: { bookingId: booking._id.toString() }, user: { userId: guestId.toString(), role: 'guest' } };
  const res = fakeRes();

  await markMessagesAsRead(req, res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const guestMsgFromDb = await ChatMessage.findById(guestMessage._id);
  const staffMsgFromDb = await ChatMessage.findById(staffMessage._id);
  assert.equal(guestMsgFromDb.isRead, false, "the guest's own message must stay unread");
  assert.equal(staffMsgFromDb.isRead, true, 'the staff message the guest actually read should be marked read');
});

test('the host opening the conversation only marks the guest message read, not their own staff message', async () => {
  const { hotel, booking, hostId, guestMessage, staffMessage } = await makeConversation();

  const req = { params: { bookingId: booking._id.toString() }, user: { userId: hostId.toString(), role: 'host' } };
  const res = fakeRes();

  await markMessagesAsRead(req, res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const guestMsgFromDb = await ChatMessage.findById(guestMessage._id);
  const staffMsgFromDb = await ChatMessage.findById(staffMessage._id);
  assert.equal(guestMsgFromDb.isRead, true, 'the guest message the host actually read should be marked read');
  assert.equal(staffMsgFromDb.isRead, false, "the host's own staff message must stay unread");
});

test('an unrelated third party cannot mark another conversation\'s messages as read', async () => {
  const { booking, guestMessage, staffMessage } = await makeConversation();
  const strangerId = new mongoose.Types.ObjectId();

  const req = { params: { bookingId: booking._id.toString() }, user: { userId: strangerId.toString(), role: 'guest' } };
  const res = fakeRes();

  await markMessagesAsRead(req, res);

  assert.equal(res.statusCode, 403);
  const guestMsgFromDb = await ChatMessage.findById(guestMessage._id);
  const staffMsgFromDb = await ChatMessage.findById(staffMessage._id);
  assert.equal(guestMsgFromDb.isRead, false, 'nothing should change for an unauthorized caller');
  assert.equal(staffMsgFromDb.isRead, false, 'nothing should change for an unauthorized caller');
});

test('getUnreadCount reports the guest message count for the host, and the staff message count for the guest', async () => {
  const { booking, hostId, guestId } = await makeConversation();

  const guestReq = { params: { bookingId: booking._id.toString() }, user: { userId: guestId.toString(), role: 'guest' } };
  const guestRes = fakeRes();
  await getUnreadCount(guestReq, guestRes);
  assert.equal(guestRes.statusCode, 200);
  assert.equal(guestRes.body.unreadCount, 1, 'the guest has exactly one unread staff message');

  const hostReq = { params: { bookingId: booking._id.toString() }, user: { userId: hostId.toString(), role: 'host' } };
  const hostRes = fakeRes();
  await getUnreadCount(hostReq, hostRes);
  assert.equal(hostRes.statusCode, 200);
  assert.equal(hostRes.body.unreadCount, 1, 'the host has exactly one unread guest message');
});

test('marking as read does not affect an unrelated conversation\'s unread counts', async () => {
  const convoA = await makeConversation();
  const convoB = await makeConversation();

  const req = { params: { bookingId: convoA.booking._id.toString() }, user: { userId: convoA.guestId.toString(), role: 'guest' } };
  await markMessagesAsRead(req, fakeRes());

  const bStaffMsg = await ChatMessage.findById(convoB.staffMessage._id);
  const bGuestMsg = await ChatMessage.findById(convoB.guestMessage._id);
  assert.equal(bStaffMsg.isRead, false, "conversation B's messages must be untouched by A's mark-as-read");
  assert.equal(bGuestMsg.isRead, false, "conversation B's messages must be untouched by A's mark-as-read");
});

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
const targetUri = process.env.MONGODB_URI.replace(/\/test(\?|$)/, '/test_copy$1');
const conn = await mongoose.createConnection(targetUri).asPromise();
const users = conn.db.collection('users');
const hotels = conn.db.collection('hotels');
const bookings = conn.db.collection('bookings');

const guest = await users.findOne({ email: 'jane-doe-test@example.com' });
const hotel = await hotels.findOne({ name: /grand hotel/i });
const lockedRoom = hotel.rooms.find(r => r.smartLockIntegration?.deviceId || r.checkInOptions?.includes?.('ttlock') || r.smartLockEnabled);
console.log('lockedRoom candidate:', lockedRoom ? lockedRoom.roomNumber : 'none found', JSON.stringify(hotel.rooms.map(r => ({num: r.roomNumber, checkInOptions: r.checkInOptions, smartLock: !!r.smartLockIntegration?.deviceId}))));

const checkIn = new Date(); checkIn.setDate(checkIn.getDate() + 10); checkIn.setHours(0,0,0,0);
const checkOut = new Date(checkIn); checkOut.setDate(checkOut.getDate() + 2);

const doc = {
  _id: new mongoose.Types.ObjectId(),
  userId: guest._id,
  hotelId: hotel._id,
  roomId: lockedRoom ? lockedRoom.roomNumber : hotel.rooms[0].roomNumber,
  bookingReference: 'TESTFUTURE1',
  checkInDate: checkIn,
  checkOutDate: checkOut,
  numberOfGuests: 1,
  totalPrice: 100000,
  currency: 'NGN',
  status: 'confirmed',
  paymentStatus: 'paid',
  guestName: 'Jane Doe',
  checkInInfo: {},
  checkOutInfo: {},
  contactlessCheckIn: {},
  createdAt: new Date(),
  updatedAt: new Date()
};
const res = await bookings.insertOne(doc);
console.log('Inserted future booking:', res.insertedId.toString(), 'roomId:', doc.roomId, 'checkIn:', checkIn.toISOString());
await conn.close();

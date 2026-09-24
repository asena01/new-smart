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

// Check-in 20 hours from now (within the 48h window), checkout in 2 days.
const checkIn = new Date(Date.now() + 20 * 60 * 60 * 1000);
const checkOut = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

const doc = {
  _id: new mongoose.Types.ObjectId(),
  userId: guest._id,
  hotelId: hotel._id,
  roomId: '101',
  bookingReference: 'TESTNEAR1',
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
console.log('Inserted near booking:', res.insertedId.toString());
await conn.close();

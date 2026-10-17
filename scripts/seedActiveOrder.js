import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
const targetUri = process.env.MONGODB_URI.replace(/\/test(\?|$)/, '/test_copy$1');
const conn = await mongoose.createConnection(targetUri).asPromise();
const orders = conn.db.collection('serviceorders');
const users = conn.db.collection('users');
const hotels = conn.db.collection('hotels');

const guest = await users.findOne({ email: 'jane-doe-test@example.com' });
const hotel = await hotels.findOne({ name: /grand hotel/i });
const template = await orders.findOne({ serviceType: 'restaurant' });

const readyAt = new Date(Date.now() + 4 * 60 * 1000 + 15 * 1000);
const doc = {
  ...template,
  _id: new mongoose.Types.ObjectId(),
  guestId: guest._id,
  hotelId: hotel._id,
  status: 'preparing',
  estimatedReadyAt: readyAt,
  createdAt: new Date(),
  updatedAt: new Date(),
  staffId: null
};
delete doc.completedAt;

const res = await orders.insertOne(doc);
console.log('Inserted order:', res.insertedId.toString(), 'readyAt', readyAt.toISOString());
await conn.close();

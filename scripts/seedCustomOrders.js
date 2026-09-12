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

const doc1 = {
  _id: new mongoose.Types.ObjectId(),
  guestId: guest._id, hotelId: hotel._id, serviceType: 'custom', status: 'confirmed', total: 15000,
  serviceDetails: { customServiceName: 'Conference Room Rental', quantity: 1 },
  createdAt: new Date(), updatedAt: new Date()
};
const doc2 = {
  _id: new mongoose.Types.ObjectId(),
  guestId: guest._id, hotelId: hotel._id, serviceType: 'custom', status: 'preparing', total: 8000,
  serviceDetails: { customServiceName: 'Sauna', quantity: 1 },
  estimatedReadyAt: new Date(Date.now() + 6*60*1000),
  createdAt: new Date(), updatedAt: new Date()
};
const res = await orders.insertMany([doc1, doc2]);
console.log('Inserted:', Object.values(res.insertedIds).map(String));
await conn.close();

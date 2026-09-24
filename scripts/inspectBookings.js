import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
const uri = process.env.MONGODB_URI.replace(/\/test(\?|$)/, '/test_copy$1');

async function run() {
  await mongoose.connect(uri);
  const bookings = await mongoose.connection.collection('bookings').find({ guestEmail: /finnpower/i }).toArray();
  const byUser = await mongoose.connection.collection('bookings').find({}).toArray();
  const mine = byUser.filter(b => String(b.userId) === '6a6902b71049d9629d6f1252');
  console.log(JSON.stringify(mine.map(b => ({
    id: b._id, roomId: b.roomId, status: b.status, checkInDate: b.checkInDate, checkOutDate: b.checkOutDate,
    checkInInfo: b.checkInInfo, checkOutInfo: b.checkOutInfo
  })), null, 2));
  await mongoose.disconnect();
}
run().catch(e => { console.error(e); process.exit(1); });

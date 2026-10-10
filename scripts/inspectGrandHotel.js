import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
const uri = process.env.MONGODB_URI.replace(/\/test(\?|$)/, '/test_copy$1');

async function run() {
  await mongoose.connect(uri);
  const hotel = await mongoose.connection.collection('hotels').findOne({ name: /grand hotel/i });
  console.log('Hotel:', hotel?._id, hotel?.name);
  const bookings = await mongoose.connection.collection('bookings').find({ hotelId: hotel._id }).toArray();
  console.log(JSON.stringify(bookings.map(b => ({
    id: b._id, userId: b.userId, guestName: b.guestName, guestEmail: b.guestEmail, source: b.source,
    roomId: b.roomId, status: b.status, checkInDate: b.checkInDate, checkOutDate: b.checkOutDate,
    checkInInfo: b.checkInInfo, checkOutInfo: b.checkOutInfo
  })), null, 2));
  await mongoose.disconnect();
}
run().catch(e => { console.error(e); process.exit(1); });

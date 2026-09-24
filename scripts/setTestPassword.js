// One-off: sets a known password for a guest user IN THE test_copy DATABASE ONLY, for
// local end-to-end testing of the new service-order pricing logic. Never touches production.
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const targetUri = process.env.MONGODB_URI.replace(/\/test(\?|$)/, '/test_copy$1');

async function run() {
  await mongoose.connect(targetUri);
  const hash = await bcrypt.hash('testpass1234', 10);
  const result = await mongoose.connection.collection('users').updateOne(
    { email: 'finnpowergloballimited@gmail.com' },
    { $set: { password: hash } }
  );
  console.log('Matched:', result.matchedCount, 'Modified:', result.modifiedCount);
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });

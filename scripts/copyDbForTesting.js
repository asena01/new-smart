// One-off: copies every collection from the live `test` database into an isolated
// `test_copy` database on the same Atlas cluster, so local backend testing never reads
// from or writes to production data. Run with: node scripts/copyDbForTesting.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const sourceUri = process.env.MONGODB_URI;
if (!sourceUri) {
  console.error('MONGODB_URI not set');
  process.exit(1);
}
const targetUri = sourceUri.replace(/\/test(\?|$)/, '/test_copy$1');

async function run() {
  const sourceConn = await mongoose.createConnection(sourceUri).asPromise();
  const targetConn = await mongoose.createConnection(targetUri).asPromise();

  const collections = await sourceConn.db.listCollections().toArray();
  for (const { name } of collections) {
    const docs = await sourceConn.db.collection(name).find({}).toArray();
    await targetConn.db.collection(name).deleteMany({});
    if (docs.length) {
      await targetConn.db.collection(name).insertMany(docs);
    }
    console.log(`Copied ${docs.length} docs -> ${name}`);
  }

  await sourceConn.close();
  await targetConn.close();
  console.log(`Done. Test copy lives at: ${targetUri.replace(/:[^:@]+@/, ':****@')}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

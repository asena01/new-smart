import mongoose from 'mongoose';

// MongoDB's own recommended pattern for multi-document transactions: retry the whole
// callback when the server flags the abort as transient (e.g. a write conflict or a replica
// set election happening mid-transaction), rather than failing the request outright. Callers
// pass a `work(session)` function that performs all its reads/writes with `{ session }` so
// they participate in the same transaction.
export async function runInTransaction(work, { maxAttempts = 5 } = {}) {
  const session = await mongoose.startSession();
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      try {
        const result = await work(session);
        await session.commitTransaction();
        return result;
      } catch (error) {
        await session.abortTransaction();
        if (error.hasErrorLabel?.('TransientTransactionError') && attempt < maxAttempts) {
          continue;
        }
        throw error;
      }
    }
    throw new Error('Transaction did not complete after multiple attempts');
  } finally {
    await session.endSession();
  }
}

// insertMany (and bulk writes generally) surface a duplicate-key hit as a BulkWriteError,
// not the plain E11000 you'd get from a single insert — its own top-level `code` isn't 11000,
// the individual `writeErrors` entries are. Checking both covers single-document writes
// (booking.save()) and the batched RoomBookingHold insert the same way.
export function isDuplicateKeyError(error) {
  if (!error) return false;
  if (error.code === 11000) return true;
  return Array.isArray(error.writeErrors) && error.writeErrors.some(writeError => (writeError.code ?? writeError.err?.code) === 11000);
}

import mongoose from 'mongoose';

// A stay on another platform (Airbnb, Booking.com, ...) imported from a room's iCal feed.
// Half-open [startDate, endDate) in UTC-midnight calendar days, same convention as
// nightsBetween() in bookingController.js, so it compares directly against booking nights.
// Rewritten wholesale on every sync of its feed — see calendarSyncService.js.
const externalRoomBlockSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true },
  roomObjectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  feedId: { type: mongoose.Schema.Types.ObjectId, required: true },
  source: { type: String, required: true },
  uid: { type: String, required: true },
  summary: { type: String, default: '' },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  // Set when this block overlaps a booking already made on this platform — i.e. the same
  // nights got sold twice. Surfaced to the host to resolve; it doesn't remove either side.
  conflictBookingReference: { type: String, default: null },
});

externalRoomBlockSchema.index({ hotelId: 1, roomObjectId: 1, startDate: 1, endDate: 1 });
externalRoomBlockSchema.index({ feedId: 1 });

export default mongoose.model('ExternalRoomBlock', externalRoomBlockSchema);

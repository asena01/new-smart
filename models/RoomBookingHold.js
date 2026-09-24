import mongoose from 'mongoose';

// One document per (hotel, room, calendar night) held by an active, non-cancelled booking.
// This collection's only job is the unique index below: two requests racing to reserve
// overlapping date ranges for the same room always share at least one calendar night (a
// half-open [checkIn, checkOut) range can't overlap another without it), so whichever
// insertMany reaches MongoDB second gets a real E11000 duplicate-key error on that shared
// night — a guarantee a findOne-then-create check can never give, since two concurrent reads
// can both see "no conflict" before either write lands. See nightsBetween/reserveRoomNights/
// releaseRoomNights in bookingController.js, the only reader/writer of this collection.
const roomBookingHoldSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
  },
  roomId: {
    type: String,
    required: true,
  },
  // Midnight UTC of the held calendar night — see nightsBetween() in bookingController.js.
  night: {
    type: Date,
    required: true,
  },
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: true,
  },
});

roomBookingHoldSchema.index({ hotelId: 1, roomId: 1, night: 1 }, { unique: true });
roomBookingHoldSchema.index({ bookingId: 1 });

export default mongoose.model('RoomBookingHold', roomBookingHoldSchema);

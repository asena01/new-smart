import mongoose from 'mongoose';

// Per-room iCal sync settings, deliberately kept out of Hotel.rooms[]: hotel documents are
// returned by public guest-facing endpoints, and both fields here are secrets (an OTA's
// calendar feed URL carries a private token in its query string, and exportToken grants read
// access to the room's booked dates).
const feedSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  url: { type: String, required: true },
  lastSyncedAt: { type: Date, default: null },
  lastError: { type: String, default: null },
  eventCount: { type: Number, default: 0 },
  conflictCount: { type: Number, default: 0 },
});

const roomCalendarSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true },
  // The room subdocument's _id, not its roomNumber — the number is editable by the host.
  roomObjectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  exportToken: { type: String, required: true, unique: true },
  feeds: [feedSchema],
});

roomCalendarSchema.index({ hotelId: 1, roomObjectId: 1 }, { unique: true });

export default mongoose.model('RoomCalendar', roomCalendarSchema);

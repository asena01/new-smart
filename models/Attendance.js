import mongoose from 'mongoose';

const attendanceSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true
  },
  staffId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Staff',
    required: true
  },
  clockInTime: {
    type: Date,
    required: true
  },
  clockOutTime: {
    type: Date,
    default: null
  }
}, { timestamps: true });

attendanceSchema.index({ staffId: 1, clockOutTime: 1 });
attendanceSchema.index({ hotelId: 1, clockInTime: -1 });

export default mongoose.model('Attendance', attendanceSchema);

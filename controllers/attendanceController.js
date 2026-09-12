import Attendance from '../models/Attendance.js';
import Staff from '../models/Staff.js';
import { canManageHotel } from '../utils/staffAuth.js';

export const clockIn = async (req, res) => {
  try {
    const staff = await Staff.findOne({ userId: req.user.userId, status: 'active' });
    if (!staff) {
      return res.status(404).json({ error: 'Staff profile not found' });
    }

    const openRecord = await Attendance.findOne({ staffId: staff._id, clockOutTime: null });
    if (openRecord) {
      return res.status(409).json({ error: 'Already clocked in. Clock out first.' });
    }

    const attendance = await Attendance.create({
      hotelId: staff.hotelId,
      staffId: staff._id,
      clockInTime: new Date()
    });

    res.status(201).json(attendance);
  } catch (error) {
    console.error('Error clocking in:', error);
    res.status(500).json({ error: 'Failed to clock in' });
  }
};

export const clockOut = async (req, res) => {
  try {
    const staff = await Staff.findOne({ userId: req.user.userId, status: 'active' });
    if (!staff) {
      return res.status(404).json({ error: 'Staff profile not found' });
    }

    const openRecord = await Attendance.findOne({ staffId: staff._id, clockOutTime: null }).sort({ clockInTime: -1 });
    if (!openRecord) {
      return res.status(400).json({ error: 'Not currently clocked in.' });
    }

    openRecord.clockOutTime = new Date();
    await openRecord.save();

    res.json(openRecord);
  } catch (error) {
    console.error('Error clocking out:', error);
    res.status(500).json({ error: 'Failed to clock out' });
  }
};

export const getMyAttendance = async (req, res) => {
  try {
    const staff = await Staff.findOne({ userId: req.user.userId, status: 'active' });
    if (!staff) {
      return res.status(404).json({ error: 'Staff profile not found' });
    }

    const records = await Attendance.find({ staffId: staff._id }).sort({ clockInTime: -1 }).limit(30);
    const current = records.find(r => !r.clockOutTime) || null;

    res.json({ records, current });
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
};

// Shared by getHotelAttendance and exportHotelAttendance so the two can never drift — an
// export must return exactly the records the list view was showing for the same filters.
// startDate/endDate are inclusive local calendar days (e.g. '2026-01-01'); endDate is padded
// out to the last instant of that day so a same-day range (startDate === endDate) still
// matches records from any time on that day, not just midnight.
function buildAttendanceFilter(hotelId, { staffId, startDate, endDate, clockedIn }) {
  const filter = { hotelId };
  if (staffId) filter.staffId = staffId;
  if (startDate || endDate) {
    filter.clockInTime = {};
    if (startDate) filter.clockInTime.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.clockInTime.$lte = end;
    }
  }
  // 'true'/'false' as strings since this always arrives as a query param — never trust a
  // truthy-string check here (both values are non-empty strings).
  if (clockedIn === 'true') filter.clockOutTime = null;
  else if (clockedIn === 'false') filter.clockOutTime = { $ne: null };
  return filter;
}

function invalidDateRange(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return 'Invalid date value.';
  if (start > end) return 'Start date must be on or before end date.';
  return null;
}

const MAX_PAGE_SIZE = 200;

export const getHotelAttendance = async (req, res) => {
  try {
    const { hotelId } = req.params;
    if (!(await canManageHotel(req, hotelId, 'canManageStaff'))) {
      return res.status(403).json({ error: 'Not authorized to view attendance for this hotel' });
    }

    const { staffId, startDate, endDate, clockedIn } = req.query;
    const rangeError = invalidDateRange(startDate, endDate);
    if (rangeError) {
      return res.status(400).json({ error: rangeError });
    }

    const filter = buildAttendanceFilter(hotelId, { staffId, startDate, endDate, clockedIn });

    // Without a date range, an established hotel's attendance history can grow unbounded —
    // this replaces what used to be a flat, silent .limit(200) (older records simply vanished
    // with no way back to them) with real pagination, so every record stays reachable, just a
    // page at a time. A date range is still the intended way to narrow a large history down;
    // pageSize is capped regardless of what's requested, so a client can't ask for the whole
    // table in one response.
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const [records, total] = await Promise.all([
      Attendance.find(filter)
        .populate('staffId', 'firstName lastName position')
        .sort({ clockInTime: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize),
      Attendance.countDocuments(filter)
    ]);

    res.json({
      records,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / pageSize))
    });
  } catch (error) {
    console.error('Error fetching hotel attendance:', error);
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
};

function csvField(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// Same filter as the list view (date range + staff), but never paginated — the point of an
// export is the complete range for a payroll run, not one page of it. Still capped implicitly
// by whatever date range the host picks; an unbounded whole-history export isn't something
// payroll workflows need anyway (they're always for a specific pay period).
export const exportHotelAttendance = async (req, res) => {
  try {
    const { hotelId } = req.params;
    if (!(await canManageHotel(req, hotelId, 'canManageStaff'))) {
      return res.status(403).json({ error: 'Not authorized to export attendance for this hotel' });
    }

    const { staffId, startDate, endDate, clockedIn } = req.query;
    const rangeError = invalidDateRange(startDate, endDate);
    if (rangeError) {
      return res.status(400).json({ error: rangeError });
    }

    const filter = buildAttendanceFilter(hotelId, { staffId, startDate, endDate, clockedIn });
    const records = await Attendance.find(filter)
      .populate('staffId', 'firstName lastName position')
      .sort({ clockInTime: 1 });

    const header = ['Staff Name', 'Position', 'Date', 'Clock In', 'Clock Out', 'Duration (hours)'];
    const rows = records.map(r => {
      const staff = r.staffId;
      const name = staff ? `${staff.firstName} ${staff.lastName}` : 'Unknown';
      const position = staff?.position || '';
      const date = r.clockInTime.toISOString().slice(0, 10);
      const clockIn = r.clockInTime.toISOString();
      const clockOut = r.clockOutTime ? r.clockOutTime.toISOString() : '';
      const durationHours = r.clockOutTime
        ? ((r.clockOutTime.getTime() - r.clockInTime.getTime()) / 3600000).toFixed(2)
        : '';
      return [name, position, date, clockIn, clockOut, durationHours];
    });

    const csv = [header, ...rows].map(row => row.map(csvField).join(',')).join('\n');
    const rangeLabel = startDate || endDate ? `${startDate || 'start'}_to_${endDate || 'end'}` : 'all';

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${rangeLabel}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting hotel attendance:', error);
    res.status(500).json({ error: 'Failed to export attendance' });
  }
};

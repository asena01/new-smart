import crypto from 'crypto';
import mongoose from 'mongoose';
import Staff from '../models/Staff.js';
import StaffSchedule from '../models/StaffSchedule.js';
import Hotel from '../models/Hotel.js';
import User from '../models/User.js';
import Task from '../models/Task.js';
import ServiceOrder from '../models/ServiceOrder.js';
import ttlockService from '../services/ttlockService.js';
import { sendStaffInvitationEmail } from '../utils/emailUtils.js';
import { sendTokenResponse } from '../utils/tokenUtils.js';
import { canManageHotel, canManageStaffMember } from '../utils/staffAuth.js';
import { resolvePermissions } from '../utils/staffPermissions.js';

// Task/ServiceOrder statuses that mean "still open" — used both to find work orphaned by a
// staff termination and (via TASK_OPEN_STATUSES) to know whether an unassigned task needs its
// status reset back to 'pending' to stay visible in the open-tasks claim queue.
const TASK_OPEN_STATUSES = ['pending', 'in-progress'];

function timeMinutes(value) {
  const [hours, minutes] = String(value || '').split(':').map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : null;
}

function scheduleDatesOverlap(a, b) {
  if (a.scheduleType === 'recurring' && b.scheduleType === 'recurring') {
    return (a.dayOfWeek || []).some(day => (b.dayOfWeek || []).includes(day));
  }
  if (a.scheduleType === 'one-time' && b.scheduleType === 'one-time') {
    return a.date && b.date && new Date(a.date).toISOString().slice(0, 10) === new Date(b.date).toISOString().slice(0, 10);
  }
  return true;
}

function scheduleTimesOverlap(a, b) {
  const aStart = timeMinutes(a.startTime);
  const aEnd = timeMinutes(a.endTime);
  const bStart = timeMinutes(b.startTime);
  const bEnd = timeMinutes(b.endTime);
  if ([aStart, aEnd, bStart, bEnd].some(value => value === null)) return false;
  const normalizedEnd = (start, end) => end <= start ? end + 1440 : end;
  return aStart < normalizedEnd(bStart, bEnd) && bStart < normalizedEnd(aStart, aEnd);
}
const ORDER_OPEN_STATUSES = ['pending', 'confirmed', 'preparing', 'in-progress', 'ready'];

// Best-effort real TTLock revocation, shared by the standalone Revoke Key action and
// termination. Never let a TTLock API hiccup block the caller's primary action — but never
// silently claim the key is revoked when we couldn't actually call the API either (no known
// lockId, or the call failed), since that's exactly the "just flips a DB flag" behavior this
// replaces. Returns the ttlockKeyStatus field to persist (omitted when we can't honestly
// claim 'revoked') alongside a warning to surface to the caller when manual follow-up is
// needed.
async function revokeStaffTTLockKey(staff) {
  if (!staff.ttlockKeyId || staff.ttlockKeyStatus === 'revoked') {
    return { ttlockRevoked: true, ttlockWarning: null, statusUpdate: {} };
  }
  if (!staff.ttlockLockId) {
    return {
      ttlockRevoked: false,
      ttlockWarning: 'No lock is on record for this staff member\'s digital lock key — it could not be revoked automatically. Revoke it manually in TTLock.',
      statusUpdate: {}
    };
  }
  try {
    await ttlockService.revokeEkey(staff.ttlockLockId, staff.ttlockKeyId);
    return { ttlockRevoked: true, ttlockWarning: null, statusUpdate: { ttlockKeyStatus: 'revoked' } };
  } catch (ttlockError) {
    console.error('Error revoking TTLock key:', ttlockError.message);
    return {
      ttlockRevoked: false,
      ttlockWarning: 'The digital lock service could not be reached to revoke this staff member\'s key — revoke it manually in TTLock.',
      statusUpdate: {}
    };
  }
}

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const createAndSendInvite = async (staff, hotelName) => {
  const rawToken = crypto.randomBytes(32).toString('hex');

  staff.invitationTokenHash = hashToken(rawToken);
  staff.invitationTokenExpires = new Date(Date.now() + INVITE_EXPIRY_MS);
  staff.invitationStatus = 'pending';
  staff.invitedAt = new Date();
  await staff.save();

  const inviteLink = `${process.env.FRONTEND_URL || 'http://localhost:4200'}/staff/accept-invite?token=${rawToken}`;
  await sendStaffInvitationEmail(staff.email, {
    firstName: staff.firstName,
    hotelName,
    inviteLink
  });
};

// Add staff member
export const addStaffMember = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const {
      firstName,
      lastName,
      email,
      phone,
      position,
      department,
      employmentType,
      permissions,
      ttlockKeyId
    } = req.body;

    // Verify hotel exists
    const hotel = await Hotel.findById(hotelId);
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    if (!(await canManageHotel(req, hotelId, 'canManageStaff'))) {
      return res.status(403).json({ error: 'Not authorized to add staff to this hotel' });
    }

    // Check if email already exists — as a staff record, or as a guest/host/admin User
    // account. A pre-existing User with this email would otherwise get silently reused
    // (and left on their old role) when they accept the invite — see acceptStaffInvite.
    // deleteStaffMember is a soft delete (status: 'terminated', record kept for history),
    // and Staff.email has a unique index, so a terminated record permanently blocks
    // re-adding that email unless handled here — reactivate it instead of erroring.
    const existingStaff = await Staff.findOne({ email });
    if (existingStaff && existingStaff.status !== 'terminated') {
      return res.status(400).json({ error: 'Email already registered as staff' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser && !(existingStaff && String(existingStaff.userId) === String(existingUser._id))) {
      return res.status(400).json({
        error: `This email already has a ${existingUser.role} account. Staff accounts need a different email address.`
      });
    }

    let staff;
    let inviteEmailSent = true;

    if (existingStaff) {
      // Rehire: reuse the old record (and its history — schedules, tasks, attendance all
      // still point at this staffId) rather than creating a second document, which the
      // unique email index would reject anyway.
      existingStaff.set({
        hotelId,
        firstName,
        lastName,
        phone,
        position,
        department,
        employmentType,
        permissions: resolvePermissions(position, permissions),
        ttlockKeyId,
        ttlockKeyName: `${firstName}-${lastName}-key`,
        ttlockKeyStatus: ttlockKeyId ? 'active' : 'inactive',
        status: 'active',
        terminatedAt: undefined
      });

      // Their login (User doc + password) survived termination untouched. A rehire always
      // gets a fresh invite — and if they'd already accepted one before, their old password
      // is invalidated below (see acceptStaffInvite) so re-adding this email can't be used
      // to silently hand back access to whatever password they had before termination.
      if (existingStaff.userId) {
        const oldUser = await User.findById(existingStaff.userId).select('+password');
        if (oldUser) {
          oldUser.password = crypto.randomBytes(32).toString('hex');
          await oldUser.save();
        }
      }

      try {
        await createAndSendInvite(existingStaff, hotel.name);
      } catch (emailError) {
        inviteEmailSent = false;
        console.error('Error sending staff invitation email:', emailError.message);
      }
      staff = existingStaff;
    } else {
      staff = new Staff({
        hotelId,
        firstName,
        lastName,
        email,
        phone,
        position,
        department,
        employmentType,
        permissions: resolvePermissions(position, permissions),
        ttlockKeyId,
        ttlockKeyName: `${firstName}-${lastName}-key`,
        ttlockKeyStatus: ttlockKeyId ? 'active' : 'inactive',
        status: 'active'
      });

      await staff.save();

      try {
        await createAndSendInvite(staff, hotel.name);
      } catch (emailError) {
        inviteEmailSent = false;
        console.error('Error sending staff invitation email:', emailError.message);
      }
    }

    res.status(201).json({
      message: inviteEmailSent
        ? 'Staff member added and invitation email sent'
        : 'Staff member added, but the invitation email could not be sent',
      inviteEmailSent,
      staff
    });
  } catch (error) {
    console.error('Error adding staff member:', error);
    res.status(500).json({ error: 'Failed to add staff member' });
  }
};

// Get the logged-in staff user's own profile
export const getMyStaffProfile = async (req, res) => {
  try {
    const staff = await Staff.findOne({ userId: req.user.userId, status: 'active' }).populate('hotelId', 'name');
    if (!staff) {
      return res.status(404).json({ error: 'Staff profile not found' });
    }

    res.json({ staff });
  } catch (error) {
    console.error('Error fetching staff profile:', error);
    res.status(500).json({ error: 'Failed to fetch staff profile' });
  }
};

// Get all staff for a hotel
export const getHotelStaff = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { position, status } = req.query;

    if (!(await canManageHotel(req, hotelId, 'canManageStaff'))) {
      return res.status(403).json({ error: 'Not authorized to view this hotel\'s staff' });
    }

    // Terminated staff are a soft-delete, not a normal browsable status — every caller of
    // this endpoint (the staff list, attendance/schedule pickers, every order-assignment
    // dropdown) expects "deleted" to mean gone, so exclude them unless a status is
    // explicitly requested (e.g. an audit view asking for ?status=terminated).
    let filter = { hotelId };
    if (position) filter.position = position;
    filter.status = status || { $ne: 'terminated' };

    const staff = await Staff.find(filter).sort({ createdAt: -1 });

    res.json(staff);
  } catch (error) {
    console.error('Error fetching staff:', error);
    res.status(500).json({ error: 'Failed to fetch staff' });
  }
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Staff eligible to be manually assigned a task today: active, holding the given permission,
// and scheduled to work at some point today. Deliberately checks the day only, not the exact
// start/end minute — Hotel has no stored timezone, and shift times are plain "HH:MM" strings
// with no timezone attached, so comparing them against the server's own (UTC) clock minute-
// for-minute would silently misfire by whatever offset separates the hotel's local time from
// UTC. Day-of-week/date comparisons are far less exposed to that (only wrong right around a
// hotel's local midnight), so this trades shift-level precision for actually working.
export const getAssignableStaff = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { permission } = req.query;
    if (!permission) {
      return res.status(400).json({ error: 'permission query parameter is required' });
    }

    if (!(await canManageHotel(req, hotelId, 'canManageOrders'))) {
      return res.status(403).json({ error: 'Not authorized to view assignable staff for this hotel' });
    }

    const staff = await Staff.find({ hotelId, status: 'active', [`permissions.${permission}`]: true });
    if (!staff.length) {
      return res.json([]);
    }

    const schedules = await StaffSchedule.find({
      staffId: { $in: staff.map(s => s._id) },
      status: 'scheduled'
    });

    const now = new Date();
    const todayName = DAY_NAMES[now.getDay()];
    const todayDateStr = now.toISOString().slice(0, 10);

    const scheduledTodayStaffIds = new Set(
      schedules
        .filter(schedule => schedule.scheduleType === 'one-time'
          ? !!schedule.date && schedule.date.toISOString().slice(0, 10) === todayDateStr
          : (schedule.dayOfWeek || []).includes(todayName))
        .map(schedule => String(schedule.staffId))
    );

    res.json(staff.filter(s => scheduledTodayStaffIds.has(String(s._id))));
  } catch (error) {
    console.error('Error fetching assignable staff:', error);
    res.status(500).json({ error: 'Failed to fetch assignable staff' });
  }
};

// Get staff member details
export const getStaffMember = async (req, res) => {
  try {
    const { staffId } = req.params;

    const staff = await Staff.findById(staffId);
    if (!staff) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    if (!(await canManageHotel(req, staff.hotelId, 'canManageStaff'))) {
      return res.status(403).json({ error: 'Not authorized to view this staff member' });
    }

    // Get schedules
    const schedules = await StaffSchedule.find({ staffId }).sort({ date: -1 });

    res.json({
      staff,
      schedules
    });
  } catch (error) {
    console.error('Error fetching staff member:', error);
    res.status(500).json({ error: 'Failed to fetch staff member' });
  }
};

// Update staff member
export const updateStaffMember = async (req, res) => {
  try {
    const { staffId } = req.params;
    // Room assignment is only ever set from the task-assignment flow, not staff details.
    const { assignedRooms, assignedFloors, ...updates } = req.body;

    const existingStaff = await Staff.findById(staffId);
    if (!existingStaff) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    if (!(await canManageHotel(req, existingStaff.hotelId, 'canManageStaff'))) {
      return res.status(403).json({ error: 'Not authorized to update this staff member' });
    }

    // Merge rather than replace, so a partial { permissions: { canManageOrders: true } } from
    // the UI doesn't wipe out every other permission flag back to schema defaults.
    if (updates.permissions) {
      updates.permissions = resolvePermissions(updates.position || existingStaff.position, {
        ...existingStaff.permissions?.toObject?.() ?? existingStaff.permissions,
        ...updates.permissions
      });
    }

    const staff = await Staff.findByIdAndUpdate(
      staffId,
      updates,
      { new: true }
    );

    res.json({
      message: 'Staff member updated successfully',
      staff
    });
  } catch (error) {
    console.error('Error updating staff member:', error);
    res.status(500).json({ error: 'Failed to update staff member' });
  }
};

// Assign TTLock key to staff
export const assignTTLockKey = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { ttlockKeyId, ttlockLockId, accessLevel, expiryDays } = req.body;

    const { allowed, staff: target } = await canManageStaffMember(req, staffId, 'canManageStaff');
    if (!target) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    if (!allowed) {
      return res.status(403).json({ error: 'Not authorized to assign this staff member\'s key' });
    }

    const staff = await Staff.findByIdAndUpdate(
      staffId,
      {
        ttlockKeyId,
        // Which lock this eKey was actually issued against — required to ever revoke it
        // for real later (see revokeStaffTTLockKey). Not resolved automatically here since
        // a single staff key can span multiple rooms/floors; the caller must supply it.
        ttlockLockId,
        ttlockKeyStatus: 'active',
        ttlockAccessLevel: accessLevel,
        keyGeneratedAt: new Date(),
        keyExpiresAt: new Date(Date.now() + (expiryDays || 365) * 24 * 60 * 60 * 1000)
      },
      { new: true }
    );

    res.json({
      message: 'Digital lock key assigned successfully',
      staff
    });
  } catch (error) {
    console.error('Error assigning TTLock key:', error);
    res.status(500).json({ error: 'Failed to assign digital lock key' });
  }
};

// Revoke TTLock key
export const revokeTTLockKey = async (req, res) => {
  try {
    const { staffId } = req.params;

    const { allowed, staff: target } = await canManageStaffMember(req, staffId, 'canManageStaff');
    if (!target) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    if (!allowed) {
      return res.status(403).json({ error: 'Not authorized to revoke this staff member\'s key' });
    }

    const { ttlockRevoked, ttlockWarning, statusUpdate } = await revokeStaffTTLockKey(target);

    const staff = await Staff.findByIdAndUpdate(
      staffId,
      statusUpdate,
      { new: true }
    );

    res.json({
      message: ttlockRevoked ? 'Digital lock key revoked successfully' : 'Could not confirm the key was revoked with the digital lock service',
      ttlockRevoked,
      ttlockWarning,
      staff
    });
  } catch (error) {
    console.error('Error revoking TTLock key:', error);
    res.status(500).json({ error: 'Failed to revoke digital lock key' });
  }
};

// Add staff schedule
export const addSchedule = async (req, res) => {
  try {
    const { staffId, hotelId } = req.params;
    const scheduleData = req.body;

    if (!(await canManageHotel(req, hotelId, 'canManageSchedules'))) {
      return res.status(403).json({ error: 'Not authorized to add a schedule at this hotel' });
    }

    const targetStaff = await Staff.findOne({ _id: staffId, hotelId, status: 'active' });
    if (!targetStaff) {
      return res.status(404).json({ error: 'Active staff member not found at this hotel' });
    }

    const existingSchedules = await StaffSchedule.find({ staffId, hotelId, status: 'scheduled' }).lean();
    const conflict = existingSchedules.find(existing => scheduleDatesOverlap(scheduleData, existing) && scheduleTimesOverlap(scheduleData, existing));
    if (conflict) {
      return res.status(409).json({ error: 'This shift overlaps an existing scheduled shift for the selected staff member.' });
    }

    const schedule = new StaffSchedule({
      staffId,
      hotelId,
      ...scheduleData
    });

    await schedule.save();

    res.status(201).json({
      message: 'Schedule added successfully',
      schedule
    });
  } catch (error) {
    console.error('Error adding schedule:', error);
    res.status(500).json({ error: 'Failed to add schedule' });
  }
};

// All shifts across every staff member at the hotel, staff populated — the schedule
// management page's primary view is "who's working when" across the whole team, which
// getStaffSchedules (scoped to one staffId) can't answer without an N+1 fetch per staff.
export const getHotelSchedules = async (req, res) => {
  try {
    const { hotelId } = req.params;

    if (!(await canManageHotel(req, hotelId, 'canManageSchedules'))) {
      return res.status(403).json({ error: 'Not authorized to view schedules at this hotel' });
    }

    const schedules = await StaffSchedule.find({ hotelId })
      .populate('staffId', 'firstName lastName position')
      .sort({ createdAt: -1 });

    res.json(schedules);
  } catch (error) {
    console.error('Error fetching hotel schedules:', error);
    res.status(500).json({ error: 'Failed to fetch schedules' });
  }
};

// Get staff schedules
export const getStaffSchedules = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { startDate, endDate } = req.query;

    // This previously had no authorization check at all — any authenticated user could
    // pull any staffId's schedule just by knowing/guessing the id. Allow either a
    // manager/host with canManageSchedules at that staff member's hotel, or the staff
    // member viewing their own (still-active) schedule.
    const target = await Staff.findById(staffId);
    if (!target) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    const isSelf = target.status === 'active' && String(target.userId) === String(req.user.userId);
    if (!isSelf && !(await canManageHotel(req, target.hotelId, 'canManageSchedules'))) {
      return res.status(403).json({ error: 'Not authorized to view this staff member\'s schedule' });
    }

    let filter = { staffId };
    if (startDate && endDate) {
      filter.date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const schedules = await StaffSchedule.find(filter).sort({ date: 1 });

    res.json(schedules);
  } catch (error) {
    console.error('Error fetching schedules:', error);
    res.status(500).json({ error: 'Failed to fetch schedules' });
  }
};

// Update a staff schedule
export const updateSchedule = async (req, res) => {
  try {
    const { scheduleId } = req.params;

    const existingSchedule = await StaffSchedule.findById(scheduleId);
    if (!existingSchedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    if (!(await canManageHotel(req, existingSchedule.hotelId, 'canManageSchedules'))) {
      return res.status(403).json({ error: 'Not authorized to update this schedule' });
    }

    const candidate = { ...existingSchedule.toObject(), ...req.body };
    const conflicts = await StaffSchedule.find({
      _id: { $ne: scheduleId },
      staffId: candidate.staffId,
      hotelId: existingSchedule.hotelId,
      status: 'scheduled'
    }).lean();
    if (conflicts.some(existing => scheduleDatesOverlap(candidate, existing) && scheduleTimesOverlap(candidate, existing))) {
      return res.status(409).json({ error: 'This shift overlaps an existing scheduled shift for the selected staff member.' });
    }

    const schedule = await StaffSchedule.findByIdAndUpdate(
      scheduleId,
      req.body,
      { new: true, runValidators: true }
    );

    res.json({
      message: 'Schedule updated successfully',
      schedule
    });
  } catch (error) {
    console.error('Error updating schedule:', error);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
};

// Delete a staff schedule
export const deleteSchedule = async (req, res) => {
  try {
    const { scheduleId } = req.params;

    const existingSchedule = await StaffSchedule.findById(scheduleId);
    if (!existingSchedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    if (!(await canManageHotel(req, existingSchedule.hotelId, 'canManageSchedules'))) {
      return res.status(403).json({ error: 'Not authorized to delete this schedule' });
    }

    const schedule = await StaffSchedule.findByIdAndUpdate(
      scheduleId,
      { status: 'cancelled' },
      { new: true, runValidators: true }
    );

    res.json({ message: 'Schedule cancelled successfully', schedule });
  } catch (error) {
    console.error('Error deleting schedule:', error);
    res.status(500).json({ error: 'Failed to delete schedule' });
  }
};

// Delete staff member
export const deleteStaffMember = async (req, res) => {
  try {
    const { staffId } = req.params;

    const existingStaff = await Staff.findById(staffId);
    if (!existingStaff) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    if (!(await canManageHotel(req, existingStaff.hotelId, 'canManageStaff'))) {
      return res.status(403).json({ error: 'Not authorized to delete this staff member' });
    }

    const { ttlockRevoked, ttlockWarning, statusUpdate: ttlockStatusUpdate } = await revokeStaffTTLockKey(existingStaff);

    // Soft delete - mark as terminated
    const staff = await Staff.findByIdAndUpdate(
      staffId,
      {
        status: 'terminated',
        terminatedAt: new Date(),
        ...ttlockStatusUpdate
      },
      { new: true }
    );

    // Open work this staff member was holding is now orphaned — unassign it so a host can
    // see and hand it to someone else, rather than it silently sitting assigned to someone
    // who can no longer act on it. Tasks go back to 'pending' so they reappear in the open
    // tasks claim queue (which only lists staffId:null AND status:'pending'); service orders
    // just get unassigned — hosts reassign those by hand via each order's staff dropdown
    // regardless of status, and the restaurant/bar claim queue already keys off staffId:null.
    const openTasks = await Task.find({ staffId, status: { $in: TASK_OPEN_STATUSES } }).select('title priority');
    if (openTasks.length) {
      await Task.updateMany(
        { staffId, status: { $in: TASK_OPEN_STATUSES } },
        { staffId: null, status: 'pending' }
      );
    }

    const openOrders = await ServiceOrder.find({ staffId, status: { $in: ORDER_OPEN_STATUSES } }).select('serviceType status');
    if (openOrders.length) {
      await ServiceOrder.updateMany(
        { staffId, status: { $in: ORDER_OPEN_STATUSES } },
        { staffId: null }
      );
    }

    res.json({
      message: 'Staff member terminated successfully',
      staff,
      ttlockRevoked,
      ttlockWarning,
      unassignedWork: {
        tasks: openTasks.map(t => ({ _id: t._id, title: t.title, priority: t.priority })),
        orders: openOrders.map(o => ({ _id: o._id, serviceType: o.serviceType, status: o.status }))
      }
    });
  } catch (error) {
    console.error('Error deleting staff member:', error);
    res.status(500).json({ error: 'Failed to delete staff member' });
  }
};

// Get staff statistics
export const getStaffStats = async (req, res) => {
  try {
    const { hotelId } = req.params;

    if (!(await canManageHotel(req, hotelId, 'canManageStaff'))) {
      return res.status(403).json({ error: 'Not authorized to view this hotel\'s staff stats' });
    }

    const total = await Staff.countDocuments({ hotelId, status: { $ne: 'terminated' } });
    const active = await Staff.countDocuments({ hotelId, status: 'active', isAvailable: true });
    const byPosition = await Staff.aggregate([
      { $match: { hotelId: new mongoose.Types.ObjectId(hotelId), status: { $ne: 'terminated' } } },
      { $group: { _id: '$position', count: { $sum: 1 } } }
    ]);

    res.json({
      total,
      active,
      byPosition
    });
  } catch (error) {
    console.error('Error fetching staff stats:', error);
    res.status(500).json({ error: 'Failed to fetch staff statistics' });
  }
};

// Look up a pending invitation by its raw token (public route)
export const getStaffInvite = async (req, res) => {
  try {
    const { token } = req.params;

    const staff = await Staff.findOne({
      invitationTokenHash: hashToken(token),
      invitationStatus: 'pending',
      invitationTokenExpires: { $gt: new Date() }
    }).populate('hotelId', 'name');

    if (!staff) {
      return res.status(404).json({ error: 'This invitation link is invalid or has expired' });
    }

    res.json({
      firstName: staff.firstName,
      lastName: staff.lastName,
      email: staff.email,
      position: staff.position,
      hotelName: staff.hotelId?.name || 'your hotel'
    });
  } catch (error) {
    console.error('Error looking up staff invite:', error);
    res.status(500).json({ error: 'Failed to look up invitation' });
  }
};

// Accept a pending invitation by setting a password (public route)
export const acceptStaffInvite = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const staff = await Staff.findOne({
      invitationTokenHash: hashToken(token),
      invitationStatus: 'pending',
      invitationTokenExpires: { $gt: new Date() }
    });

    if (!staff) {
      return res.status(404).json({ error: 'This invitation link is invalid or has expired' });
    }

    // A User with this email can only be reused here if it's already this same staff
    // member's own account (e.g. a retry after a crash between User.create and staff.save
    // below). Any other existing account (a guest who registered after the invite went out,
    // or a totally unrelated collision) must be rejected — reusing it would silently leave
    // that account on its old role (so it'd get a guest-role token, not staff) and would
    // discard the password just entered on this form.
    let user = await User.findOne({ email: staff.email });
    if (user && String(user._id) !== String(staff.userId)) {
      return res.status(409).json({
        error: `An account already exists for ${staff.email}. Contact your hotel manager for help completing this invitation.`
      });
    }
    if (!user) {
      user = await User.create({
        firstName: staff.firstName,
        lastName: staff.lastName,
        email: staff.email,
        password,
        phone: staff.phone,
        role: 'staff'
      });
    } else {
      // Rehire flow: addStaffMember invalidated this account's old password when re-adding
      // them, specifically so this invite is what lets them set a working one again.
      user.password = password;
      user.firstName = staff.firstName;
      user.lastName = staff.lastName;
      user.phone = staff.phone;
      await user.save();
    }

    staff.userId = user._id;
    staff.invitationStatus = 'accepted';
    staff.invitationTokenHash = undefined;
    staff.invitationTokenExpires = undefined;
    await staff.save();

    sendTokenResponse(user, 200, res);
  } catch (error) {
    console.error('Error accepting staff invite:', error);
    res.status(500).json({ error: 'Failed to accept invitation' });
  }
};

// Resend a staff invitation email
export const resendStaffInvite = async (req, res) => {
  try {
    const { staffId } = req.params;

    const staff = await Staff.findById(staffId).populate('hotelId', 'name');
    if (!staff) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    if (!(await canManageHotel(req, staff.hotelId?._id, 'canManageStaff'))) {
      return res.status(403).json({ error: 'Not authorized to resend this invitation' });
    }

    if (staff.invitationStatus === 'accepted') {
      return res.status(400).json({ error: 'This staff member has already accepted their invitation' });
    }

    await createAndSendInvite(staff, staff.hotelId?.name || 'your hotel');

    res.json({ message: 'Invitation email resent' });
  } catch (error) {
    console.error('Error resending staff invite:', error);
    res.status(500).json({ error: 'Failed to resend invitation email' });
  }
};

import crypto from 'crypto';
import mongoose from 'mongoose';
import Staff from '../models/Staff.js';
import StaffSchedule from '../models/StaffSchedule.js';
import Hotel from '../models/Hotel.js';
import User from '../models/User.js';
import { sendStaffInvitationEmail } from '../utils/emailUtils.js';
import { sendTokenResponse } from '../utils/tokenUtils.js';

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

    // Check if email already exists
    const existingStaff = await Staff.findOne({ email });
    if (existingStaff) {
      return res.status(400).json({ error: 'Email already registered as staff' });
    }

    const staff = new Staff({
      hotelId,
      firstName,
      lastName,
      email,
      phone,
      position,
      department,
      employmentType,
      permissions,
      ttlockKeyId,
      ttlockKeyName: `${firstName}-${lastName}-key`,
      ttlockKeyStatus: ttlockKeyId ? 'active' : 'inactive',
      status: 'active'
    });

    await staff.save();

    let inviteEmailSent = true;
    try {
      await createAndSendInvite(staff, hotel.name);
    } catch (emailError) {
      inviteEmailSent = false;
      console.error('Error sending staff invitation email:', emailError.message);
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
    const staff = await Staff.findOne({ userId: req.user.userId }).populate('hotelId', 'name');
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

    if (req.user.role !== 'admin') {
      const hotel = await Hotel.findOne({ _id: hotelId, hostId: req.user.userId });
      if (!hotel) {
        return res.status(403).json({ error: 'Not authorized to view this hotel\'s staff' });
      }
    }

    let filter = { hotelId };
    if (position) filter.position = position;
    if (status) filter.status = status;

    const staff = await Staff.find(filter).sort({ createdAt: -1 });

    res.json(staff);
  } catch (error) {
    console.error('Error fetching staff:', error);
    res.status(500).json({ error: 'Failed to fetch staff' });
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

    if (req.user.role !== 'admin') {
      const hotel = await Hotel.findOne({ _id: staff.hotelId, hostId: req.user.userId });
      if (!hotel) {
        return res.status(403).json({ error: 'Not authorized to view this staff member' });
      }
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

    if (req.user.role !== 'admin') {
      const hotel = await Hotel.findOne({ _id: existingStaff.hotelId, hostId: req.user.userId });
      if (!hotel) {
        return res.status(403).json({ error: 'Not authorized to update this staff member' });
      }
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
    const { ttlockKeyId, accessLevel, expiryDays } = req.body;

    const staff = await Staff.findByIdAndUpdate(
      staffId,
      {
        ttlockKeyId,
        ttlockKeyStatus: 'active',
        ttlockAccessLevel: accessLevel,
        keyGeneratedAt: new Date(),
        keyExpiresAt: new Date(Date.now() + (expiryDays || 365) * 24 * 60 * 60 * 1000)
      },
      { new: true }
    );

    if (!staff) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    res.json({
      message: 'TTLock key assigned successfully',
      staff
    });
  } catch (error) {
    console.error('Error assigning TTLock key:', error);
    res.status(500).json({ error: 'Failed to assign TTLock key' });
  }
};

// Revoke TTLock key
export const revokeTTLockKey = async (req, res) => {
  try {
    const { staffId } = req.params;

    const staff = await Staff.findByIdAndUpdate(
      staffId,
      {
        ttlockKeyStatus: 'revoked'
      },
      { new: true }
    );

    if (!staff) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    res.json({
      message: 'TTLock key revoked successfully',
      staff
    });
  } catch (error) {
    console.error('Error revoking TTLock key:', error);
    res.status(500).json({ error: 'Failed to revoke TTLock key' });
  }
};

// Add staff schedule
export const addSchedule = async (req, res) => {
  try {
    const { staffId, hotelId } = req.params;
    const scheduleData = req.body;

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

// Get staff schedules
export const getStaffSchedules = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { startDate, endDate } = req.query;

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

    const schedule = await StaffSchedule.findByIdAndUpdate(
      scheduleId,
      req.body,
      { new: true, runValidators: true }
    );

    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

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

    const schedule = await StaffSchedule.findByIdAndDelete(scheduleId);
    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    res.json({ message: 'Schedule deleted successfully' });
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

    if (req.user.role !== 'admin') {
      const hotel = await Hotel.findOne({ _id: existingStaff.hotelId, hostId: req.user.userId });
      if (!hotel) {
        return res.status(403).json({ error: 'Not authorized to delete this staff member' });
      }
    }

    // Soft delete - mark as terminated
    const staff = await Staff.findByIdAndUpdate(
      staffId,
      {
        status: 'terminated',
        terminatedAt: new Date()
      },
      { new: true }
    );

    res.json({
      message: 'Staff member terminated successfully',
      staff
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

    let user = await User.findOne({ email: staff.email });
    if (!user) {
      user = await User.create({
        firstName: staff.firstName,
        lastName: staff.lastName,
        email: staff.email,
        password,
        phone: staff.phone,
        role: 'staff'
      });
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

    if (req.user.role !== 'admin') {
      const hotel = await Hotel.findOne({ _id: staff.hotelId?._id, hostId: req.user.userId });
      if (!hotel) {
        return res.status(403).json({ error: 'Not authorized to resend this invitation' });
      }
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

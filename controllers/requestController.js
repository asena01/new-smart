import StaffRequest from '../models/StaffRequest.js';
import Staff from '../models/Staff.js';
import StaffSchedule from '../models/StaffSchedule.js';
import Hotel from '../models/Hotel.js';
import { canManageHotel } from '../utils/staffAuth.js';
import { createNotification } from '../utils/notificationUtils.js';
import { sendToHotel } from '../utils/sseHub.js';

const TYPE_LABELS = { 'time-off': 'Time Off', 'shift-change': 'Shift Change' };

export const createRequest = async (req, res) => {
  try {
    const staff = await Staff.findOne({ userId: req.user.userId, status: 'active' });
    if (!staff) {
      return res.status(404).json({ error: 'Staff profile not found' });
    }

    const { type, startDate, endDate, reason, proposedShift } = req.body;
    if (!['time-off', 'shift-change'].includes(type)) {
      return res.status(400).json({ error: 'Invalid request type' });
    }
    if (!startDate || !endDate || !reason?.trim()) {
      return res.status(400).json({ error: 'startDate, endDate, and reason are required' });
    }

    const request = await StaffRequest.create({
      hotelId: staff.hotelId,
      staffId: staff._id,
      type,
      startDate,
      endDate,
      reason: reason.trim(),
      proposedShift: type === 'shift-change' ? proposedShift : undefined
    });

    const hotel = await Hotel.findById(staff.hotelId);
    if (hotel) {
      await createNotification({
        userId: hotel.hostId,
        type: 'request',
        title: `New ${TYPE_LABELS[type]} request`,
        message: `${staff.firstName} ${staff.lastName} submitted a ${TYPE_LABELS[type].toLowerCase()} request.`,
        link: '/host/requests'
      });
    }

    res.status(201).json(request);
  } catch (error) {
    console.error('Error creating request:', error);
    res.status(500).json({ error: 'Failed to create request' });
  }
};

export const getMyRequests = async (req, res) => {
  try {
    const staff = await Staff.findOne({ userId: req.user.userId, status: 'active' });
    if (!staff) {
      return res.status(404).json({ error: 'Staff profile not found' });
    }

    const requests = await StaffRequest.find({ staffId: staff._id }).sort({ createdAt: -1 });
    res.json(requests);
  } catch (error) {
    console.error('Error fetching my requests:', error);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
};

export const cancelRequest = async (req, res) => {
  try {
    const staff = await Staff.findOne({ userId: req.user.userId, status: 'active' });
    if (!staff) {
      return res.status(404).json({ error: 'Staff profile not found' });
    }

    const request = await StaffRequest.findOne({ _id: req.params.requestId, staffId: staff._id });
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (request.status !== 'pending') {
      return res.status(409).json({ error: 'Only pending requests can be cancelled' });
    }

    await request.deleteOne();
    res.json({ success: true });
  } catch (error) {
    console.error('Error cancelling request:', error);
    res.status(500).json({ error: 'Failed to cancel request' });
  }
};

export const getHotelRequests = async (req, res) => {
  try {
    const { hotelId } = req.params;
    if (!(await canManageHotel(req, hotelId, 'canApproveRequests'))) {
      return res.status(403).json({ error: 'Not authorized to view requests for this hotel' });
    }

    const { status } = req.query;
    const filter = { hotelId };
    if (status) filter.status = status;

    const requests = await StaffRequest.find(filter)
      .populate('staffId', 'firstName lastName position')
      .sort({ createdAt: -1 })
      .limit(200);

    const enrichedRequests = await Promise.all(requests.map(async request => {
      const start = new Date(request.startDate);
      const end = new Date(request.endDate);
      end.setHours(23, 59, 59, 999);
      const conflictCount = await StaffSchedule.countDocuments({
        staffId: request.staffId?._id || request.staffId,
        hotelId,
        status: 'scheduled',
        $or: [
          { scheduleType: 'one-time', date: { $gte: start, $lte: end } },
          { scheduleType: 'recurring' }
        ]
      });
      return { ...request.toObject(), conflictCount };
    }));

    res.json(enrichedRequests);
  } catch (error) {
    console.error('Error fetching hotel requests:', error);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
};

export const reviewRequest = async (req, res) => {
  try {
    const { status, reviewNotes } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status must be approved or rejected' });
    }

    const request = await StaffRequest.findById(req.params.requestId).populate('staffId', 'firstName lastName userId');
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (!(await canManageHotel(req, request.hotelId, 'canApproveRequests'))) {
      return res.status(403).json({ error: 'Not authorized to review requests for this hotel' });
    }
    if (request.status !== 'pending') {
      return res.status(409).json({ error: 'Request has already been reviewed' });
    }

    request.status = status;
    request.reviewNotes = reviewNotes || '';
    request.reviewedBy = req.user.userId;
    request.reviewedAt = new Date();
    await request.save();

    sendToHotel(request.hotelId, 'request-updated', {
      requestId: request._id,
      status: request.status,
      staffId: request.staffId?._id || request.staffId
    });

    const staffUserId = request.staffId?.userId;
    if (staffUserId) {
      await createNotification({
        userId: staffUserId,
        type: 'request',
        title: `Request ${status}`,
        message: `Your ${TYPE_LABELS[request.type].toLowerCase()} request was ${status}.`,
        link: '/staff/requests'
      });
    }

    res.json(request);
  } catch (error) {
    console.error('Error reviewing request:', error);
    res.status(500).json({ error: 'Failed to review request' });
  }
};

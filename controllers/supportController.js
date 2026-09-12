import mongoose from 'mongoose';
import SupportMessage from '../models/SupportMessage.js';
import SupportIncident from '../models/SupportIncident.js';
import Hotel from '../models/Hotel.js';
import User from '../models/User.js';
import { sendToUser, sendToRole } from '../utils/sseHub.js';
import { createNotification } from '../utils/notificationUtils.js';

function messagePreview(text) {
  if (!text) return '';
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

// Every host has exactly one hotel (see hotelController.js's getHostDashboard/getMyRooms etc —
// no code path anywhere in this app handles a host owning more than one), so "the host's
// support identity" is just that hotel's _id/name, resolved the same Hotel.findOne({hostId})
// way every other host-scoped controller already does.
async function resolveHostHotel(hostId) {
  return Hotel.findOne({ hostId });
}

// Admin callers must name which host's conversation/incident they mean (via req.body.hostId
// or req.params.hostId); a host can only ever act on their own. Returns null if the caller
// has no business touching this hostId at all.
async function resolveAuthorizedHostId(req, requestedHostId) {
  if (req.user.role === 'admin') {
    return requestedHostId || null;
  }
  if (req.user.role === 'host') {
    if (requestedHostId && requestedHostId !== req.user.userId) return null;
    return req.user.userId;
  }
  return null;
}

async function notifyAllAdmins({ type, title, message, link, actionLabel }) {
  const admins = await User.find({ role: 'admin' }).select('_id');
  await Promise.all(admins.map(admin => createNotification({
    userId: admin._id,
    type,
    title,
    message,
    link,
    actionLabel
  })));
}

// ---- Live chat ----

export const sendSupportMessage = async (req, res) => {
  try {
    const { hostId: bodyHostId, messageText } = req.body;
    if (!messageText?.trim()) {
      return res.status(400).json({ error: 'Message text is required' });
    }

    const hostId = await resolveAuthorizedHostId(req, bodyHostId);
    if (!hostId) {
      return res.status(403).json({ error: 'Not authorized to message this host' });
    }

    const hotel = await resolveHostHotel(hostId);
    const senderType = req.user.role === 'admin' ? 'admin' : 'host';
    const senderName = req.user.role === 'admin'
      ? 'Platform Support'
      : (hotel?.name || 'Host');

    const message = await SupportMessage.create({
      hostId,
      hotelId: hotel?._id,
      senderType,
      senderName,
      senderId: req.user.userId,
      messageText: messageText.trim()
    });

    // Lightweight pings on the shared events hub — both sides' open Support pages refetch
    // history on these rather than this endpoint maintaining its own per-thread SSE registry
    // (unlike chatController.js's booking-scoped stream, one dedicated live connection per
    // host isn't worth it here: support volume is low and a hub ping + refetch is still
    // effectively instant).
    sendToUser(hostId, 'support-message', { hostId });
    sendToRole('admin', 'support-message', { hostId });

    if (senderType === 'host') {
      await notifyAllAdmins({
        type: 'message',
        title: `Support message from ${hotel?.name || 'a host'}`,
        message: messagePreview(messageText),
        link: '/admin/support',
        actionLabel: 'Reply'
      });
    } else {
      await createNotification({
        userId: hostId,
        type: 'message',
        title: 'New message from Platform Support',
        message: messagePreview(messageText),
        link: '/host/support',
        actionLabel: 'Reply'
      });
    }

    res.status(201).json({ message: 'Message sent', data: message });
  } catch (error) {
    console.error('Error sending support message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
};

export const getSupportHistory = async (req, res) => {
  try {
    const hostId = await resolveAuthorizedHostId(req, req.params.hostId);
    if (!hostId) {
      return res.status(403).json({ error: 'Not authorized for this conversation' });
    }

    const { limit = 50, offset = 0 } = req.query;
    const messages = await SupportMessage.find({ hostId })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .exec();

    res.json({ messages: messages.reverse() });
  } catch (error) {
    console.error('Error fetching support history:', error);
    res.status(500).json({ error: 'Failed to fetch support history' });
  }
};

// Admin's inbox — one row per host, mirroring chatController.js's getHotelConversations.
export const getSupportThreads = async (req, res) => {
  try {
    const threads = await SupportMessage.aggregate([
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$hostId',
          lastMessage: { $first: '$messageText' },
          lastMessageAt: { $first: '$createdAt' },
          lastSenderType: { $first: '$senderType' },
          hotelId: { $first: '$hotelId' },
          unreadCount: {
            $sum: {
              $cond: [{ $and: [{ $eq: ['$senderType', 'host'] }, { $eq: ['$isRead', false] }] }, 1, 0]
            }
          }
        }
      },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'host' } },
      { $lookup: { from: 'hotels', localField: 'hotelId', foreignField: '_id', as: 'hotel' } },
      { $unwind: { path: '$host', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$hotel', preserveNullAndEmptyArrays: true } },
      { $sort: { lastMessageAt: -1 } },
      {
        $project: {
          hostId: '$_id',
          lastMessage: 1,
          lastMessageAt: 1,
          lastSenderType: 1,
          unreadCount: 1,
          host: { firstName: 1, lastName: 1, email: 1 },
          hotel: { name: 1 }
        }
      }
    ]);

    res.json({ threads });
  } catch (error) {
    console.error('Error fetching support threads:', error);
    res.status(500).json({ error: 'Failed to fetch support threads' });
  }
};

export const markSupportRead = async (req, res) => {
  try {
    const hostId = await resolveAuthorizedHostId(req, req.params.hostId);
    if (!hostId) {
      return res.status(403).json({ error: 'Not authorized for this conversation' });
    }

    // Same reasoning as chatController.js's markMessagesAsRead — only the OTHER side's
    // messages are ever "unread" from this caller's point of view.
    const otherSide = req.user.role === 'admin' ? 'host' : 'admin';
    await SupportMessage.updateMany(
      { hostId, senderType: otherSide, isRead: false },
      { isRead: true, readAt: new Date() }
    );

    res.json({ message: 'Messages marked as read' });
  } catch (error) {
    console.error('Error marking support messages read:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
};

// ---- Incidents ----

export const createIncident = async (req, res) => {
  try {
    if (req.user.role !== 'host') {
      return res.status(403).json({ error: 'Only a host can file a platform incident' });
    }

    const { subject, description, category, priority } = req.body;
    if (!subject?.trim() || !description?.trim()) {
      return res.status(400).json({ error: 'Subject and description are required' });
    }

    const hotel = await resolveHostHotel(req.user.userId);

    const incident = await SupportIncident.create({
      hostId: req.user.userId,
      hotelId: hotel?._id,
      subject: subject.trim(),
      description: description.trim(),
      category: category || 'other',
      priority: priority || 'medium'
    });

    sendToRole('admin', 'support-incident', { incidentId: incident._id });
    await notifyAllAdmins({
      type: 'incident',
      title: `New incident: ${incident.subject}`,
      message: `${hotel?.name || 'A host'} filed a ${incident.priority}-priority ${incident.category} incident.`,
      link: '/admin/support',
      actionLabel: 'View Incident'
    });

    res.status(201).json({ message: 'Incident filed', incident });
  } catch (error) {
    console.error('Error creating incident:', error);
    res.status(500).json({ error: 'Failed to file incident' });
  }
};

export const getMyIncidents = async (req, res) => {
  try {
    if (req.user.role !== 'host') {
      return res.status(403).json({ error: 'Only a host can view their own incidents' });
    }
    const incidents = await SupportIncident.find({ hostId: req.user.userId }).sort({ createdAt: -1 });
    res.json({ incidents });
  } catch (error) {
    console.error('Error fetching incidents:', error);
    res.status(500).json({ error: 'Failed to fetch incidents' });
  }
};

export const getAllIncidents = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;

    const incidents = await SupportIncident.find(filter)
      .sort({ createdAt: -1 })
      .populate('hostId', 'firstName lastName email')
      .populate('hotelId', 'name');

    res.json({ incidents });
  } catch (error) {
    console.error('Error fetching incidents:', error);
    res.status(500).json({ error: 'Failed to fetch incidents' });
  }
};

async function loadAuthorizedIncident(req) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return null;
  const incident = await SupportIncident.findById(req.params.id);
  if (!incident) return null;
  if (req.user.role === 'admin') return incident;
  if (req.user.role === 'host' && incident.hostId.toString() === req.user.userId) return incident;
  return null;
}

// Lightweight counts for an admin-facing badge (e.g. admin-dashboard.ts) — deliberately its
// own endpoint rather than making the dashboard fetch full threads/incidents lists just to
// count them.
export const getSupportSummary = async (req, res) => {
  try {
    const [openIncidents, unreadMessages] = await Promise.all([
      SupportIncident.countDocuments({ status: { $in: ['open', 'in-progress'] } }),
      SupportMessage.countDocuments({ senderType: 'host', isRead: false })
    ]);
    res.json({ openIncidents, unreadMessages });
  } catch (error) {
    console.error('Error fetching support summary:', error);
    res.status(500).json({ error: 'Failed to fetch support summary' });
  }
};

export const getIncidentById = async (req, res) => {
  try {
    const incident = await loadAuthorizedIncident(req);
    if (!incident) {
      return res.status(404).json({ error: 'Incident not found' });
    }
    res.json({ incident });
  } catch (error) {
    console.error('Error fetching incident:', error);
    res.status(500).json({ error: 'Failed to fetch incident' });
  }
};

export const addIncidentReply = async (req, res) => {
  try {
    const incident = await loadAuthorizedIncident(req);
    if (!incident) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    const { message } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ error: 'Reply message is required' });
    }

    const senderType = req.user.role === 'admin' ? 'admin' : 'host';
    const senderName = senderType === 'admin' ? 'Platform Support' : (await resolveHostHotel(incident.hostId))?.name || 'Host';

    incident.replies.push({
      senderType,
      senderId: req.user.userId,
      senderName,
      message: message.trim()
    });
    await incident.save();
    // Re-fetch populated — the mutated `incident` doc still has bare hostId/hotelId
    // ObjectIds, and the admin UI's host/hotel label needs them resolved (same shape
    // getAllIncidents/getIncidentById already return) instead of falling back to "Host".
    const populated = await SupportIncident.findById(incident._id).populate('hostId', 'firstName lastName email').populate('hotelId', 'name');

    sendToRole('admin', 'support-incident', { incidentId: incident._id });
    sendToUser(incident.hostId, 'support-incident', { incidentId: incident._id });

    if (senderType === 'host') {
      await notifyAllAdmins({
        type: 'incident',
        title: `New reply on: ${incident.subject}`,
        message: messagePreview(message),
        link: '/admin/support',
        actionLabel: 'View Incident'
      });
    } else {
      await createNotification({
        userId: incident.hostId,
        type: 'incident',
        title: `Platform Support replied: ${incident.subject}`,
        message: messagePreview(message),
        link: '/host/support',
        actionLabel: 'View Incident'
      });
    }

    res.json({ message: 'Reply added', incident: populated });
  } catch (error) {
    console.error('Error adding incident reply:', error);
    res.status(500).json({ error: 'Failed to add reply' });
  }
};

export const updateIncidentStatus = async (req, res) => {
  try {
    const { status, resolutionNotes } = req.body;
    const validStatuses = ['open', 'in-progress', 'resolved', 'closed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const incident = await SupportIncident.findById(req.params.id);
    if (!incident) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    incident.status = status;
    if (['resolved', 'closed'].includes(status) && !incident.resolvedAt) {
      incident.resolvedAt = new Date();
    }
    if (resolutionNotes?.trim()) {
      incident.replies.push({
        senderType: 'admin',
        senderId: req.user.userId,
        senderName: 'Platform Support',
        message: resolutionNotes.trim()
      });
    }
    await incident.save();
    const populated = await SupportIncident.findById(incident._id).populate('hostId', 'firstName lastName email').populate('hotelId', 'name');

    sendToUser(incident.hostId, 'support-incident', { incidentId: incident._id });
    await createNotification({
      userId: incident.hostId,
      type: 'incident',
      title: `Incident ${status}: ${incident.subject}`,
      message: resolutionNotes ? messagePreview(resolutionNotes) : `Status updated to ${status}.`,
      link: '/host/support',
      actionLabel: 'View Incident'
    });

    res.json({ message: 'Incident updated', incident: populated });
  } catch (error) {
    console.error('Error updating incident:', error);
    res.status(500).json({ error: 'Failed to update incident' });
  }
};

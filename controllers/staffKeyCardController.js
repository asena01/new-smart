import StaffKeyCard from '../models/StaffKeyCard.js';
import SmartLockDevice from '../models/SmartLockDevice.js';
import Staff from '../models/Staff.js';
import ttlockService from '../services/ttlockService.js';

// Admin-only, matching the rest of this app's device-control surface. The physical
// encoding step (writing the card via the E3 encoder) happens outside this system, via
// TTHotel Pro's own software — an admin does that first, reads the resulting card number
// off it, then uses this to authorize that card on a specific lock and record who it
// was handed to.
export const issueKeyCard = async (req, res) => {
  try {
    const { staffId, deviceId, cardNumber, cardName, startDate, endDate } = req.body;

    if (!staffId || !deviceId || !cardNumber) {
      return res.status(400).json({ message: 'staffId, deviceId, and cardNumber are required' });
    }
    // TTLock's identityCard/add expects the card's numeric UID (what a real card reads out as,
    // e.g. "2052315655") — passing anything non-numeric doesn't get rejected cleanly, it makes
    // their API respond with a generic errcode 90000 "internal server error" that's useless to
    // show an admin, so catch the real problem here instead.
    if (!/^\d+$/.test(cardNumber)) {
      return res.status(400).json({ message: 'Card number must be the numeric ID read off the physical card (digits only)' });
    }

    const [staff, device] = await Promise.all([
      Staff.findById(staffId),
      SmartLockDevice.findById(deviceId)
    ]);

    if (!staff) {
      return res.status(404).json({ message: 'Staff member not found' });
    }
    if (!device || device.provider !== 'ttlock') {
      return res.status(404).json({ message: 'Digital Key device not found' });
    }
    if (String(staff.hotelId) !== String(device.hotelId)) {
      return res.status(400).json({ message: 'That staff member and device belong to different hotels' });
    }

    const result = await ttlockService.addIdentityCard({
      lockId: device.deviceId,
      cardNumber,
      cardName: cardName || `${staff.firstName} ${staff.lastName}`,
      startDate: startDate ? new Date(startDate).getTime() : undefined,
      endDate: endDate ? new Date(endDate).getTime() : undefined
    });

    const keyCard = await StaffKeyCard.create({
      staffId,
      hotelId: device.hotelId,
      deviceId,
      cardNumber,
      cardId: result.cardId,
      cardName: cardName || `${staff.firstName} ${staff.lastName}`,
      startDate: startDate || null,
      endDate: endDate || null,
      issuedBy: req.user.userId
    });

    await keyCard.populate('staffId', 'firstName lastName position');
    await keyCard.populate('deviceId', 'deviceName roomNumber');

    res.status(201).json({ keyCard });
  } catch (error) {
    console.error('Error issuing staff key card:', error.message);
    res.status(502).json({ message: error.message || 'Failed to issue the key card' });
  }
};

// Companion to issueKeyCard for the offline hotel-card scheme (E3 card encoder /
// windows-card-encoder) — no TTLock cloud call at all, since that scheme's whole point is a
// lock verifying the card with no gateway/cloud involved. This is pure bookkeeping: the
// Windows app already wrote the authorization directly onto the card before calling this.
export const issueOfflineCard = async (req, res) => {
  try {
    const { staffId, deviceId, cardNumber, cardName, endDate } = req.body;

    if (!staffId || !deviceId || !cardNumber) {
      return res.status(400).json({ message: 'staffId, deviceId, and cardNumber are required' });
    }

    const [staff, device] = await Promise.all([
      Staff.findById(staffId),
      SmartLockDevice.findById(deviceId)
    ]);

    if (!staff) {
      return res.status(404).json({ message: 'Staff member not found' });
    }
    if (!device || device.provider !== 'ttlock') {
      return res.status(404).json({ message: 'Digital Key device not found' });
    }
    if (String(staff.hotelId) !== String(device.hotelId)) {
      return res.status(400).json({ message: 'That staff member and device belong to different hotels' });
    }

    const keyCard = await StaffKeyCard.create({
      staffId,
      hotelId: device.hotelId,
      deviceId,
      cardNumber,
      method: 'offline',
      cardName: cardName || `${staff.firstName} ${staff.lastName}`,
      endDate: endDate || null,
      issuedBy: req.user.userId
    });

    await keyCard.populate('staffId', 'firstName lastName position');
    await keyCard.populate('deviceId', 'deviceName roomNumber');

    res.status(201).json({ keyCard });
  } catch (error) {
    console.error('Error recording offline key card:', error.message);
    res.status(500).json({ message: error.message || 'Failed to record the key card' });
  }
};

export const listKeyCards = async (req, res) => {
  try {
    const filter = {};
    if (req.query.hotelId) filter.hotelId = req.query.hotelId;
    if (req.query.staffId) filter.staffId = req.query.staffId;
    if (req.query.status) filter.status = req.query.status;

    const keyCards = await StaffKeyCard.find(filter)
      .populate('staffId', 'firstName lastName position')
      .populate('deviceId', 'deviceName roomNumber')
      .populate('hotelId', 'name')
      .sort({ createdAt: -1 });

    res.json({ keyCards });
  } catch (error) {
    console.error('Error listing staff key cards:', error.message);
    res.status(500).json({ message: 'Failed to list key cards' });
  }
};

export const revokeKeyCard = async (req, res) => {
  try {
    const keyCard = await StaffKeyCard.findById(req.params.id).populate('deviceId', 'deviceId');
    if (!keyCard) {
      return res.status(404).json({ message: 'Key card not found' });
    }
    if (keyCard.status === 'revoked') {
      return res.status(400).json({ message: 'This key card has already been revoked' });
    }

    // 'gateway' cards are registered in TTLock's cloud, so deleting that registration revokes
    // access instantly. 'offline' cards were never registered anywhere — the lock verifies
    // them purely from data written on the card itself — so there's nothing to delete via the
    // cloud API. Marking this record revoked here is bookkeeping only; actually blocking that
    // physical card requires either its baked-in expiry to lapse, or running a real
    // cancellation card through the lock (CE_CancelCard in windows-card-encoder), which this
    // endpoint does not do.
    if (keyCard.method !== 'offline') {
      await ttlockService.deleteIdentityCard(keyCard.deviceId.deviceId, keyCard.cardId);
    }

    keyCard.status = 'revoked';
    keyCard.revokedAt = new Date();
    await keyCard.save();

    res.json({ keyCard });
  } catch (error) {
    console.error('Error revoking staff key card:', error.message);
    res.status(502).json({ message: error.message || 'Failed to revoke the key card' });
  }
};

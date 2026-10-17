import StaffDoorKey from '../models/StaffDoorKey.js';
import Staff from '../models/Staff.js';
import Hotel from '../models/Hotel.js';
import SmartLockDevice from '../models/SmartLockDevice.js';
import ttlockService from '../services/ttlockService.js';
import { createNotification } from '../utils/notificationUtils.js';
import { recordDeviceAccessEvent, resolveActorName } from '../utils/deviceAccessEvents.js';

const MAX_ROOMS_PER_GRANT = 500;
const MAX_VALIDITY_MS = 5 * 365 * 24 * 60 * 60 * 1000;

const isLive = (key, now = new Date()) =>
  key.status === 'active' && key.startsAt <= now && (!key.expiresAt || key.expiresAt > now);

function describeExpiry(expiresAt) {
  return expiresAt
    ? `until ${new Date(expiresAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`
    : 'until it is revoked';
}

// A host may manage keys for staff at their own hotel; an admin for any hotel.
async function canManageStaffKeys(req, hotelId) {
  if (req.user.role === 'admin') return true;
  const hotel = await Hotel.findById(hotelId).select('hostId');
  return !!hotel && String(hotel.hostId) === String(req.user.userId);
}

function serializeKey(key, now = new Date()) {
  const device = key.deviceId && key.deviceId.deviceName ? key.deviceId : null;
  return {
    _id: key._id,
    staffId: key.staffId,
    roomNumber: key.roomNumber,
    deviceId: device ? device._id : key.deviceId,
    lockName: device?.deviceName || null,
    hasGateway: device ? device.hasGateway === true : null,
    startsAt: key.startsAt,
    expiresAt: key.expiresAt,
    status: key.status === 'active' && key.expiresAt && key.expiresAt <= now ? 'expired' : key.status,
    createdAt: key.createdAt
  };
}

// ---- Host / admin ------------------------------------------------------------------------

// Keys currently held by one staff member (or, without staffId, everyone at the host's hotel).
export const listStaffKeys = async (req, res) => {
  try {
    const { staffId } = req.query;
    let filter = { status: 'active' };

    if (staffId) {
      const staff = await Staff.findById(staffId).select('hotelId');
      if (!staff) return res.status(404).json({ message: 'Staff member not found' });
      if (!(await canManageStaffKeys(req, staff.hotelId))) {
        return res.status(403).json({ message: 'Not authorized to view keys for this staff member' });
      }
      filter.staffId = staffId;
    } else if (req.user.role !== 'admin') {
      const hotels = await Hotel.find({ hostId: req.user.userId }).select('_id');
      filter.hotelId = { $in: hotels.map(h => h._id) };
    }

    const keys = await StaffDoorKey.find(filter).populate('deviceId', 'deviceName hasGateway').sort({ roomNumber: 1 });
    res.json({ keys: keys.map(key => serializeKey(key)) });
  } catch (error) {
    console.error('Error listing staff door keys:', error);
    res.status(500).json({ message: 'Failed to load door keys' });
  }
};

// Gives a staff member keys to a set of rooms. Granting a room they already hold simply changes
// its expiry, so the same call both issues and extends/shortens.
export const grantStaffKeys = async (req, res) => {
  try {
    const { staffId, deviceIds, expiresAt } = req.body;

    const ids = [...new Set(Array.isArray(deviceIds) ? deviceIds.map(String) : [])];
    if (!staffId || ids.length === 0) {
      return res.status(400).json({ message: 'Choose a staff member and at least one room' });
    }
    if (ids.length > MAX_ROOMS_PER_GRANT) {
      return res.status(400).json({ message: `Give at most ${MAX_ROOMS_PER_GRANT} rooms at a time` });
    }

    let expiry = null;
    if (expiresAt) {
      expiry = new Date(expiresAt);
      if (Number.isNaN(expiry.getTime())) return res.status(400).json({ message: 'The end time is not a valid date' });
      if (expiry <= new Date()) return res.status(400).json({ message: 'The end time must be in the future' });
      if (expiry.getTime() - Date.now() > MAX_VALIDITY_MS) return res.status(400).json({ message: 'The end time is too far ahead. Leave it blank to keep the key until you revoke it.' });
    }

    const staff = await Staff.findById(staffId);
    if (!staff || staff.status !== 'active') {
      return res.status(404).json({ message: 'Active staff member not found' });
    }
    if (!(await canManageStaffKeys(req, staff.hotelId))) {
      return res.status(403).json({ message: 'Not authorized to give keys to this staff member' });
    }

    // Only locks that belong to the staff member's own hotel and are assigned to a room.
    const devices = await SmartLockDevice.find({
      _id: { $in: ids }, provider: 'ttlock', hotelId: staff.hotelId, roomNumber: { $ne: null }
    });
    if (devices.length !== ids.length) {
      return res.status(400).json({ message: "One or more of those rooms don't have a digital lock at this staff member's hotel" });
    }

    const now = new Date();
    const keys = [];
    for (const device of devices) {
      const key = await StaffDoorKey.findOneAndUpdate(
        { staffId: staff._id, deviceId: device._id, status: 'active' },
        {
          $set: { expiresAt: expiry, issuedBy: req.user.userId, roomNumber: device.roomNumber },
          $setOnInsert: { hotelId: staff.hotelId, startsAt: now }
        },
        { upsert: true, new: true }
      );
      keys.push(key);
    }

    const rooms = devices.map(d => d.roomNumber).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    await createNotification({
      userId: staff.userId,
      type: 'alert',
      title: 'Digital key assigned',
      message: `You can now unlock ${rooms.length === 1 ? `Room ${rooms[0]}` : rooms.length <= 6 ? `Rooms ${rooms.join(', ')}` : `${rooms.length} rooms`} from the app, ${describeExpiry(expiry)}.`,
      link: '/staff/door-keys',
      actionLabel: 'Open My Keys'
    });

    const populated = await StaffDoorKey.find({ _id: { $in: keys.map(k => k._id) } }).populate('deviceId', 'deviceName hasGateway');
    res.status(201).json({ keys: populated.map(key => serializeKey(key)) });
  } catch (error) {
    console.error('Error granting staff door keys:', error);
    res.status(500).json({ message: 'Failed to give the digital key' });
  }
};

export const revokeStaffKey = async (req, res) => {
  try {
    const key = await StaffDoorKey.findById(req.params.id);
    if (!key) return res.status(404).json({ message: 'Key not found' });
    if (!(await canManageStaffKeys(req, key.hotelId))) {
      return res.status(403).json({ message: 'Not authorized to revoke this key' });
    }
    if (key.status === 'revoked') return res.json({ message: 'Key already revoked' });

    key.status = 'revoked';
    key.revokedAt = new Date();
    key.revokedBy = req.user.userId;
    await key.save();

    const staff = await Staff.findById(key.staffId).select('userId');
    if (staff?.userId) {
      await createNotification({
        userId: staff.userId,
        type: 'alert',
        title: 'Digital key removed',
        message: `Your key to Room ${key.roomNumber} has been removed.`,
        link: '/staff/door-keys',
        actionLabel: 'Open My Keys'
      });
    }
    res.json({ message: 'Key revoked' });
  } catch (error) {
    console.error('Error revoking staff door key:', error);
    res.status(500).json({ message: 'Failed to revoke the key' });
  }
};

// ---- Staff (the mobile app) --------------------------------------------------------------

async function myActiveStaff(req) {
  return Staff.findOne({ userId: req.user.userId, status: 'active' }).select('_id hotelId');
}

// The keys this staff member can use right now.
export const getMyKeys = async (req, res) => {
  try {
    const staff = await myActiveStaff(req);
    if (!staff) return res.json({ keys: [] });

    const now = new Date();
    const keys = await StaffDoorKey.find({
      staffId: staff._id, status: 'active', startsAt: { $lte: now }, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
    }).populate('deviceId', 'deviceName hasGateway').populate('hotelId', 'name').sort({ roomNumber: 1 });

    res.json({
      keys: keys.map(key => ({ ...serializeKey(key, now), hotelName: key.hotelId?.name || null }))
    });
  } catch (error) {
    console.error('Error loading my door keys:', error);
    res.status(500).json({ message: 'Failed to load your keys' });
  }
};

// Every unlock goes through this check, so a revoked, expired or not-yet-started key, a staff
// member who has been deactivated, or a lock that has since moved to another hotel all stop
// working immediately.
async function loadUsableKey(req, res) {
  const staff = await myActiveStaff(req);
  if (!staff) {
    res.status(403).json({ message: 'Your staff account is not active' });
    return null;
  }
  const key = await StaffDoorKey.findOne({ _id: req.params.id, staffId: staff._id });
  if (!key) {
    res.status(404).json({ message: 'Key not found' });
    return null;
  }
  if (!isLive(key)) {
    res.status(403).json({ message: key.status === 'revoked' ? 'This key has been removed' : 'This key has expired' });
    return null;
  }
  const device = await SmartLockDevice.findById(key.deviceId);
  if (!device || String(device.hotelId) !== String(key.hotelId) || device.roomNumber !== key.roomNumber) {
    res.status(403).json({ message: 'This lock is no longer assigned to that room' });
    return null;
  }
  return { key, device };
}

// Bluetooth unlock: hands the app the lock's data, which it uses right away and should never keep.
export const getKeyCredentials = async (req, res) => {
  try {
    const usable = await loadUsableKey(req, res);
    if (!usable) return;
    const lockData = await ttlockService.getLockData(usable.device.deviceId);
    res.json({
      lockData: lockData.lockData,
      lockMac: lockData.lockMac,
      lockName: lockData.lockAlias || lockData.lockName,
      hasGateway: usable.device.hasGateway === true
    });
  } catch (error) {
    console.error('Error fetching door key credentials:', error.message);
    res.status(502).json({ message: 'Could not reach the lock service. Try again in a moment.' });
  }
};

// Remote unlock through the gateway, for when the staff member isn't at the door.
export const remoteUnlockWithKey = async (req, res) => {
  try {
    const usable = await loadUsableKey(req, res);
    if (!usable) return;
    if (usable.device.hasGateway !== true) {
      return res.status(400).json({ message: 'Remote unlock is not available for this room right now. Unlock it over Bluetooth at the door.' });
    }

    const result = await ttlockService.unlockDevice(usable.device.deviceId);
    if (result.errcode) {
      return res.status(502).json({ message: result.errmsg || 'Failed to unlock the door remotely' });
    }
    await recordDeviceAccessEvent({
      deviceId: usable.device._id,
      action: 'unlock',
      actorRole: 'staff',
      actorName: await resolveActorName(req)
    });
    res.json({ message: 'Door unlocked' });
  } catch (error) {
    console.error('Error unlocking with a door key:', error.message);
    res.status(502).json({ message: error.message || 'Failed to unlock the door remotely' });
  }
};

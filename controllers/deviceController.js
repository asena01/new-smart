import SmartLockDevice from '../models/SmartLockDevice.js';
import Hotel from '../models/Hotel.js';
import ttlockService from '../services/ttlockService.js';
import tuyaService from '../services/tuyaService.js';

// The TTLock/Tuya integrations are single, platform-wide accounts — device inventory
// isn't naturally partitioned per hotel. So a host only ever gets visibility into
// devices already assigned to hotels they own, never the raw unassigned pool (that's
// an admin-only discovery/import step, since it'd otherwise leak other hotels' locks).
async function getHostHotelIds(userId) {
  const hotels = await Hotel.find({ hostId: userId }).select('_id');
  return hotels.map(h => h._id);
}

async function isHostsOwnHotel(userId, hotelId) {
  if (!hotelId) return false;
  const hotel = await Hotel.findOne({ _id: hotelId, hostId: userId }).select('_id');
  return !!hotel;
}

async function isHostsOwnDevice(userId, device) {
  return isHostsOwnHotel(userId, device.hotelId);
}

export const listDevices = async (req, res) => {
  try {
    const filter = {};
    if (req.query.provider) filter.provider = req.query.provider;

    if (req.user.role === 'host') {
      filter.hotelId = { $in: await getHostHotelIds(req.user.userId) };
    }

    const devices = await SmartLockDevice.find(filter)
      .populate('hotelId', 'name')
      .sort({ createdAt: -1 });

    res.json({ devices });
  } catch (error) {
    console.error('Error listing devices:', error);
    res.status(500).json({ message: 'Failed to list devices' });
  }
};

// Real devices already linked to this Tuya Cloud project's account, so the admin can
// import a real device instead of typing an ID blind.
export const discoverTuyaDevices = async (req, res) => {
  try {
    const [accountDevices, imported] = await Promise.all([
      tuyaService.listAccountDevices(),
      SmartLockDevice.find({ provider: 'tuya' }).select('deviceId')
    ]);

    const importedIds = new Set(imported.map(d => d.deviceId));

    const devices = accountDevices.map(d => ({
      deviceId: d.id,
      name: d.name,
      category: d.category,
      productName: d.product_name,
      online: d.online,
      alreadyImported: importedIds.has(d.id)
    }));

    res.json({ devices });
  } catch (error) {
    console.error('Error discovering Tuya devices:', error);
    res.status(502).json({ message: error.message || 'Failed to reach Tuya' });
  }
};

// Every lock this account actually holds a working eKey for (see ttlockService.listLocks),
// so the admin can import a real, controllable device instead of typing a lockId blind for
// a lock that may not even be shared to this account yet.
export const discoverTTLockDevices = async (req, res) => {
  try {
    const [accountLocks, imported] = await Promise.all([
      ttlockService.listLocks(),
      SmartLockDevice.find({ provider: 'ttlock' }).select('deviceId')
    ]);

    const importedIds = new Set(imported.map(d => d.deviceId));

    const devices = accountLocks.map(lock => ({
      deviceId: String(lock.lockId),
      name: lock.lockAlias || lock.lockName,
      battery: lock.electricQuantity,
      alreadyImported: importedIds.has(String(lock.lockId))
    }));

    // Not a secret — this is the recipient username admins need when sharing a new lock's
    // eKey from their own TTLock app. Surfacing it here is what makes a lock show up above.
    res.json({ devices, serviceAccountUsername: process.env.TTLOCK_USERNAME || null });
  } catch (error) {
    console.error('Error discovering TTLock devices:', error);
    res.status(502).json({ message: error.message || 'Failed to reach the digital lock service' });
  }
};

export const createDevice = async (req, res) => {
  try {
    const { provider, deviceId, deviceName, clientId, region, location } = req.body;

    if (!provider || !deviceId || !deviceName) {
      return res.status(400).json({ message: 'provider, deviceId, and deviceName are required' });
    }
    if (!['ttlock', 'tuya'].includes(provider)) {
      return res.status(400).json({ message: 'provider must be ttlock or tuya' });
    }

    const existing = await SmartLockDevice.findOne({ provider, deviceId });
    if (existing) {
      return res.status(400).json({ message: 'A device with this ID is already registered' });
    }

    const device = await SmartLockDevice.create({
      provider,
      deviceId,
      deviceName,
      clientId,
      region,
      location,
      addedBy: req.user.userId
    });

    res.status(201).json({ device });
  } catch (error) {
    console.error('Error creating device:', error);
    res.status(500).json({ message: 'Failed to create device' });
  }
};

export const updateDevice = async (req, res) => {
  try {
    const existing = await SmartLockDevice.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: 'Device not found' });
    }
    if (req.user.role === 'host' && !(await isHostsOwnDevice(req.user.userId, existing))) {
      return res.status(403).json({ message: 'Not authorized for this device' });
    }

    const { deviceName, location, clientId, region } = req.body;

    const device = await SmartLockDevice.findByIdAndUpdate(
      req.params.id,
      { deviceName, location, clientId, region },
      { new: true, runValidators: true }
    );

    res.json({ device });
  } catch (error) {
    console.error('Error updating device:', error);
    res.status(500).json({ message: 'Failed to update device' });
  }
};

export const deleteDevice = async (req, res) => {
  try {
    const device = await SmartLockDevice.findByIdAndDelete(req.params.id);
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }
    res.json({ message: 'Device deleted' });
  } catch (error) {
    console.error('Error deleting device:', error);
    res.status(500).json({ message: 'Failed to delete device' });
  }
};

// Clears a room's smart-lock/check-in config back to standard — but only if it's
// still pointed at this exact device, so reassigning the room elsewhere first can
// never be clobbered by an unrelated unassign call landing after it.
async function clearRoomSmartLock(hotelId, roomNumber, deviceId) {
  if (!hotelId || !roomNumber) return;
  await Hotel.updateOne(
    { _id: hotelId, 'rooms.roomNumber': roomNumber, 'rooms.smartLockIntegration.deviceId': deviceId },
    {
      $set: {
        'rooms.$.smartLockIntegration.provider': 'none',
        'rooms.$.smartLockIntegration.deviceId': null,
        'rooms.$.smartLockIntegration.clientId': null,
        'rooms.$.smartLockIntegration.isActive': false,
        'rooms.$.checkInType': 'standard'
      }
    }
  );
}

// Room assignment is admin-only (see routes/devices.js) — a host can view/test devices
// already assigned to their hotel, but moving a device between rooms is a platform-level
// action, so there's no host-ownership branch here.
export const assignDevice = async (req, res) => {
  try {
    const { hotelId, roomNumber } = req.body;
    const device = await SmartLockDevice.findById(req.params.id);
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }

    // Only TTLock devices double as a room's check-in/unlock mechanism — Tuya covers
    // other in-room devices, so it never touches smartLockIntegration/checkInType.
    const isLock = device.provider === 'ttlock';

    // Unassigning: clear the room's guest check-in wiring, then clear the device.
    if (!hotelId || !roomNumber) {
      if (isLock) await clearRoomSmartLock(device.hotelId, device.roomNumber, device.deviceId);
      device.hotelId = null;
      device.roomNumber = null;
      await device.save();
      await device.populate('hotelId', 'name');
      return res.json({ device });
    }

    const hotel = await Hotel.findOne({ _id: hotelId, 'rooms.roomNumber': roomNumber });
    if (!hotel) {
      return res.status(404).json({ message: 'Room not found on that hotel' });
    }

    // Scoped to the same provider — a room can hold one TTLock device (the lock) and,
    // separately, one Tuya device at the same time; they don't compete for the room.
    const conflicting = await SmartLockDevice.findOne({
      _id: { $ne: device._id },
      provider: device.provider,
      hotelId,
      roomNumber
    });
    if (conflicting) {
      return res.status(409).json({
        message: `Room ${roomNumber} already has "${conflicting.deviceName}" (${conflicting.provider}) assigned. Unassign it first before assigning a different device to this room.`
      });
    }

    // Moving to a different hotel/room: release the old room first.
    if (isLock && device.hotelId && (String(device.hotelId) !== String(hotelId) || device.roomNumber !== roomNumber)) {
      await clearRoomSmartLock(device.hotelId, device.roomNumber, device.deviceId);
    }

    if (isLock) {
      await Hotel.updateOne(
        { _id: hotelId, 'rooms.roomNumber': roomNumber },
        {
          $set: {
            'rooms.$.smartLockIntegration.provider': device.provider,
            'rooms.$.smartLockIntegration.deviceId': device.deviceId,
            'rooms.$.smartLockIntegration.clientId': device.clientId || null,
            'rooms.$.smartLockIntegration.isActive': device.connectionStatus === 'online',
            'rooms.$.checkInType': 'both'
          }
        }
      );
    }

    device.hotelId = hotelId;
    device.roomNumber = roomNumber;
    await device.save();
    await device.populate('hotelId', 'name');

    res.json({ device });
  } catch (error) {
    console.error('Error assigning device:', error);
    res.status(500).json({ message: 'Failed to assign device' });
  }
};

// Access history lives on each provider's own side, not ours — this just proxies
// whichever provider's event-log API the device belongs to. TTLock's lockRecord/list
// is page-number paginated; Tuya's device logs endpoint is cursor-paginated (row key),
// so the two response shapes intentionally stay distinct rather than forced into one.
export const getDeviceLogs = async (req, res) => {
  try {
    const device = await SmartLockDevice.findById(req.params.id);
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }
    if (req.user.role === 'host' && !(await isHostsOwnDevice(req.user.userId, device))) {
      return res.status(403).json({ message: 'Not authorized for this device' });
    }

    if (device.provider === 'ttlock') {
      const startDate = Number(req.query.startDate) || 0;
      const endDate = Number(req.query.endDate) || 0;
      const pageNo = Number(req.query.pageNo) || 1;
      const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);

      const data = await ttlockService.getLockRecords(device.deviceId, { startDate, endDate, pageNo, pageSize });
      const records = (data.list || []).map(r => ({
        recordType: r.recordType,
        success: r.success === 1,
        username: r.username || '',
        keyboardPwd: r.keyboardPwd || '',
        lockDate: r.lockDate,
        serverDate: r.serverDate
      }));
      return res.json({ records, pageNo: data.pageNo, pageSize: data.pageSize, pages: data.pages, total: data.total });
    }

    if (device.provider === 'tuya') {
      const startTime = Number(req.query.startDate) || 0;
      const endTime = Number(req.query.endDate) || Date.now();
      const size = Math.min(Number(req.query.pageSize) || 20, 100);
      const startRowKey = req.query.startRowKey || undefined;

      const data = await tuyaService.getDeviceLogs(device.deviceId, { startTime, endTime, size, startRowKey });
      const records = (data.logs || []).map(l => ({
        code: l.code,
        value: l.value,
        eventTime: l.event_time
      }));
      return res.json({ records, hasNext: !!data.has_next, nextRowKey: data.next_row_key || null });
    }

    res.status(400).json({ message: 'Access logs are not available for this device type' });
  } catch (error) {
    console.error('Error fetching device logs:', error);
    res.status(502).json({ message: error.message || 'Failed to fetch access logs' });
  }
};

export const testConnection = async (req, res) => {
  try {
    const device = await SmartLockDevice.findById(req.params.id);
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }
    if (req.user.role === 'host' && !(await isHostsOwnDevice(req.user.userId, device))) {
      return res.status(403).json({ message: 'Not authorized for this device' });
    }

    let result;
    if (device.provider === 'ttlock') {
      result = await ttlockService.testConnection(device.deviceId);
    } else {
      try {
        const detail = await tuyaService.getDeviceDetail(device.deviceId);
        result = { success: true, online: detail.online, message: detail.online ? 'Device is online.' : 'Device is registered but currently offline.' };
      } catch (error) {
        result = { success: false, message: error.message };
      }
    }

    device.connectionStatus = result.success ? (result.online === false ? 'offline' : 'online') : 'error';
    device.lastError = result.success ? null : result.message;
    device.lastCheckedAt = new Date();
    await device.save();

    if (device.hotelId && device.roomNumber) {
      await Hotel.updateOne(
        { _id: device.hotelId, 'rooms.roomNumber': device.roomNumber, 'rooms.smartLockIntegration.deviceId': device.deviceId },
        { $set: { 'rooms.$.smartLockIntegration.isActive': device.connectionStatus === 'online' } }
      );
    }

    await device.populate('hotelId', 'name');
    res.json({ device, result });
  } catch (error) {
    console.error('Error testing device connection:', error);
    res.status(500).json({ message: 'Failed to test device connection' });
  }
};

import SmartLockDevice from '../models/SmartLockDevice.js';
import Hotel from '../models/Hotel.js';
import Staff from '../models/Staff.js';
import Booking from '../models/Booking.js';
import DeviceAccessEvent from '../models/DeviceAccessEvent.js';
import ttlockService from '../services/ttlockService.js';
import tuyaService from '../services/tuyaService.js';
import { canManageHotel } from '../utils/staffAuth.js';
import { resolveActorName, recordDeviceAccessEvent } from '../utils/deviceAccessEvents.js';

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
    } else if (req.user.role === 'staff') {
      // A staff member only ever has one hotel — same idea as getHostHotelIds, but resolved
      // via their own Staff record instead of Hotel.hostId. Reception uses this list (filtered
      // to canRemoteUnlock-eligible ttlock devices client-side) to pick a room to lock/unlock.
      const staff = await Staff.findOne({ userId: req.user.userId, status: 'active' }).select('hotelId');
      // No active staff record (shouldn't normally happen) — match nothing rather than
      // falling through to an unfiltered/unassigned-device query.
      if (!staff?.hotelId) return res.json({ devices: [] });
      filter.hotelId = staff.hotelId;
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

    const { deviceName, location, clientId, region, buildingNumber, floorNumber } = req.body;

    const device = await SmartLockDevice.findByIdAndUpdate(
      req.params.id,
      { deviceName, location, clientId, region, buildingNumber, floorNumber },
      { new: true, runValidators: true }
    );

    res.json({ device });
  } catch (error) {
    console.error('Error updating device:', error);
    res.status(500).json({ message: 'Failed to update device' });
  }
};

// Everything needed to either (a) write one hotel card for this lock from a card-encoder
// companion app, or (b) provision the lock itself over Bluetooth from the mobile app
// (Ttlock.setHotelData — see mobile/src/screens), in one call: a freshly-fetched hotelInfo
// (only valid 10 minutes, so this must never be cached or reused across calls — see
// ttlockService.getHotelInfo), the lock's MAC (fetched live rather than stored, since it
// never changes but we don't otherwise need it), our own service account's admin lockData
// (see ttlockService.getLockData — the same credential getLockCredentials hands guests, just
// not booking-scoped here since provisioning isn't tied to a stay), and the
// buildingNumber/floorNumber an admin assigned via updateDevice. clientSecret itself never
// leaves this backend.
export const getHotelCardInfo = async (req, res) => {
  try {
    const device = await SmartLockDevice.findById(req.params.id);
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }
    if (device.provider !== 'ttlock') {
      return res.status(400).json({ message: 'Hotel card info is only available for Digital Key (TTLock) devices' });
    }
    if (req.user.role !== 'admin' && !(await canManageHotel(req, device.hotelId, 'canManageDevices'))) {
      return res.status(403).json({ message: 'Not authorized to provision this device' });
    }
    if (device.buildingNumber == null || device.floorNumber == null) {
      return res.status(400).json({ message: 'Set a building number and floor number for this lock first (Edit device)' });
    }

    const [hotelInfo, lockDetail, lockDataResult] = await Promise.all([
      ttlockService.getHotelInfo(),
      ttlockService.getLockDetail(device.deviceId),
      ttlockService.getLockData(device.deviceId)
    ]);

    res.json({
      hotelInfo,
      lockMac: lockDetail.lockMac,
      lockData: lockDataResult.lockData,
      lockId: device.deviceId,
      buildingNumber: device.buildingNumber,
      floorNumber: device.floorNumber
    });
  } catch (error) {
    console.error('Error fetching hotel card info:', error.message);
    res.status(502).json({ message: error.message || 'Failed to fetch hotel card info' });
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

// TTLock's own access log never says who a given event belongs to — it only ever shows our
// one shared service account, whether the event was a guest's phone, a staff member's remote
// click, or a passcode punched into a keypad this property doesn't actually have. This fills
// that gap after the fact from data we already have, using whichever method applies to the
// event's recordType. Mutates the passed-in records in place, adding `guestName` and/or
// `staffName` where a match is found.
//
// recordType 1 (App unlock, Bluetooth) — mobile/src/screens/LockScreen.tsx's controlLock is
// the only thing in this app that produces this recordType, and only a guest currently
// checked into that room could have the lockData needed to do it. So any unmatched recordType
// 1 event during a booking's stay window is that guest, no passcode or new logging required.
//
// recordType 3/11/12 (Gateway/remote lock or unlock) — genuinely ambiguous: could be an
// admin/host/staff member clicking Lock/Unlock in the web or mobile panel, or a guest's "let
// someone in remotely" request (bookingController.remoteUnlockBooking). Both write a
// DeviceAccessEvent at the moment they call TTLock's API (see deviceAccessEvents.js), so this
// looks for the nearest one within a tight window — these are direct, synchronous calls we
// make ourselves, so the TTLock log entry and our own event happen within seconds of each other.
async function attachAccessAttribution(records, device) {
  const passcodeCandidates = records.filter(r => r.keyboardPwd);
  const bluetoothCandidates = records.filter(r => r.recordType === 1 && !r.keyboardPwd);
  const remoteCandidates = records.filter(r => [3, 11, 12].includes(r.recordType));

  if (device.hotelId && device.roomNumber && (passcodeCandidates.length > 0 || bluetoothCandidates.length > 0)) {
    const codes = [...new Set(passcodeCandidates.map(r => r.keyboardPwd))];
    const bookings = await Booking.find({
      hotelId: device.hotelId,
      roomId: device.roomNumber,
      status: { $in: ['confirmed', 'completed'] }
    })
      .select('guestName userId checkInDate checkOutDate contactlessCheckIn.smartLockCode')
      .populate('userId', 'firstName lastName');

    const nameOf = b => (b.userId ? `${b.userId.firstName} ${b.userId.lastName}` : (b.guestName || null));

    for (const record of passcodeCandidates) {
      const matches = bookings.filter(b => codes.includes(record.keyboardPwd) && b.contactlessCheckIn?.smartLockCode === record.keyboardPwd);
      if (matches.length === 0) continue;
      // The same code string could in principle have been issued to two different bookings at
      // different times (TTLock recycles passcode slots) — prefer whichever booking's stay
      // window actually contains this event, falling back to any match if none line up exactly.
      const lockTime = new Date(record.lockDate);
      const match = matches.find(b => lockTime >= b.checkInDate && lockTime <= b.checkOutDate) || matches[0];
      record.guestName = nameOf(match);
    }

    for (const record of bluetoothCandidates) {
      const lockTime = new Date(record.lockDate);
      const match = bookings.find(b => lockTime >= b.checkInDate && lockTime <= b.checkOutDate);
      if (match) record.guestName = nameOf(match);
    }
  }

  if (remoteCandidates.length > 0) {
    const events = await DeviceAccessEvent.find({ deviceId: device._id }).sort({ triggeredAt: 1 });
    const TOLERANCE_MS = 60 * 1000;

    for (const record of remoteCandidates) {
      const action = record.recordType === 11 ? 'lock' : 'unlock';
      const lockTime = record.lockDate;
      let closest = null;
      let closestDiff = Infinity;
      for (const event of events) {
        if (event.action !== action) continue;
        const diff = Math.abs(event.triggeredAt.getTime() - lockTime);
        if (diff < closestDiff) {
          closest = event;
          closestDiff = diff;
        }
      }
      if (closest && closestDiff <= TOLERANCE_MS) {
        if (closest.actorRole === 'guest') record.guestName = closest.actorName;
        else record.staffName = closest.actorName;
      }
    }
  }
}

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

      await attachAccessAttribution(records, device);

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
    // A stale gateway-connected lock still returns success:true (see ttlockService.testConnection),
    // so lastError needs its explanatory message in that case too, not just on a hard failure.
    device.lastError = !result.success ? result.message : (result.online === false ? result.message : null);
    device.lastCheckedAt = new Date();
    if (device.provider === 'ttlock' && result.success) {
      if (typeof result.battery === 'number') device.batteryLevel = result.battery;
      if (typeof result.hasGateway === 'boolean') device.hasGateway = result.hasGateway;
      if (result.lastReportedAt) device.lastReportedAt = result.lastReportedAt;
      device.gatewayName = result.hasGateway ? (result.gatewayName ?? null) : null;
      device.gatewaySignal = result.hasGateway ? (result.gatewaySignal ?? null) : null;
    }
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

// Earlier assumption here was wrong: an errcode -4043 on this lock turned out to be a
// per-device "remote unlock" toggle in TTLock's own app, not a hard model/firmware
// restriction — once the seller enabled it on the lock, /lock/unlock started succeeding.
// So unlockRemote below is real, not blocked. Both still require a gateway actually
// bridging the lock (hasGateway) — without one there's no path for the cloud command to
// reach it at all — and both are gated on canRemoteUnlock (admin/host always pass via
// canManageHotel; a receptionist needs the permission explicitly granted, which is the
// default for that position — see staffPermissions.js).
export const lockRemote = async (req, res) => {
  try {
    const device = await SmartLockDevice.findById(req.params.id);
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }
    if (device.provider !== 'ttlock') {
      return res.status(400).json({ message: 'Remote lock is only available for Digital Key (TTLock) devices' });
    }
    if (req.user.role !== 'admin' && !(await canManageHotel(req, device.hotelId, 'canRemoteUnlock'))) {
      return res.status(403).json({ message: 'Not authorized to remotely lock this device' });
    }

    const result = await ttlockService.lockDevice(device.deviceId);
    if (result.errcode) {
      return res.status(502).json({ message: result.errmsg || 'Failed to lock the device remotely' });
    }

    // Best-effort attribution for the Access Logs panel — TTLock's own log has no idea who
    // triggered this, since it all comes through our one service account. See getDeviceLogs.
    await recordDeviceAccessEvent({
      deviceId: device._id,
      action: 'lock',
      actorRole: req.user.role,
      actorName: await resolveActorName(req)
    });

    res.json({ message: 'Lock command sent successfully' });
  } catch (error) {
    console.error('Error locking device remotely:', error);
    res.status(502).json({ message: error.message || 'Failed to lock the device remotely' });
  }
};

export const unlockRemote = async (req, res) => {
  try {
    const device = await SmartLockDevice.findById(req.params.id);
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }
    if (device.provider !== 'ttlock') {
      return res.status(400).json({ message: 'Remote unlock is only available for Digital Key (TTLock) devices' });
    }
    if (req.user.role !== 'admin' && !(await canManageHotel(req, device.hotelId, 'canRemoteUnlock'))) {
      return res.status(403).json({ message: 'Not authorized to remotely unlock this device' });
    }

    const result = await ttlockService.unlockDevice(device.deviceId);
    if (result.errcode) {
      return res.status(502).json({ message: result.errmsg || 'Failed to unlock the device remotely' });
    }

    await recordDeviceAccessEvent({
      deviceId: device._id,
      action: 'unlock',
      actorRole: req.user.role,
      actorName: await resolveActorName(req)
    });

    res.json({ message: 'Unlock command sent successfully' });
  } catch (error) {
    console.error('Error unlocking device remotely:', error);
    res.status(502).json({ message: error.message || 'Failed to unlock the device remotely' });
  }
};

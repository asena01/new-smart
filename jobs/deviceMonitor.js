import SmartLockDevice from '../models/SmartLockDevice.js';
import DeviceStatusEvent from '../models/DeviceStatusEvent.js';
import User from '../models/User.js';
import Hotel from '../models/Hotel.js';
import ttlockService from '../services/ttlockService.js';
import tuyaService from '../services/tuyaService.js';
import { sendToRole } from '../utils/sseHub.js';
import { createNotification } from '../utils/notificationUtils.js';

// Every TTLock check is a metered call on the TTLock Open Platform (the plan has a monthly cap), so
// this is deliberately slow: every lock was once checked every 2 minutes, ~700 calls per lock a month
// per hour of the day. 10 minutes is still quick enough to notice an offline lock well inside the
// stale threshold below.
const POLL_INTERVAL_MS = Number(process.env.DEVICE_MONITOR_INTERVAL_MS) || 10 * 60 * 1000;
// A Bluetooth-only lock has no gateway: all a check can tell us is its battery, which moves slowly,
// so it is looked at once an hour instead of every poll.
const BLUETOOTH_ONLY_CHECK_INTERVAL_MS = Number(process.env.DEVICE_BLE_CHECK_INTERVAL_MS) || 60 * 60 * 1000;
const LOW_BATTERY_THRESHOLD = Number(process.env.DEVICE_LOW_BATTERY_THRESHOLD) || 20;
// Below this a lock is about to stop working — a second, more urgent alert after the low one.
const CRITICAL_BATTERY_THRESHOLD = Number(process.env.DEVICE_CRITICAL_BATTERY_THRESHOLD) || 5;
// TTLock's /lock/detail never errors just because a lock has gone dark (dead battery, out
// of gateway range) — it keeps successfully returning the last report the lock ever sent.
// So "the API call succeeded" alone can't detect that; only gateway-connected locks report
// in on their own on any real cadence, so staleness of lockUpdateDate/electricQuantityUpdateDate
// is the actual offline signal, and only meaningful for those (a Bluetooth-only lock only ever
// reports when a phone happens to sync with it, so "hasn't reported in an hour" is normal there,
// not a fault).
// Idle locks rarely send their own report (observed: hours), so the gateway's own re-scan of the
// lock (rssiUpdateDate, every few minutes) is counted as a sign of life too — see ttlockService.getLockLastSeen.
const STALE_THRESHOLD_MS = Number(process.env.DEVICE_STALE_THRESHOLD_MS) || 30 * 60 * 1000;

// Who an alert about this device concerns. Every admin always hears about it; so does the host of
// each hotel the device is assigned to. A gateway is shared infrastructure that usually has no
// hotel of its own, so its hotels are those of the sensors paired through it — a gateway going down
// matters to every host whose door sensors depend on it.
async function resolveAlertContext(device) {
  const hotelIds = new Set();
  const addHotel = id => { if (id) hotelIds.add(String(id._id || id)); };

  addHotel(device.hotelId);
  if (device.isGateway) {
    const sensors = await SmartLockDevice.find({ gatewayDeviceId: device.deviceId, hotelId: { $ne: null } }).select('hotelId');
    sensors.forEach(sensor => addHotel(sensor.hotelId));
  }

  const hotels = hotelIds.size ? await Hotel.find({ _id: { $in: [...hotelIds] } }).select('name hostId') : [];
  return {
    hostIds: [...new Set(hotels.map(h => h.hostId && String(h.hostId)).filter(Boolean))],
    hotelNames: hotels.map(h => h.name)
  };
}

function locationLabel(device, hotelNames = []) {
  if (device.isGateway) return hotelNames.length ? `Zigbee Gateway — ${hotelNames.join(', ')}` : 'Zigbee Gateway';
  return device.hotelId?.name ? `${device.hotelId.name} — Room ${device.roomNumber}` : 'Unassigned';
}

// One alert, delivered to every admin and to the host(s) of the hotel the device belongs to. A
// failure notifying one person must not stop the others, so each is sent on its own.
async function notifyDeviceAlert(device, { title, message, adminLink }) {
  const { hostIds } = await resolveAlertContext(device);
  const admins = await User.find({ role: 'admin' }).select('_id');

  const send = (userId, link) => createNotification({ userId, type: 'alert', title, message, link, actionLabel: 'View Device' })
    .catch(error => console.error('Device alert notification failed:', error.message));

  await Promise.all([
    ...admins.map(admin => send(admin._id, adminLink)),
    // The host has no device-management page — rooms is where a room's lock and access are shown.
    ...hostIds.map(hostId => send(hostId, '/host/rooms'))
  ]);
}

// Shared by both providers' polling loops below — a status regression/recovery looks the
// same to an admin regardless of whether it came from a TTLock or a Tuya device, only the
// "View Device" link differs. Also where every real status change gets persisted (regardless
// of whether it was notification-worthy) so the Access Logs panel can later reconstruct "we
// have no data for this span, the device was offline" instead of a silent gap.
// `quiet` still records the change but sends no alert — used for a sensor that is only offline
// because the gateway it sits behind is (the gateway's own alert already says so).
async function notifyStatusTransition(device, previousStatus, newStatus, lastError, link, { quiet = false } = {}) {
  if (previousStatus !== newStatus) {
    await DeviceStatusEvent.create({ device: device._id, status: newStatus });
  }
  if (quiet) return;

  const noun = device.isGateway ? 'Gateway' : 'Device';

  if (previousStatus === 'online' && newStatus !== 'online') {
    const { hotelNames } = await resolveAlertContext(device);
    const location = locationLabel(device, hotelNames);
    sendToRole('admin', 'device-offline', {
      deviceId: String(device._id),
      deviceName: device.deviceName,
      hotelName: device.hotelId?.name || null,
      roomNumber: device.roomNumber,
      lastError
    });
    await notifyDeviceAlert(device, {
      title: `${noun} offline`,
      message: `${device.deviceName} (${location}) went offline${lastError ? ': ' + lastError : '.'}`,
      adminLink: link
    });
  }

  // The reverse transition — without this, a page already open when a device recovers has no
  // way to learn that and keeps showing stale "offline" until someone manually reloads or hits
  // Test.
  if (previousStatus !== 'online' && previousStatus !== 'unknown' && newStatus === 'online') {
    const { hotelNames } = await resolveAlertContext(device);
    const location = locationLabel(device, hotelNames);
    sendToRole('admin', 'device-online', {
      deviceId: String(device._id),
      deviceName: device.deviceName,
      hotelName: device.hotelId?.name || null,
      roomNumber: device.roomNumber
    });
    await notifyDeviceAlert(device, {
      title: `${noun} back online`,
      message: `${device.deviceName} (${location}) is reporting again.`,
      adminLink: link
    });
  }
}

// Low and nearly-empty battery share one path so both providers (and both thresholds) alert the
// same way, once each as the level crosses down — not on every poll while it stays low.
async function notifyBatteryCrossing(device, previousBattery, battery, link) {
  if (battery === null) return;
  const location = locationLabel(device);
  const crossed = threshold => battery <= threshold && (previousBattery === null || previousBattery > threshold);

  let title = null;
  if (crossed(CRITICAL_BATTERY_THRESHOLD)) title = 'Battery almost empty';
  else if (crossed(LOW_BATTERY_THRESHOLD)) title = 'Low battery';
  if (!title) return;

  sendToRole('admin', 'device-low-battery', {
    deviceId: String(device._id),
    deviceName: device.deviceName,
    hotelName: device.hotelId?.name || null,
    roomNumber: device.roomNumber,
    batteryLevel: battery
  });
  await notifyDeviceAlert(device, {
    title,
    message: `${device.deviceName} (${location}) battery at ${battery}%.${title === 'Battery almost empty' ? ' Replace the batteries now or the lock will stop working.' : ''}`,
    adminLink: link
  });
}

// TTLock-only: Tuya's getDeviceDetail has no battery field, and this job exists
// specifically to catch a lock dying or going dark between admin visits — without
// this, connectionStatus/batteryLevel only ever update when someone clicks "Test".
// `filter` narrows which devices are checked — used by tests so they only touch their own.
export async function checkDevices(filter = {}) {
  const devices = await SmartLockDevice.find({ provider: 'ttlock', ...filter }).populate('hotelId', 'name');

  const now = Date.now();
  for (const device of devices) {
    // Not asked for by name (tests pass a filter) and known to have no gateway: skip until it is due.
    if (!Object.keys(filter).length && device.hasGateway === false && device.lastCheckedAt && now - device.lastCheckedAt.getTime() < BLUETOOTH_ONLY_CHECK_INTERVAL_MS) continue;

    const previousStatus = device.connectionStatus;
    const previousBattery = device.batteryLevel;

    let newStatus;
    let battery = previousBattery;
    let lastError = null;
    let lastReportedAt = device.lastReportedAt;
    let hasGateway = device.hasGateway;

    try {
      const detail = await ttlockService.getLockDetail(device.deviceId);
      hasGateway = detail.hasGateway === 1;
      if (typeof detail.electricQuantity === 'number') battery = detail.electricQuantity;

      const reportedAt = await ttlockService.getLockLastSeen(device.deviceId, detail);
      if (reportedAt) lastReportedAt = new Date(reportedAt);

      const staleness = lastReportedAt ? Date.now() - lastReportedAt.getTime() : 0;
      if (hasGateway && staleness > STALE_THRESHOLD_MS) {
        newStatus = 'offline';
        lastError = `No status update from the lock in over ${Math.round(staleness / 60000)} minutes — it may be out of gateway range or have a dead battery.`;
      } else {
        newStatus = 'online';
      }
    } catch (error) {
      newStatus = 'error';
      lastError = error.response?.data?.errmsg || error.message;
    }

    device.connectionStatus = newStatus;
    device.lastError = lastError;
    device.lastCheckedAt = new Date();
    device.batteryLevel = battery;
    device.hasGateway = hasGateway;
    device.lastReportedAt = lastReportedAt;
    await device.save();

    // Only alert on a live regression (was online, now isn't) — not on devices that
    // have simply never been checked yet, which would flood admins on first boot.
    await notifyStatusTransition(device, previousStatus, newStatus, lastError, '/admin/ttlock');

    // Skip the battery check when we just flagged the device as stale/offline — that reading
    // is frozen last-known-good data, not a current measurement, so alerting on it would be
    // reporting a number we no longer trust.
    if (newStatus === 'online') {
      await notifyBatteryCrossing(device, previousBattery, battery, '/admin/ttlock');
    }
  }
}

// Tuya's own getDeviceDetail already reports a live `online` flag straight from their cloud —
// unlike TTLock's /lock/detail (which keeps returning the lock's last cached report forever,
// even once it's gone dark), there's no separate staleness math needed here; a failed or
// offline response IS the current signal. Covers the gateway the same as any sensor — nothing
// here is gateway-specific.
export async function checkTuyaDevices(filter = {}) {
  const devices = await SmartLockDevice.find({ provider: 'tuya', ...filter }).populate('hotelId', 'name');
  // Gateways first, so a sensor can tell whether the gateway it sits behind is the reason it is
  // offline (see `quiet` below).
  devices.sort((a, b) => Number(b.isGateway) - Number(a.isGateway));
  const gatewayStates = new Map();

  for (const device of devices) {
    const previousStatus = device.connectionStatus;
    let newStatus;
    let lastError = null;

    try {
      const detail = await tuyaService.getDeviceDetail(device.deviceId);
      newStatus = detail.online ? 'online' : 'offline';
      if (!detail.online) {
        lastError = device.batteryState === 'low'
          ? 'Device is offline. Its battery was reported low, so it may have run out.'
          : 'Device is registered but currently offline.';
      }
    } catch (error) {
      newStatus = 'error';
      lastError = error.message;
    }

    // Battery: Tuya sensors report either a percentage or only a coarse state ('low'), depending
    // on the model. A gateway is mains-powered and has no battery to read.
    const previousBattery = device.batteryLevel;
    const previousBatteryState = device.batteryState;
    let battery = previousBattery;
    let batteryState = previousBatteryState;
    if (newStatus === 'online' && !device.isGateway) {
      try {
        const points = await tuyaService.getDeviceStatus(device.deviceId);
        const percentage = points.find(point => point.code === 'battery_percentage')?.value;
        const state = points.find(point => point.code === 'battery_state')?.value;
        if (typeof percentage === 'number') battery = percentage;
        if (typeof state === 'string') batteryState = state;
      } catch (error) {
        console.error(`Tuya battery read failed for ${device.deviceName}:`, error.message);
      }
    }

    device.connectionStatus = newStatus;
    device.lastError = lastError;
    device.lastCheckedAt = new Date();
    device.batteryLevel = battery;
    device.batteryState = batteryState;
    await device.save();

    let quiet = false;
    if (device.isGateway) {
      gatewayStates.set(device.deviceId, { previous: previousStatus, current: newStatus });
    } else if (device.gatewayDeviceId && gatewayStates.has(device.gatewayDeviceId)) {
      const gateway = gatewayStates.get(device.gatewayDeviceId);
      const gatewayDown = gateway.current !== 'online';
      const gatewayJustRecovered = gateway.previous !== 'online' && gateway.current === 'online';
      quiet = (newStatus !== 'online' && gatewayDown) || (newStatus === 'online' && gatewayJustRecovered);
    }

    await notifyStatusTransition(device, previousStatus, newStatus, lastError, '/admin/tuya', { quiet });

    if (newStatus === 'online' && !device.isGateway) {
      if (typeof battery === 'number' && battery !== previousBattery) {
        await notifyBatteryCrossing(device, previousBattery, battery, '/admin/tuya');
      } else if (batteryState === 'low' && previousBatteryState !== 'low') {
        await notifyDeviceAlert(device, {
          title: 'Low battery',
          message: `${device.deviceName} (${locationLabel(device)}) reports a low battery. Replace the battery soon.`,
          adminLink: '/admin/tuya'
        });
      }
    }
  }
}

let timer = null;

export function startDeviceMonitor() {
  if (timer) return;
  const runChecks = () => {
    checkDevices().catch(error => console.error('Device monitor error (ttlock):', error.message));
    checkTuyaDevices().catch(error => console.error('Device monitor error (tuya):', error.message));
  };
  setTimeout(runChecks, 15000);
  timer = setInterval(runChecks, POLL_INTERVAL_MS);
}

export function stopDeviceMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
}

import SmartLockDevice from '../models/SmartLockDevice.js';
import User from '../models/User.js';
import ttlockService from '../services/ttlockService.js';
import { sendToRole } from '../utils/sseHub.js';
import { createNotification } from '../utils/notificationUtils.js';

// Same fan-out pattern as supportController.js's notifyAllAdmins — sendToRole above only
// reaches an admin who happens to have the dashboard open at that exact moment; this is
// what makes the alert still visible later in the notification bell if nobody was looking
// at 3am when a lock actually went dark.
async function notifyAllAdmins({ title, message, link, actionLabel }) {
  const admins = await User.find({ role: 'admin' }).select('_id');
  await Promise.all(admins.map(admin => createNotification({
    userId: admin._id,
    type: 'alert',
    title,
    message,
    link,
    actionLabel
  })));
}

const POLL_INTERVAL_MS = Number(process.env.DEVICE_MONITOR_INTERVAL_MS) || 2 * 60 * 1000;
const LOW_BATTERY_THRESHOLD = Number(process.env.DEVICE_LOW_BATTERY_THRESHOLD) || 20;
// TTLock's /lock/detail never errors just because a lock has gone dark (dead battery, out
// of gateway range) — it keeps successfully returning the last report the lock ever sent.
// So "the API call succeeded" alone can't detect that; only gateway-connected locks report
// in on their own on any real cadence, so staleness of lockUpdateDate/electricQuantityUpdateDate
// is the actual offline signal, and only meaningful for those (a Bluetooth-only lock only ever
// reports when a phone happens to sync with it, so "hasn't reported in an hour" is normal there,
// not a fault).
const STALE_THRESHOLD_MS = Number(process.env.DEVICE_STALE_THRESHOLD_MS) || 15 * 60 * 1000;

// TTLock-only: Tuya's getDeviceDetail has no battery field, and this job exists
// specifically to catch a lock dying or going dark between admin visits — without
// this, connectionStatus/batteryLevel only ever update when someone clicks "Test".
async function checkDevices() {
  const devices = await SmartLockDevice.find({ provider: 'ttlock' }).populate('hotelId', 'name');

  for (const device of devices) {
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

      const reportedAt = Math.max(detail.lockUpdateDate || 0, detail.electricQuantityUpdateDate || 0);
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
    if (previousStatus === 'online' && newStatus !== 'online') {
      const location = device.hotelId?.name ? `${device.hotelId.name} — Room ${device.roomNumber}` : 'Unassigned';
      sendToRole('admin', 'device-offline', {
        deviceId: String(device._id),
        deviceName: device.deviceName,
        hotelName: device.hotelId?.name || null,
        roomNumber: device.roomNumber,
        lastError
      });
      await notifyAllAdmins({
        title: 'Device offline',
        message: `${device.deviceName} (${location}) went offline${lastError ? ': ' + lastError : '.'}`,
        link: '/admin/ttlock',
        actionLabel: 'View Device'
      });
    }

    // The reverse transition — without this, a page already open when a device recovers
    // (battery put back, back in gateway range) has no way to learn that and keeps showing
    // stale "offline" until someone manually reloads or hits Test.
    if (previousStatus !== 'online' && previousStatus !== 'unknown' && newStatus === 'online') {
      const location = device.hotelId?.name ? `${device.hotelId.name} — Room ${device.roomNumber}` : 'Unassigned';
      sendToRole('admin', 'device-online', {
        deviceId: String(device._id),
        deviceName: device.deviceName,
        hotelName: device.hotelId?.name || null,
        roomNumber: device.roomNumber
      });
      await notifyAllAdmins({
        title: 'Device back online',
        message: `${device.deviceName} (${location}) is reporting again.`,
        link: '/admin/ttlock',
        actionLabel: 'View Device'
      });
    }

    // Skip the battery check when we just flagged the device as stale/offline — that reading
    // is frozen last-known-good data, not a current measurement, so alerting on it would be
    // reporting a number we no longer trust.
    const crossedLowBattery = newStatus === 'online' && battery !== null && battery <= LOW_BATTERY_THRESHOLD &&
      (previousBattery === null || previousBattery > LOW_BATTERY_THRESHOLD);
    if (crossedLowBattery) {
      const location = device.hotelId?.name ? `${device.hotelId.name} — Room ${device.roomNumber}` : 'Unassigned';
      sendToRole('admin', 'device-low-battery', {
        deviceId: String(device._id),
        deviceName: device.deviceName,
        hotelName: device.hotelId?.name || null,
        roomNumber: device.roomNumber,
        batteryLevel: battery
      });
      await notifyAllAdmins({
        title: 'Low battery',
        message: `${device.deviceName} (${location}) battery at ${battery}%.`,
        link: '/admin/ttlock',
        actionLabel: 'View Device'
      });
    }
  }
}

let timer = null;

export function startDeviceMonitor() {
  if (timer) return;
  setTimeout(() => {
    checkDevices().catch(error => console.error('Device monitor error:', error.message));
  }, 15000);
  timer = setInterval(() => {
    checkDevices().catch(error => console.error('Device monitor error:', error.message));
  }, POLL_INTERVAL_MS);
}

export function stopDeviceMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
}

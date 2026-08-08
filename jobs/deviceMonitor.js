import SmartLockDevice from '../models/SmartLockDevice.js';
import ttlockService from '../services/ttlockService.js';
import { sendToRole } from '../utils/sseHub.js';

const POLL_INTERVAL_MS = Number(process.env.DEVICE_MONITOR_INTERVAL_MS) || 10 * 60 * 1000;
const LOW_BATTERY_THRESHOLD = Number(process.env.DEVICE_LOW_BATTERY_THRESHOLD) || 20;

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

    try {
      const detail = await ttlockService.getLockDetail(device.deviceId);
      newStatus = 'online';
      if (typeof detail.electricQuantity === 'number') battery = detail.electricQuantity;
    } catch (error) {
      newStatus = 'error';
      lastError = error.response?.data?.errmsg || error.message;
    }

    device.connectionStatus = newStatus;
    device.lastError = lastError;
    device.lastCheckedAt = new Date();
    device.batteryLevel = battery;
    await device.save();

    // Only alert on a live regression (was online, now isn't) — not on devices that
    // have simply never been checked yet, which would flood admins on first boot.
    if (previousStatus === 'online' && newStatus !== 'online') {
      sendToRole('admin', 'device-offline', {
        deviceId: String(device._id),
        deviceName: device.deviceName,
        hotelName: device.hotelId?.name || null,
        roomNumber: device.roomNumber,
        lastError
      });
    }

    // Only alert on the downward crossing, not every poll while it stays low.
    const crossedLowBattery = battery !== null && battery <= LOW_BATTERY_THRESHOLD &&
      (previousBattery === null || previousBattery > LOW_BATTERY_THRESHOLD);
    if (crossedLowBattery) {
      sendToRole('admin', 'device-low-battery', {
        deviceId: String(device._id),
        deviceName: device.deviceName,
        hotelName: device.hotelId?.name || null,
        roomNumber: device.roomNumber,
        batteryLevel: battery
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

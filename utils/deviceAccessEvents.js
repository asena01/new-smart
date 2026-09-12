import DeviceAccessEvent from '../models/DeviceAccessEvent.js';
import User from '../models/User.js';
import Staff from '../models/Staff.js';

// Resolves a display name for whoever's about to trigger a lock/unlock, from the same
// req.user (just {userId, role} — see middleware/auth.js) the route's own auth check already
// used. Best-effort: a lookup failure here must never block the actual lock/unlock command.
export async function resolveActorName(req) {
  try {
    if (req.user.role === 'staff') {
      const staff = await Staff.findOne({ userId: req.user.userId, status: 'active' }).select('firstName lastName');
      if (staff) return `${staff.firstName} ${staff.lastName}`;
    }
    const user = await User.findById(req.user.userId).select('firstName lastName');
    if (user) return `${user.firstName} ${user.lastName}`;
  } catch (error) {
    console.error('Error resolving actor name for device access event:', error.message);
  }
  return null;
}

// Fire-and-forget: called after a remote lock/unlock has already succeeded, so a failure
// here (a bad lookup, a transient DB hiccup) must never surface as an error on an action that
// already completed for real on the lock.
export async function recordDeviceAccessEvent({ deviceId, action, actorRole, actorName, bookingId = null }) {
  if (!actorName) return;
  try {
    await DeviceAccessEvent.create({ deviceId, action, actorRole, actorName, bookingId });
  } catch (error) {
    console.error('Error recording device access event:', error.message);
  }
}

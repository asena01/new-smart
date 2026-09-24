import Notification from '../models/Notification.js';
import { sendToUser } from './sseHub.js';
import { sendPushToUser } from './pushNotifications.js';

// Best-effort: a notification failing to save should never break the action that triggered it.
export async function createNotification({ userId, type, title, message, link, actionLabel }) {
  if (!userId) return;
  try {
    const notification = await Notification.create({ userId, type, title, message, link, actionLabel });
    sendToUser(userId, 'notification-new', notification);
    // SSE (above) only reaches a client that's currently connected, which for the mobile app
    // means the app has to be open — this is the one path that also reaches a backgrounded or
    // fully killed app, via a real OS push. No-ops until a Firebase project is configured (see
    // pushNotifications.js), and never allowed to affect whether the in-app notification saved.
    await sendPushToUser(userId, { title, body: message, data: { notificationId: String(notification._id), type, link: link || '' } });
  } catch (error) {
    console.error('Error creating notification:', error);
  }
}

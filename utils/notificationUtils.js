import Notification from '../models/Notification.js';
import { sendToUser } from './sseHub.js';

// Best-effort: a notification failing to save should never break the action that triggered it.
export async function createNotification({ userId, type, title, message, link, actionLabel }) {
  if (!userId) return;
  try {
    const notification = await Notification.create({ userId, type, title, message, link, actionLabel });
    sendToUser(userId, 'notification-new', notification);
  } catch (error) {
    console.error('Error creating notification:', error);
  }
}

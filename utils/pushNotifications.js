import admin from 'firebase-admin';
import User from '../models/User.js';

// Lazily initialized so a deploy with no Firebase project configured yet doesn't crash on
// startup — every function below just no-ops (with a log) until FIREBASE_SERVICE_ACCOUNT_JSON
// is set. That env var holds the *entire* service account JSON (Firebase console -> Project
// Settings -> Service Accounts -> Generate new private key) as a single-line string, not a
// file path — this backend runs on Render, where committing that file to the repo would
// expose it in the deployed source.
let app = null;
let initAttempted = false;

function getApp() {
  if (initAttempted) return app;
  initAttempted = true;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    console.log('Push notifications: FIREBASE_SERVICE_ACCOUNT_JSON not set — push disabled, SSE-only.');
    return null;
  }
  try {
    const serviceAccount = JSON.parse(raw);
    app = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    return app;
  } catch (error) {
    console.error('Push notifications: failed to initialize firebase-admin:', error.message);
    return null;
  }
}

// Every value in `data` must be a string — FCM's data-payload requirement, not an admin SDK
// quirk, so callers get a clear error here instead of a confusing rejection from Google's API.
export async function sendPushToUser(userId, { title, body, data } = {}) {
  const firebaseApp = getApp();
  if (!firebaseApp || !userId) return;

  try {
    const user = await User.findById(userId).select('pushTokens');
    const tokens = (user?.pushTokens || []).map(t => t.token);
    if (tokens.length === 0) return;

    const response = await admin.messaging(firebaseApp).sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
    });

    // A token stops being valid when the app is uninstalled, the OS revokes it, etc. — FCM
    // reports that per-token rather than failing the whole batch, so prune only the dead ones
    // instead of leaving them to fail (silently, forever) on every future notification.
    const deadTokens = response.responses
      .map((result, index) => (!result.success && result.error?.code === 'messaging/registration-token-not-registered' ? tokens[index] : null))
      .filter(Boolean);
    if (deadTokens.length > 0) {
      await User.updateOne({ _id: userId }, { $pull: { pushTokens: { token: { $in: deadTokens } } } });
    }
  } catch (error) {
    console.error('Push notification send failed:', error.message);
  }
}

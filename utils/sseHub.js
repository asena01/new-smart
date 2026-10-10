// Shared SSE connection registry for live app events (orders, notifications, chat
// pings) — separate from chatController's own per-booking SSE registry, since this
// one is keyed by userId/hotelId for the whole session rather than one booking.
const connections = new Map();

export function addConnection(res, meta) {
  const connectionId = `${meta.userId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  connections.set(connectionId, { res, ...meta });
  return connectionId;
}

export function removeConnection(connectionId) {
  connections.delete(connectionId);
}

function write(res, eventType, data) {
  try {
    res.write(`data: ${JSON.stringify({ type: eventType, data })}\n\n`);
  } catch (error) {
    // Connection is already gone; req.on('close') will clean up the registry entry.
  }
}

export function sendToUser(userId, eventType, data) {
  if (!userId) return;
  connections.forEach(conn => {
    if (String(conn.userId) === String(userId)) write(conn.res, eventType, data);
  });
}

export function sendToHotel(hotelId, eventType, data) {
  if (!hotelId) return;
  connections.forEach(conn => {
    if (conn.hotelId && String(conn.hotelId) === String(hotelId)) write(conn.res, eventType, data);
  });
}

export function sendToRole(role, eventType, data) {
  if (!role) return;
  connections.forEach(conn => {
    if (conn.role === role) write(conn.res, eventType, data);
  });
}

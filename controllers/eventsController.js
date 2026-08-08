import jwt from 'jsonwebtoken';
import Hotel from '../models/Hotel.js';
import { addConnection, removeConnection } from '../utils/sseHub.js';

// Single long-lived SSE stream per logged-in session, replacing per-page polling for
// orders/notifications. EventSource can't set an Authorization header, so — same as
// chat's stream endpoint — the token travels as a query param and is verified manually
// instead of going through the `protect` middleware.
export const streamEvents = async (req, res) => {
  const { token } = req.query;

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ error: 'Not authorized to access this stream' });
  }

  let hotelId = null;
  if (decoded.role === 'host') {
    const hotel = await Hotel.findOne({ hostId: decoded.userId }).select('_id');
    hotelId = hotel?._id || null;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const connectionId = addConnection(res, { userId: decoded.userId, role: decoded.role, hotelId });

  res.write('data: {"type":"connected"}\n\n');

  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch (error) {
      clearInterval(keepAlive);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
    removeConnection(connectionId);
    res.end();
  });
};

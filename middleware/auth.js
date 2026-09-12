import jwt from 'jsonwebtoken';
import User from '../models/User.js';

// JWTs here are otherwise stateless and last up to 7 days (see tokenUtils.js) — without this
// lookup, suspending an account (see adminController.js's updateUserStatus) would only block
// their *next* login, leaving an already-issued token fully usable for the rest of its life.
// A single indexed findById per request is the cost of making suspension actually immediate.
export const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized to access this route' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.userId).select('status');
    if (!user) {
      return res.status(401).json({ message: 'Not authorized to access this route' });
    }
    if (user.status === 'suspended') {
      return res.status(403).json({ message: 'This account has been suspended. Contact platform support for help.' });
    }

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Not authorized to access this route' });
  }
};

export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'User role not authorized to access this route' });
    }
    next();
  };
};

import crypto from 'crypto';
import User from '../models/User.js';
import { sendTokenResponse } from '../utils/tokenUtils.js';
import { sendPasswordResetCodeEmail } from '../utils/emailUtils.js';

export const register = async (req, res) => {
  try {
    const { firstName, lastName, email, password, phone, role = 'guest' } = req.body;

    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({ message: 'Please provide all required fields' });
    }

    if (!['guest', 'host', 'admin'].includes(role)) {
      return res.status(400).json({ message: 'Invalid account role' });
    }

    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    user = await User.create({
      firstName,
      lastName,
      email,
      password,
      phone,
      role,
    });

    sendTokenResponse(user, 201, res);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Please provide email and password' });
    }

    const user = await User.findOne({ email }).select('+password');

    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ message: 'This account has been suspended. Contact platform support for help.' });
    }

    sendTokenResponse(user, 200, res);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    // A valid, decodable token whose user no longer exists (deleted account, stale
    // token from a wiped test DB, etc.) must fail loudly here — silently returning
    // 200 {user: null} leaves the frontend's session-restore logic (AuthService.checkAuth)
    // unable to tell "no session" apart from "logged in with nothing to show", which is
    // exactly the ambiguity that let a stuck half-logged-in state slip through before.
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.status(200).json({ success: true, user });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateProfile = async (req, res) => {
  try {
    const { firstName, lastName, phone, profileImage } = req.body;

    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { firstName, lastName, phone, profileImage, updatedAt: Date.now() },
      { new: true, runValidators: true }
    );

    res.status(200).json({ success: true, user });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Returns plain hotel ID strings, not populated Hotel docs — the only place this is
// currently consumed (hotel-detail.ts) only needs to check membership for the one hotel
// it's showing, so there's no reason to pay for a populate on every check.
export const getWishlist = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('wishlist');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.status(200).json({ success: true, wishlist: user.wishlist.map(id => id.toString()) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const addToWishlist = async (req, res) => {
  try {
    const { hotelId } = req.params;
    // $addToSet, not $push — repeated saves of the same hotel (double-click, refresh-then-
    // retry) must not duplicate the entry.
    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { $addToSet: { wishlist: hotelId } },
      { new: true }
    ).select('wishlist');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.status(200).json({ success: true, wishlist: user.wishlist.map(id => id.toString()) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const removeFromWishlist = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { $pull: { wishlist: hotelId } },
      { new: true }
    ).select('wishlist');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.status(200).json({ success: true, wishlist: user.wishlist.map(id => id.toString()) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Please provide your current and new password' });
    }
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      return res.status(400).json({ message: 'New password must be at least 8 characters and include a letter and a number' });
    }

    const user = await User.findById(req.user.userId).select('+password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    user.password = newPassword;
    user.updatedAt = Date.now();
    await user.save();

    res.status(200).json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Registers (or refreshes) this device's push token so createNotification can reach it via
// Firebase Cloud Messaging even while the mobile app is backgrounded or killed — see
// utils/pushNotifications.js. $pull-then-$push (not a plain upsert) so re-registering the same
// token twice (a token doesn't change on every app open) can't create a duplicate array entry.
export const registerDeviceToken = async (req, res) => {
  try {
    const { token, platform } = req.body;
    if (!token || !['ios', 'android'].includes(platform)) {
      return res.status(400).json({ message: 'token and platform ("ios" or "android") are required' });
    }

    await User.updateOne({ _id: req.user.userId }, { $pull: { pushTokens: { token } } });
    await User.updateOne(
      { _id: req.user.userId },
      { $push: { pushTokens: { token, platform, addedAt: new Date() } } }
    );

    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Called on logout — without this, a device that signed out would keep receiving push
// notifications meant for whichever account is signed in on it next.
export const unregisterDeviceToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ message: 'token is required' });
    }

    await User.updateOne({ _id: req.user.userId }, { $pull: { pushTokens: { token } } });
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Self-service account deletion (required by App Store guideline 5.1.1(v) for any app that
// lets people register). The User document is scrubbed rather than removed: Bookings,
// ServiceOrders, Reviews etc. reference it by id and hotels must keep those records, so a hard
// delete would leave dangling refs all over the host dashboards. Every personal field is wiped,
// the email is replaced with an unroutable placeholder (so the address can register again), and
// status 'deleted' makes protect() reject any token still in circulation.
export const deleteAccount = async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ message: 'Please enter your password to confirm' });
    }

    const user = await User.findById(req.user.userId).select('+password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Staff accounts are created and owned by a hotel, and host/admin accounts own hotels —
    // only self-registered guest accounts can be deleted from the app.
    if (user.role !== 'guest') {
      return res.status(403).json({ message: 'Please contact your hotel administrator or support@finsmarthotels.com to delete this account.' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Password is incorrect' });
    }

    user.firstName = 'Deleted';
    user.lastName = 'User';
    user.email = `deleted-${user._id}@deleted.invalid`;
    user.phone = undefined;
    user.profileImage = null;
    user.identityVerificationData = undefined;
    user.wishlist = [];
    user.pushTokens = [];
    user.password = crypto.randomBytes(32).toString('hex');
    user.status = 'deleted';
    user.updatedAt = Date.now();
    await user.save();

    res.status(200).json({ success: true, message: 'Your account has been deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const RESET_CODE_TTL_MS = 15 * 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;
const hashResetCode = code => crypto.createHash('sha256').update(code).digest('hex');

// Always answers with the same generic message whether or not the email is registered, so
// this endpoint can't be used to discover which addresses have accounts.
export const forgotPassword = async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: 'Please provide your email address' });
    }

    const genericResponse = { success: true, message: 'If an account exists for that email, a reset code has been sent.' };

    const user = await User.findOne({ email });
    if (!user || user.status !== 'active') {
      return res.status(200).json(genericResponse);
    }

    const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
    user.passwordReset = {
      codeHash: hashResetCode(code),
      expiresAt: new Date(Date.now() + RESET_CODE_TTL_MS),
      attempts: 0,
    };
    await user.save();

    try {
      await sendPasswordResetCodeEmail(user.email, { firstName: user.firstName, code });
    } catch (error) {
      console.error('❌ Error sending password reset email:', error.response?.data?.message || error.message);
    }

    res.status(200).json(genericResponse);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const resetPassword = async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const code = (req.body.code || '').trim();
    const { newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({ message: 'Please provide your email, the reset code, and a new password' });
    }
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      return res.status(400).json({ message: 'New password must be at least 8 characters and include a letter and a number' });
    }

    const invalid = () => res.status(400).json({ message: 'Invalid or expired reset code' });

    const user = await User.findOne({ email }).select('+passwordReset.codeHash +passwordReset.expiresAt +passwordReset.attempts');
    if (!user || user.status !== 'active' || !user.passwordReset?.codeHash) {
      return invalid();
    }

    if (user.passwordReset.expiresAt < new Date() || user.passwordReset.attempts >= RESET_MAX_ATTEMPTS) {
      user.passwordReset = undefined;
      await user.save();
      return invalid();
    }

    const expected = Buffer.from(user.passwordReset.codeHash, 'hex');
    const actual = Buffer.from(hashResetCode(code), 'hex');
    if (!crypto.timingSafeEqual(expected, actual)) {
      user.passwordReset.attempts += 1;
      await user.save();
      return invalid();
    }

    user.password = newPassword;
    user.passwordReset = undefined;
    user.updatedAt = Date.now();
    await user.save();

    res.status(200).json({ success: true, message: 'Your password has been reset. You can now sign in.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

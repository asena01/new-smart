import User from '../models/User.js';
import { sendTokenResponse } from '../utils/tokenUtils.js';

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

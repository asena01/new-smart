import express from 'express';
import { register, login, getProfile, updateProfile, changePassword, getWishlist, addToWishlist, removeFromWishlist, registerDeviceToken, unregisterDeviceToken, deleteAccount, forgotPassword, resetPassword } from '../controllers/authController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.get('/profile', protect, getProfile);
router.put('/profile', protect, updateProfile);
router.put('/change-password', protect, changePassword);
router.delete('/account', protect, deleteAccount);
router.get('/wishlist', protect, getWishlist);
router.post('/wishlist/:hotelId', protect, addToWishlist);
router.delete('/wishlist/:hotelId', protect, removeFromWishlist);
router.post('/device-tokens', protect, registerDeviceToken);
router.delete('/device-tokens', protect, unregisterDeviceToken);

export default router;

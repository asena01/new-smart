import express from 'express';
import { uploadImages } from '../controllers/uploadController.js';
import { protect, authorize } from '../middleware/auth.js';
import { upload } from '../middleware/upload.js';

const router = express.Router();

router.post('/images', protect, authorize('host', 'admin'), upload.array('images', 8), uploadImages);

export default router;

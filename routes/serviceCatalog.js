import express from 'express';
import * as catalogController from '../controllers/serviceCatalogController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.post('/hotel/:hotelId/items', protect, catalogController.createItem);
router.get('/hotel/:hotelId/items', protect, catalogController.getHotelCatalog);
router.patch('/items/:itemId', protect, catalogController.updateItem);
router.delete('/items/:itemId', protect, catalogController.deleteItem);

export default router;

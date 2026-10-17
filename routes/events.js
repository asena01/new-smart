import express from 'express';
import { streamEvents } from '../controllers/eventsController.js';

const router = express.Router();

router.get('/stream', streamEvents);

export default router;

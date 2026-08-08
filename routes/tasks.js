import express from 'express';
import * as taskController from '../controllers/taskController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// Host: assign and manage tasks
router.post('/hotel/:hotelId/tasks', protect, taskController.createTask);
router.get('/hotel/:hotelId/tasks', protect, taskController.getHotelTasks);
router.patch('/:taskId', protect, taskController.updateTask);
router.delete('/:taskId', protect, taskController.deleteTask);

// Shared: update task status (host or assigned staff)
router.patch('/:taskId/status', protect, taskController.updateTaskStatus);

// Staff: view own tasks
router.get('/my-tasks', protect, taskController.getMyTasks);

export default router;

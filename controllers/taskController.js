import Task from '../models/Task.js';
import Staff from '../models/Staff.js';
import Hotel from '../models/Hotel.js';
import { createNotification } from '../utils/notificationUtils.js';

// Create and assign a task to a staff member
export const createTask = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { staffId, title, description, assignedRooms, priority, dueDate } = req.body;

    if (!staffId || !title) {
      return res.status(400).json({ error: 'staffId and title are required' });
    }

    const hotel = await Hotel.findById(hotelId);
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    const staff = await Staff.findOne({ _id: staffId, hotelId });
    if (!staff) {
      return res.status(404).json({ error: 'Staff member not found at this hotel' });
    }

    const task = new Task({
      hotelId,
      staffId,
      assignedBy: req.user.userId,
      title,
      description,
      assignedRooms,
      priority,
      dueDate
    });

    await task.save();

    // No-ops if the staff member hasn't accepted their invite yet (no linked account).
    await createNotification({
      userId: staff.userId,
      type: 'service',
      title: 'New Task Assigned',
      message: `You've been assigned: ${title}`,
      link: '/staff/tasks',
      actionLabel: 'View Task'
    });

    res.status(201).json({
      message: 'Task assigned successfully',
      task
    });
  } catch (error) {
    console.error('Error creating task:', error);
    res.status(500).json({ error: 'Failed to create task' });
  }
};

// Get all tasks for a hotel (host view)
export const getHotelTasks = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { staffId, status, priority } = req.query;

    const filter = { hotelId };
    if (staffId) filter.staffId = staffId;
    if (status) filter.status = status;
    if (priority) filter.priority = priority;

    const tasks = await Task.find(filter)
      .populate('staffId', 'firstName lastName position')
      .sort({ dueDate: 1, createdAt: -1 });

    res.json(tasks);
  } catch (error) {
    console.error('Error fetching hotel tasks:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
};

// Get the logged-in staff user's own tasks
export const getMyTasks = async (req, res) => {
  try {
    const staff = await Staff.findOne({ userId: req.user.userId });
    if (!staff) {
      return res.status(404).json({ error: 'Staff profile not found' });
    }

    const { status } = req.query;
    const filter = { staffId: staff._id };
    if (status) filter.status = status;

    const tasks = await Task.find(filter).sort({ dueDate: 1, createdAt: -1 });

    res.json(tasks);
  } catch (error) {
    console.error('Error fetching my tasks:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
};

// Update task status
export const updateTaskStatus = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { status } = req.body;

    if (!['pending', 'in-progress', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const task = await Task.findByIdAndUpdate(
      taskId,
      {
        status,
        completedAt: status === 'completed' ? new Date() : undefined
      },
      { new: true }
    );

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json({
      message: 'Task status updated',
      task
    });
  } catch (error) {
    console.error('Error updating task status:', error);
    res.status(500).json({ error: 'Failed to update task status' });
  }
};

// Update task details
export const updateTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { title, description, assignedRooms, priority, dueDate, staffId } = req.body;

    const task = await Task.findByIdAndUpdate(
      taskId,
      { title, description, assignedRooms, priority, dueDate, staffId },
      { new: true, runValidators: true }
    );

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json({
      message: 'Task updated successfully',
      task
    });
  } catch (error) {
    console.error('Error updating task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
};

// Delete a task
export const deleteTask = async (req, res) => {
  try {
    const { taskId } = req.params;

    const task = await Task.findByIdAndDelete(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json({ message: 'Task deleted successfully' });
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({ error: 'Failed to delete task' });
  }
};

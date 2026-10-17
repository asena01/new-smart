import Task from '../models/Task.js';
import Staff from '../models/Staff.js';
import Hotel from '../models/Hotel.js';
import { createNotification } from '../utils/notificationUtils.js';
import { canManageHotel } from '../utils/staffAuth.js';
import { setRoomHousekeepingStatus } from './hotelController.js';
import { sendToHotel } from '../utils/sseHub.js';

// Create and assign a task to a staff member
export const createTask = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { staffId, title, description, assignedRooms, priority, dueDate, category } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }

    const hotel = await Hotel.findById(hotelId);
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    if (!(await canManageHotel(req, hotelId, 'canManageTasks'))) {
      return res.status(403).json({ error: 'Not authorized to assign tasks at this hotel' });
    }

    // Leaving staffId blank creates an unassigned, claimable task instead of assigning
    // one directly — see taskController.claimTask.
    let staff = null;
    if (staffId) {
      staff = await Staff.findOne({ _id: staffId, hotelId, status: 'active' });
      if (!staff) {
        return res.status(404).json({ error: 'Active staff member not found at this hotel' });
      }
    }

    const task = new Task({
      hotelId,
      staffId: staff?._id || null,
      assignedBy: req.user.userId,
      title,
      description,
      assignedRooms,
      priority,
      dueDate,
      category
    });

    await task.save();

    sendToHotel(hotelId, 'task-updated', { taskId: task._id, status: task.status, category: task.category, staffId: task.staffId });

    if (staff) {
      // No-ops if the staff member hasn't accepted their invite yet (no linked account).
      await createNotification({
        userId: staff.userId,
        type: 'service',
        title: 'New Task Assigned',
        message: `You've been assigned: ${title}`,
        link: '/staff/tasks',
        actionLabel: 'View Task'
      });
    }

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

    if (!(await canManageHotel(req, hotelId, 'canManageTasks'))) {
      return res.status(403).json({ error: 'Not authorized to view this hotel\'s tasks' });
    }

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
    const staff = await Staff.findOne({ userId: req.user.userId, status: 'active' });
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

// A task's `category` decides which staff can actually claim it — 'cleaning' needs
// canClaimHousekeepingTasks, 'maintenance' needs canClaimMaintenanceTasks. 'general' (or any
// other/missing category) has no dedicated permission and stays open to anyone with the base
// canAccessRooms claim-queue gate, same as every category used to be before this existed —
// a maintenance worker claiming a cleaning task (and vice versa) isn't a smart-routing
// decision, it's just the wrong trade doing another trade's work.
const TASK_CATEGORY_PERMISSION = {
  cleaning: 'canClaimHousekeepingTasks',
  maintenance: 'canClaimMaintenanceTasks'
};

function canClaimTaskCategory(staff, category) {
  if (!staff.permissions?.canAccessRooms) return false;
  const permissionKey = TASK_CATEGORY_PERMISSION[category];
  return !permissionKey || !!staff.permissions[permissionKey];
}

// Unassigned, claimable tasks at a hotel — open to any active staff member there whose
// permissions actually cover the task's own category (see canClaimTaskCategory above).
export const getClaimableTasks = async (req, res) => {
  try {
    const { hotelId } = req.params;

    const staff = await Staff.findOne({ userId: req.user.userId, hotelId, status: 'active' });
    if (req.user.role !== 'admin' && !staff) {
      return res.status(403).json({ error: 'Not an active staff member at this hotel' });
    }

    const tasks = await Task.find({ hotelId, staffId: null, status: 'pending' })
      .sort({ priority: -1, dueDate: 1, createdAt: -1 });

    const visibleTasks = req.user.role === 'admin' ? tasks : tasks.filter(t => canClaimTaskCategory(staff, t.category));

    res.json(visibleTasks);
  } catch (error) {
    console.error('Error fetching claimable tasks:', error);
    res.status(500).json({ error: 'Failed to fetch claimable tasks' });
  }
};

// Self-service claim of an unassigned task. Same atomic compare-and-swap pattern as
// claimServiceOrder — the findOneAndUpdate filter only matches while staffId is still null,
// so a second concurrent claim gets a 409 instead of silently overwriting the first.
export const claimTask = async (req, res) => {
  try {
    const { taskId } = req.params;

    const existingTask = await Task.findById(taskId);
    if (!existingTask) {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (existingTask.staffId) {
      return res.status(400).json({ error: 'Task is already claimed' });
    }

    const staff = await Staff.findOne({ userId: req.user.userId, hotelId: existingTask.hotelId, status: 'active' });
    if (!staff) {
      return res.status(403).json({ error: 'Not an active staff member at this hotel' });
    }
    if (!canClaimTaskCategory(staff, existingTask.category)) {
      return res.status(403).json({ error: 'Not permitted to claim this task' });
    }

    const task = await Task.findOneAndUpdate(
      { _id: taskId, staffId: null },
      { staffId: staff._id, status: existingTask.status === 'pending' ? 'in-progress' : existingTask.status },
      { new: true }
    ).populate('staffId', 'firstName lastName position');

    if (!task) {
      return res.status(409).json({ error: 'This task was already claimed by someone else' });
    }

    // Anyone else looking at the claim queue needs this to disappear immediately — otherwise a
    // second staff member can attempt to claim an already-claimed task and hit a stale 409.
    sendToHotel(task.hotelId, 'task-updated', { taskId: task._id, status: task.status, category: task.category, staffId: task.staffId });

    res.json({ message: 'Task claimed', task });
  } catch (error) {
    console.error('Error claiming task:', error);
    res.status(500).json({ error: 'Failed to claim task' });
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

    const existingTask = await Task.findById(taskId);
    if (!existingTask) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // The assignee updating their own task's status is self-service and needs no
    // canManageTasks permission — anyone else (a manager/host) does. Requiring active
    // status here means a terminated staff member's still-valid token can no longer
    // touch a task just because it was assigned to them before termination.
    const assignedStaff = await Staff.findOne({ _id: existingTask.staffId, userId: req.user.userId, status: 'active' });
    const isAssignee = !!assignedStaff;
    if (!isAssignee && !(await canManageHotel(req, existingTask.hotelId, 'canManageTasks'))) {
      return res.status(403).json({ error: 'Not authorized to update this task' });
    }

    const task = await Task.findByIdAndUpdate(
      taskId,
      {
        status,
        completedAt: status === 'completed' ? new Date() : undefined
      },
      { new: true }
    );

    // Front Desk's room list reads housekeepingStatus, not Task completion — without this,
    // a room stayed shown as dirty/needs-cleaning forever after its cleaning task was
    // actually finished. Best-effort: a sync failure here shouldn't fail the task update
    // itself, since the task genuinely is done regardless. setRoomHousekeepingStatus already
    // broadcasts its own 'room-updated' event, so Front Desk updates live from this alone.
    if (status === 'completed' && task.category === 'cleaning' && task.assignedRooms?.length) {
      for (const roomNumber of task.assignedRooms) {
        try {
          await setRoomHousekeepingStatus(task.hotelId, roomNumber, 'clean');
        } catch (syncError) {
          console.error(`Error syncing cleaning task completion to room ${roomNumber} (non-fatal):`, syncError.message);
        }
      }
    }

    sendToHotel(task.hotelId, 'task-updated', { taskId: task._id, status: task.status, category: task.category, staffId: task.staffId });

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
    const { title, description, assignedRooms, priority, dueDate, staffId, category } = req.body;

    const existingTask = await Task.findById(taskId);
    if (!existingTask) {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (!(await canManageHotel(req, existingTask.hotelId, 'canManageTasks'))) {
      return res.status(403).json({ error: 'Not authorized to edit this task' });
    }

    // A truthy staffId here is a reassignment — validate it the same way createTask does.
    // staffId === null is a deliberate unassign (back to the open claim queue) and needs
    // no lookup; staffId === undefined (key omitted) leaves the existing assignment as-is.
    if (staffId) {
      const staff = await Staff.findOne({ _id: staffId, hotelId: existingTask.hotelId, status: 'active' });
      if (!staff) {
        return res.status(404).json({ error: 'Active staff member not found at this hotel' });
      }
    }

    const task = await Task.findByIdAndUpdate(
      taskId,
      { title, description, assignedRooms, priority, dueDate, staffId, category },
      { new: true, runValidators: true }
    );

    sendToHotel(task.hotelId, 'task-updated', { taskId: task._id, status: task.status, category: task.category, staffId: task.staffId });

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

    const existingTask = await Task.findById(taskId);
    if (!existingTask) {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (!(await canManageHotel(req, existingTask.hotelId, 'canManageTasks'))) {
      return res.status(403).json({ error: 'Not authorized to delete this task' });
    }

    await Task.findByIdAndDelete(taskId);

    res.json({ message: 'Task deleted successfully' });
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({ error: 'Failed to delete task' });
  }
};

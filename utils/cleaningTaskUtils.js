import Task from '../models/Task.js';
import Staff from '../models/Staff.js';
import Attendance from '../models/Attendance.js';
import { createNotification } from './notificationUtils.js';
import { sendToHotel } from './sseHub.js';

// Called from both the manual checkout path (bookingController.checkOutGuest) and the
// auto-checkout scheduler — creates one unassigned, claimable housekeeping Task per dirty
// room, then notifies clocked-in housekeeping staff it's available. Best-effort: a failure
// here must never break the checkout flow that triggered it.
export async function createCleaningTask(hotel, room) {
  try {
    const task = await Task.create({
      hotelId: hotel._id,
      staffId: null,
      title: `Clean Room ${room.roomNumber}`,
      description: 'Room marked dirty after checkout — ready for housekeeping.',
      assignedRooms: [room.roomNumber],
      priority: 'medium',
      status: 'pending',
      category: 'cleaning'
    });

    // The room going dirty and the claimable task appearing are the same checkout moment —
    // broadcast both so Front Desk's "needs cleaning" list and any open staff claim-queue page
    // update live, whether this ran from a receptionist's own click or the unattended
    // auto-checkout scheduler (which has no requesting session of its own to already reflect it).
    sendToHotel(hotel._id, 'room-updated', { roomNumber: room.roomNumber, housekeepingStatus: room.housekeepingStatus });
    sendToHotel(hotel._id, 'task-updated', { taskId: task._id, status: task.status, category: task.category, staffId: null });

    const housekeepingStaff = await Staff.find({ hotelId: hotel._id, position: 'housekeeping', status: 'active' });
    if (housekeepingStaff.length) {
      const clockedIn = await Attendance.find({ staffId: { $in: housekeepingStaff.map(s => s._id) }, clockOutTime: null });
      const clockedInIds = new Set(clockedIn.map(a => String(a.staffId)));
      const toNotify = housekeepingStaff.filter(s => clockedInIds.has(String(s._id)));
      for (const s of toNotify) {
        await createNotification({
          userId: s.userId,
          type: 'service',
          title: 'Room Ready for Cleaning',
          message: `Room ${room.roomNumber} needs cleaning.`,
          link: '/staff/open-tasks',
          actionLabel: 'View Queue'
        });
      }
    }

    return task;
  } catch (error) {
    console.error('Error creating cleaning task (non-fatal):', error.message);
    return null;
  }
}

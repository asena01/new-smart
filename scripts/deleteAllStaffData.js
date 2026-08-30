// One-off cleanup utility — NOT wired into the API. Run manually from your own machine:
//
//   node scripts/deleteAllStaffData.js
//   node scripts/deleteAllStaffData.js --confirm
//
// Without --confirm it only prints what it *would* delete (dry run). Pass --confirm
// to actually delete. Deletes staff across ALL hotels — there is no hotel scoping.
//
// Deletes:
//   - Every Staff document (every hotel)
//   - StaffSchedule / Task / Attendance / StaffRequest documents that reference one of those staff
//   - The linked User login account for each staff member who had accepted their invite
//     (only accounts with role: 'staff' are touched — a host/admin/guest account is never deleted
//     even if some stale data pointed a Staff.userId at one)
//
// Does NOT touch: ServiceOrder.staffId assignments (left as a dangling ref — populate will just
// return null, this doesn't break anything), Notification history, or the legacy/unused
// "smartaccessgrants" collection (no current model or code references it). TTLock key data lives
// directly on the Staff document (ttlockKeyId/ttlockKeyName/ttlockKeyStatus/etc.) so deleting the
// Staff document already removes it — there is no live TTLock device API call to make here, since
// the app's own revokeTTLockKey endpoint only ever flips a DB field, never calls out to a device.

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Staff from '../models/Staff.js';
import StaffSchedule from '../models/StaffSchedule.js';
import Task from '../models/Task.js';
import Attendance from '../models/Attendance.js';
import StaffRequest from '../models/StaffRequest.js';
import User from '../models/User.js';

dotenv.config();

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    args[key] = rest.length ? rest.join('=').replace(/^"|"$/g, '') : true;
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const confirm = Boolean(args.confirm);

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to: ${mongoose.connection.name}`);

  const staffList = await Staff.find().select('_id userId firstName lastName email hotelId');
  const staffIds = staffList.map(s => s._id);
  const staffUserIds = staffList.map(s => s.userId).filter(Boolean);

  const [scheduleCount, taskCount, attendanceCount, requestCount, userCount] = await Promise.all([
    StaffSchedule.countDocuments({ staffId: { $in: staffIds } }),
    Task.countDocuments({ staffId: { $in: staffIds } }),
    Attendance.countDocuments({ staffId: { $in: staffIds } }),
    StaffRequest.countDocuments({ staffId: { $in: staffIds } }),
    User.countDocuments({ _id: { $in: staffUserIds }, role: 'staff' })
  ]);

  console.log(`\nFound:`);
  console.log(`  ${staffIds.length} staff records (across all hotels)`);
  staffList.forEach(s => console.log(`    - ${s.firstName} ${s.lastName} <${s.email}> (hotel ${s.hotelId})`));
  console.log(`  ${scheduleCount} staff schedules`);
  console.log(`  ${taskCount} tasks assigned to staff`);
  console.log(`  ${attendanceCount} attendance records`);
  console.log(`  ${requestCount} staff requests (time-off/shift-change)`);
  console.log(`  ${userCount} linked staff login accounts (role: 'staff')`);

  if (!confirm) {
    console.log('\nDry run only — nothing deleted. Re-run with --confirm to actually delete.');
    await mongoose.disconnect();
    return;
  }

  const [scheduleResult, taskResult, attendanceResult, requestResult, userResult, staffResult] = await Promise.all([
    StaffSchedule.deleteMany({ staffId: { $in: staffIds } }),
    Task.deleteMany({ staffId: { $in: staffIds } }),
    Attendance.deleteMany({ staffId: { $in: staffIds } }),
    StaffRequest.deleteMany({ staffId: { $in: staffIds } }),
    User.deleteMany({ _id: { $in: staffUserIds }, role: 'staff' }),
    Staff.deleteMany({})
  ]);

  console.log('\nDeleted:');
  console.log(`  ${staffResult.deletedCount} staff records`);
  console.log(`  ${scheduleResult.deletedCount} staff schedules`);
  console.log(`  ${taskResult.deletedCount} tasks`);
  console.log(`  ${attendanceResult.deletedCount} attendance records`);
  console.log(`  ${requestResult.deletedCount} staff requests`);
  console.log(`  ${userResult.deletedCount} linked staff login accounts`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

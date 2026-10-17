import Hotel from '../models/Hotel.js';
import User from '../models/User.js';
import Staff from '../models/Staff.js';
import StaffSchedule from '../models/StaffSchedule.js';
import StaffRequest from '../models/StaffRequest.js';
import StaffDoorKey from '../models/StaffDoorKey.js';
import StaffKeyCard from '../models/StaffKeyCard.js';
import Task from '../models/Task.js';
import Attendance from '../models/Attendance.js';
import Booking from '../models/Booking.js';
import RoomBookingHold from '../models/RoomBookingHold.js';
import RoomCalendar from '../models/RoomCalendar.js';
import ExternalRoomBlock from '../models/ExternalRoomBlock.js';
import ServiceOrder from '../models/ServiceOrder.js';
import ServiceCatalogItem from '../models/ServiceCatalogItem.js';
import Chat from '../models/Chat.js';
import Review from '../models/Review.js';
import SupportIncident from '../models/SupportIncident.js';
import SupportMessage from '../models/SupportMessage.js';
import SmartLockDevice from '../models/SmartLockDevice.js';
import DeviceAccessEvent from '../models/DeviceAccessEvent.js';
import DeviceStatusEvent from '../models/DeviceStatusEvent.js';
import Notification from '../models/Notification.js';
import ttlockService from './ttlockService.js';

// Removes a hotel and everything that only exists because of it. Accounts are the sensitive part,
// so each kind is its own switch and the preview shows exactly who would go:
//   - staff accounts of the hotel: always (they only work for this hotel)
//   - the host's account: only if it owns no other hotel (otherwise it is kept either way)
//   - guest accounts: only those whose every booking was at this hotel, and only when asked
// Smart locks are platform inventory, not hotel data: they are unassigned and kept.

const ids = docs => docs.map(doc => doc._id);

async function collect(hotelId, { deleteHost = true, deleteGuests = false } = {}) {
  const hotel = await Hotel.findById(hotelId);
  if (!hotel) return null;

  const staff = await Staff.find({ hotelId }).select('_id userId firstName lastName');
  const staffUsers = staff.length
    ? await User.find({ _id: { $in: staff.map(s => s.userId).filter(Boolean) }, role: 'staff' }).select('_id')
    : [];

  const bookings = await Booking.find({ hotelId }).select('_id userId roomId status checkOutDate contactlessCheckIn');

  // A host account is only removed when this was their one and only hotel.
  const otherHotelsOfHost = await Hotel.countDocuments({ hostId: hotel.hostId, _id: { $ne: hotel._id } });
  const host = await User.findOne({ _id: hotel.hostId, role: 'host' }).select('_id firstName lastName email');
  const hostRemovable = !!host && otherHotelsOfHost === 0;

  // Guests who only ever booked here. One query for "who else has a booking elsewhere".
  const guestIdsHere = [...new Set(bookings.map(b => String(b.userId)).filter(Boolean))];
  let onlyHereGuests = [];
  if (guestIdsHere.length) {
    const elsewhere = await Booking.distinct('userId', { userId: { $in: guestIdsHere }, hotelId: { $ne: hotel._id } });
    const elsewhereSet = new Set(elsewhere.map(String));
    onlyHereGuests = await User.find({ _id: { $in: guestIdsHere.filter(id => !elsewhereSet.has(id)) }, role: 'guest' }).select('_id');
  }

  const devices = await SmartLockDevice.find({ hotelId }).select('_id deviceId provider deviceName roomNumber');

  return {
    hotel,
    staff,
    staffUserIds: ids(staffUsers),
    bookings,
    host: hostRemovable && deleteHost ? host : null,
    hostKeptReason: !host ? 'no host account' : !hostRemovable ? 'the host owns other hotels' : null,
    guestIds: deleteGuests ? ids(onlyHereGuests) : [],
    onlyHereGuestCount: onlyHereGuests.length,
    devices
  };
}

export async function previewHotelDeletion(hotelId, options = {}) {
  const plan = await collect(hotelId, options);
  if (!plan) return null;
  const { hotel, staff, bookings, devices } = plan;
  const staffIds = staff.map(s => s._id);

  const [orders, tasks, schedules, requests, attendance, chats, reviews, catalog, support, doorKeys, keyCards, calendars] = await Promise.all([
    ServiceOrder.countDocuments({ hotelId }),
    Task.countDocuments({ hotelId }),
    StaffSchedule.countDocuments({ hotelId }),
    StaffRequest.countDocuments({ hotelId }),
    Attendance.countDocuments({ $or: [{ hotelId }, { staffId: { $in: staffIds } }] }),
    Chat.countDocuments({ hotelId }),
    Review.countDocuments({ hotelId }),
    ServiceCatalogItem.countDocuments({ hotelId }),
    SupportIncident.countDocuments({ hotelId }),
    StaffDoorKey.countDocuments({ hotelId }),
    StaffKeyCard.countDocuments({ hotelId }),
    RoomCalendar.countDocuments({ hotelId })
  ]);

  return {
    hotel: { _id: hotel._id, name: hotel.name },
    counts: {
      rooms: hotel.rooms?.length || 0,
      bookings: bookings.length,
      activeBookings: bookings.filter(b => ['confirmed', 'pending'].includes(b.status) && (!b.checkOutDate || b.checkOutDate >= new Date())).length,
      serviceOrders: orders,
      tasks,
      schedules,
      staffRequests: requests,
      attendance,
      chats,
      reviews,
      menuItems: catalog,
      supportTickets: support,
      doorKeys,
      keyCards,
      roomCalendars: calendars,
      staffAccounts: plan.staffUserIds.length,
      staffRecords: staff.length,
      devicesToUnassign: devices.length
    },
    accounts: {
      host: plan.host ? { name: `${plan.host.firstName} ${plan.host.lastName}`.trim(), email: plan.host.email } : null,
      hostKeptReason: plan.hostKeptReason,
      guestsOnlyHere: plan.onlyHereGuestCount
    }
  };
}

// Best effort: a guest passcode/eKey or staff card still live on a lock would outlive its booking
// record, and with the record gone nobody can revoke it. Failures are reported, never fatal.
async function revokeLiveLockAccess(plan) {
  const failures = [];
  const now = new Date();
  const roomNumberOf = roomId => {
    const room = plan.hotel.rooms.find(r => String(r._id) === String(roomId));
    return room?.roomNumber || null;
  };
  const byRoom = new Map(plan.devices.filter(d => d.provider === 'ttlock').map(d => [d.roomNumber, d]));

  for (const booking of plan.bookings) {
    const access = booking.contactlessCheckIn;
    if (!access || (!access.keyboardPwdId && !access.ekeyId)) continue;
    if (booking.checkOutDate && booking.checkOutDate < now) continue; // already expired on its own
    const device = byRoom.get(roomNumberOf(booking.roomId));
    if (!device) continue;
    try {
      if (access.keyboardPwdId) await ttlockService.deleteKeyboardPwd(device.deviceId, access.keyboardPwdId);
      if (access.ekeyId) await ttlockService.revokeEkey(device.deviceId, access.ekeyId);
    } catch (error) {
      failures.push(`Booking access on ${device.deviceId}: ${error.message}`);
    }
  }

  const cards = await StaffKeyCard.find({ hotelId: plan.hotel._id, status: 'active', method: 'gateway', cardId: { $ne: null } }).populate('deviceId', 'deviceId');
  for (const card of cards) {
    if (!card.deviceId?.deviceId) continue;
    try {
      await ttlockService.deleteIdentityCard(card.deviceId.deviceId, card.cardId);
    } catch (error) {
      failures.push(`Card ${card.cardNumber}: ${error.message}`);
    }
  }
  return failures;
}

export async function deleteHotelCascade(hotelId, options = {}) {
  const plan = await collect(hotelId, options);
  if (!plan) return null;
  const { hotel } = plan;
  const staffIds = plan.staff.map(s => s._id);
  const bookingIds = plan.bookings.map(b => b._id);
  const deviceIds = plan.devices.map(d => d._id);

  const lockWarnings = await revokeLiveLockAccess(plan);

  const removedUserIds = [...plan.staffUserIds, ...(plan.host ? [plan.host._id] : []), ...plan.guestIds];

  // Children first and the hotel record last: if this stops halfway, the hotel is still listed and
  // running it again simply finishes the job.
  await Promise.all([
    StaffDoorKey.deleteMany({ hotelId }),
    StaffKeyCard.deleteMany({ hotelId }),
    StaffSchedule.deleteMany({ hotelId }),
    StaffRequest.deleteMany({ hotelId }),
    Task.deleteMany({ hotelId }),
    Attendance.deleteMany({ $or: [{ hotelId }, { staffId: { $in: staffIds } }] }),
    ServiceOrder.deleteMany({ hotelId }),
    ServiceCatalogItem.deleteMany({ hotelId }),
    Chat.deleteMany({ hotelId }),
    Review.deleteMany({ hotelId }),
    SupportIncident.deleteMany({ hotelId }),
    SupportMessage.deleteMany({ hotelId }),
    RoomBookingHold.deleteMany({ $or: [{ hotelId }, { bookingId: { $in: bookingIds } }] }),
    RoomCalendar.deleteMany({ hotelId }),
    ExternalRoomBlock.deleteMany({ hotelId }),
    DeviceAccessEvent.deleteMany({ $or: [{ deviceId: { $in: deviceIds } }, { bookingId: { $in: bookingIds } }] })
  ]);
  await Booking.deleteMany({ hotelId });
  await Staff.deleteMany({ hotelId });

  // The locks stay on the platform, free to be assigned to another hotel.
  await SmartLockDevice.updateMany(
    { hotelId },
    { $set: { hotelId: null, roomNumber: null } }
  );
  await DeviceStatusEvent.deleteMany({ device: { $in: deviceIds } }).catch(() => {});

  if (removedUserIds.length) {
    await Notification.deleteMany({ userId: { $in: removedUserIds } });
    await User.deleteMany({ _id: { $in: removedUserIds } });
  }
  // Wishlists of everyone else still pointing at it.
  await User.updateMany({ wishlist: hotel._id }, { $pull: { wishlist: hotel._id } });

  await Hotel.deleteOne({ _id: hotel._id });

  return {
    hotelName: hotel.name,
    deleted: {
      bookings: bookingIds.length,
      rooms: hotel.rooms?.length || 0,
      staffAccounts: plan.staffUserIds.length,
      hostAccount: plan.host ? 1 : 0,
      guestAccounts: plan.guestIds.length,
      devicesUnassigned: deviceIds.length
    },
    lockWarnings
  };
}

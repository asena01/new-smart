import Hotel from '../models/Hotel.js';
import Staff from '../models/Staff.js';

// The one place that decides whether req.user is allowed to manage something belonging to
// a given hotel — used everywhere a route used to just check `role !== 'admin'` +
// hotel-ownership, which silently excluded the case this whole feature is for: a staff
// member (e.g. a Manager) acting with a granted permission rather than the host's own login.
//
// True if req.user is the admin, the host who owns the hotel, or an active staff member at
// that hotel whose Staff.permissions[permissionKey] is true. Pass permissionKey as null for
// actions that should stay host/admin-only regardless of any staff permission.
// updateHotel uses this with 'canChangeHotelSettings' — a host can delegate editing the
// hotel's profile/policies to a trusted staff member, but payout/bank details
// (PATCH /:id/bank-details) stay host/admin-only regardless, since that's a separate, more
// sensitive concern (see updateHotelBankDetails).
export async function canManageHotel(req, hotelId, permissionKey) {
  if (!hotelId) return false;
  if (req.user.role === 'admin') return true;

  if (req.user.role === 'host') {
    const hotel = await Hotel.findOne({ _id: hotelId, hostId: req.user.userId });
    return !!hotel;
  }

  if (req.user.role === 'staff' && permissionKey) {
    const staff = await Staff.findOne({ userId: req.user.userId, hotelId, status: 'active' });
    return !!staff?.permissions?.[permissionKey];
  }

  return false;
}

// Same check, but for actions scoped to a specific staff member's own record (e.g. assigning
// their TTLock key) rather than a hotel-wide list — resolves that staff member's hotelId first.
export async function canManageStaffMember(req, staffId, permissionKey) {
  const target = await Staff.findById(staffId);
  if (!target) return { allowed: false, staff: null };
  const allowed = await canManageHotel(req, target.hotelId, permissionKey);
  return { allowed, staff: target };
}

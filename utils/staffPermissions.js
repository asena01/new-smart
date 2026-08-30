// Every permission a Staff document can carry. Kept as a flat list (rather than just
// inferring keys from an object) so callers can validate/iterate without depending on
// whichever position happens to be in PERMISSION_TEMPLATES below.
export const PERMISSION_KEYS = [
  'canCheckInGuests',
  'canManageReservations',
  'canAccessRooms',
  'canManageOrders',
  'canPrepareOrders',
  'canPrepareBarOrders',
  'canDeliverOrders',
  'canManageLaundry',
  'canManageTransportation',
  'canClaimTransportation',
  'canManageGuestServices',
  'canClaimHousekeepingTasks',
  'canClaimMaintenanceTasks',
  'canManageTasks',
  'canManageStaff',
  'canManageSchedules',
  'canApproveRequests',
  'canChangeHotelSettings'
];

const ALL_FALSE = Object.fromEntries(PERMISSION_KEYS.map(key => [key, false]));

// A starting point, not a ceiling — a host can grant or revoke any individual permission
// after creating the staff member, regardless of position. `canChangeHotelSettings` is
// deliberately off even for managers by default; a host has to explicitly grant it.
//
// canManageLaundry/canManageTransportation are their own dedicated permissions rather than
// reusing canManageOrders, which used to gate both — that meant every position with
// canManageOrders (chef, bar-attendant, receptionist, housekeeping, manager) saw Laundry and
// Transportation in their nav too, even though a chef/bar-attendant has nothing to do with
// either. canManageOrders itself remains the broader "oversight of restaurant/bar orders"
// permission it always was. canManageLaundry still doubles as the Laundry Queue's own
// CLAIMABLE_STAGES permission (housekeeping plausibly does laundry pickup/delivery itself);
// canManageTransportation no longer doubles that way for the Transportation Queue — see
// canClaimTransportation below.
//
// canPrepareOrders/canPrepareBarOrders are likewise split rather than sharing one key — a
// chef and a bar-attendant used to both carry the same canPrepareOrders, which is also what
// gated *both* restaurant and bar tickets in the kitchen prep claim queue (see
// getClaimableOrders's per-serviceType permission filtering in serviceOrderController.js), so
// a chef could see and claim bar orders and vice versa. canPrepareOrders now means kitchen/
// restaurant prep specifically; canPrepareBarOrders is bar prep. Both still land a staff
// member on the same "Kitchen Queue" page/route — its content is what's now scoped per viewer.
//
// canManageTransportation/canClaimTransportation split the same "manage" key that used to
// double as both — canManageTransportation authorizes the front-desk/host side (assigning a
// staff member to a transportation order via ORDER_MANAGE_PERMISSION, updating its status)
// while canClaimTransportation is what actually gates claiming a trip off the self-serve
// Transportation Queue (CLAIMABLE_STAGES). Receptionist coordinates transportation requests —
// arranges the ride, assigns whoever's actually driving — but has no business claiming a trip
// onto themselves and leaving the front desk to go drive it, so the receptionist template
// keeps only canManageTransportation. Manager keeps both, same as it holds both halves of
// every other manage/claim split (canPrepareOrders+canPrepareBarOrders,
// canClaimHousekeepingTasks+canClaimMaintenanceTasks). There's no dedicated driver position in
// this app — a host can manually grant canClaimTransportation to whichever staff member (e.g.
// security, or 'other') actually handles pickups.
//
// canManageGuestServices covers the "additional services" order types that aren't
// restaurant/bar/laundry/transportation — early-checkin, late-checkout, room-upgrade, custom
// (see ORDER_MANAGE_PERMISSION in serviceOrderController.js). These are front-desk guest
// service work, not kitchen/bar work, so they get their own permission rather than reusing
// canManageOrders — which a chef/bar-attendant hold for restaurant/bar oversight and would
// otherwise also let them assign staff to (and confirm/finalize) a guest's early check-in or
// room upgrade.
//
// canClaimHousekeepingTasks/canClaimMaintenanceTasks split Task claim-eligibility by the
// task's own `category` field the same way — previously any staff member with canAccessRooms
// (receptionist, housekeeping, maintenance, security, manager) could see and claim *any* open
// task regardless of category, so a maintenance worker could claim a cleaning task and vice
// versa. A 'general' category task has no dedicated permission and stays claimable by anyone
// with canAccessRooms, same as before — only cleaning/maintenance-specific tasks are now
// gated to the position that actually does that work (see getClaimableTasks/claimTask).
const PERMISSION_TEMPLATES = {
  receptionist: {
    canCheckInGuests: true, canManageReservations: true, canAccessRooms: true,
    canManageOrders: true, canManageTransportation: true, canManageGuestServices: true
  },
  housekeeping: { canAccessRooms: true, canManageLaundry: true, canClaimHousekeepingTasks: true },
  maintenance: { canAccessRooms: true, canClaimMaintenanceTasks: true },
  security: { canAccessRooms: true },
  manager: {
    canCheckInGuests: true, canManageReservations: true, canAccessRooms: true,
    canManageOrders: true, canPrepareOrders: true, canPrepareBarOrders: true, canDeliverOrders: true,
    canManageLaundry: true, canManageTransportation: true, canClaimTransportation: true, canManageGuestServices: true,
    canClaimHousekeepingTasks: true, canClaimMaintenanceTasks: true, canManageTasks: true,
    canManageStaff: true, canManageSchedules: true, canApproveRequests: true
  },
  chef: { canManageOrders: true, canPrepareOrders: true, canAccessRooms: false },
  'bar-attendant': { canManageOrders: true, canPrepareBarOrders: true, canAccessRooms: false },
  waiter: { canDeliverOrders: true, canAccessRooms: false },
  other: {}
};

export function getDefaultPermissions(position) {
  return { ...ALL_FALSE, canAccessRooms: true, ...(PERMISSION_TEMPLATES[position] || {}) };
}

// Merges a host's explicit choices over the position template — explicit `false` values
// must stick (so this can't just be a truthy-value merge), only `undefined`/missing keys
// fall back to the template.
export function resolvePermissions(position, overrides = {}) {
  const template = getDefaultPermissions(position);
  const resolved = { ...template };
  for (const key of PERMISSION_KEYS) {
    if (overrides[key] !== undefined) resolved[key] = !!overrides[key];
  }
  return resolved;
}

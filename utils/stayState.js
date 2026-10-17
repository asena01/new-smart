// The one rule for "a guest is in the building": checked in, not checked out, and their arrival day
// has come. Rooms (hotelController.js) and Front Desk's In-House list (bookingController.js) both use it, so a
// room never reads Occupied while In-House says nobody is there, or the other way round.
export function isPhysicallyInHouse(booking, today = new Date()) {
  if (booking.status === 'cancelled') return false;
  if (!booking.checkInInfo?.actualCheckInTime || booking.checkOutInfo?.actualCheckOutTime) return false;
  const arrival = new Date(booking.checkInDate);
  arrival.setHours(0, 0, 0, 0);
  const day = new Date(today);
  day.setHours(0, 0, 0, 0);
  return arrival <= day;
}

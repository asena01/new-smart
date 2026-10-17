// Checks rows from a room import file (CSV filled in by the host) before anything is saved.
// Every row is checked and ALL problems are reported at once, so the host can fix the file in one go.

export const MAX_IMPORT_ROOMS = 200;

const CHECK_IN_TYPES = ['standard', 'ttlock', 'tuya', 'both'];
// A host can only ever put a room in one of these. 'occupied' / 'maintenance' are legacy values.
const HOST_STATUSES = ['available', 'out-of-order', 'out-of-service'];

const text = value => (value == null ? '' : String(value).trim());

function toNumber(value) {
  const cleaned = text(value).replace(/[₦,\s]/g, '');
  if (cleaned === '') return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : NaN;
}

// rows: [{ roomNumber, type, capacity, basePrice, discountPrice?, description?, checkInType?, status? }]
// existingNumbers: room numbers the hotel already has.
// Returns { rooms, errors } where errors is [{ row, message }] (row is 1-based, as in the file).
export function validateRoomRows(rows, existingNumbers = []) {
  const errors = [];
  const rooms = [];

  if (!Array.isArray(rows) || rows.length === 0) {
    return { rooms, errors: [{ row: 0, message: 'The file has no rooms in it.' }] };
  }
  if (rows.length > MAX_IMPORT_ROOMS) {
    return { rooms, errors: [{ row: 0, message: `Import at most ${MAX_IMPORT_ROOMS} rooms at a time.` }] };
  }

  const taken = new Set(existingNumbers.map(n => text(n).toLowerCase()));
  const seenInFile = new Map();

  rows.forEach((raw, index) => {
    const row = index + 1;
    const problems = [];

    const roomNumber = text(raw.roomNumber);
    if (!roomNumber) problems.push('Room number is missing');
    else if (roomNumber.length > 20) problems.push('Room number is too long (20 characters at most)');
    else if (taken.has(roomNumber.toLowerCase())) problems.push(`Room ${roomNumber} already exists in your hotel`);
    else if (seenInFile.has(roomNumber.toLowerCase())) problems.push(`Room ${roomNumber} is repeated (also on row ${seenInFile.get(roomNumber.toLowerCase())})`);
    if (roomNumber) seenInFile.set(roomNumber.toLowerCase(), seenInFile.get(roomNumber.toLowerCase()) ?? row);

    const type = text(raw.type);
    if (!type) problems.push('Room type is missing');
    else if (type.length > 80) problems.push('Room type is too long (80 characters at most)');

    const capacity = toNumber(raw.capacity);
    if (capacity === null) problems.push('Capacity is missing');
    else if (Number.isNaN(capacity) || !Number.isInteger(capacity) || capacity < 1 || capacity > 20) problems.push('Capacity must be a whole number from 1 to 20');

    const basePrice = toNumber(raw.basePrice);
    if (basePrice === null) problems.push('Price is missing');
    else if (Number.isNaN(basePrice) || basePrice < 0) problems.push('Price must be a number, 0 or more');

    let discountPrice = toNumber(raw.discountPrice);
    if (Number.isNaN(discountPrice) || (discountPrice !== null && discountPrice < 0)) {
      problems.push('Discount price must be a number, 0 or more');
      discountPrice = null;
    } else if (discountPrice !== null && discountPrice !== 0 && basePrice !== null && !Number.isNaN(basePrice) && discountPrice >= basePrice) {
      problems.push('Discount price must be lower than the price');
    }

    const checkInType = text(raw.checkInType).toLowerCase() || 'standard';
    if (!CHECK_IN_TYPES.includes(checkInType)) problems.push(`Check-in type must be one of: ${CHECK_IN_TYPES.join(', ')}`);

    const status = text(raw.status).toLowerCase().replace(/\s+/g, '-') || 'available';
    if (!HOST_STATUSES.includes(status)) problems.push(`Status must be one of: ${HOST_STATUSES.join(', ')}`);

    const description = text(raw.description);
    if (description.length > 1000) problems.push('Description is too long (1000 characters at most)');

    if (problems.length) {
      problems.forEach(message => errors.push({ row, message }));
      return;
    }

    rooms.push({
      roomNumber,
      type,
      capacity,
      basePrice,
      ...(discountPrice ? { discountPrice } : {}),
      ...(description ? { description } : {}),
      checkInType,
      status
    });
  });

  return { rooms, errors };
}

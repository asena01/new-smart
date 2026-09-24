const formatterCache = new Map();

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

const COUNTRY_TIME_ZONE_FALLBACKS = new Map([
  ['nigeria', 'Africa/Lagos']
]);

// Older clients may omit policies.timeZone when saving an otherwise valid hotel policy.
// Prefer a known country timezone over an absent/legacy UTC default so those clients cannot
// shift the hotel's wall-clock checkout deadline. Hotels outside this explicit map must set
// their IANA timezone in Hotel Settings.
export function resolveHotelTimeZone(hotel) {
  const country = String(hotel?.location?.country || '').trim().toLowerCase();
  const countryFallback = COUNTRY_TIME_ZONE_FALLBACKS.get(country);
  const configured = hotel?.policies?.timeZone;
  if (countryFallback && (!configured || configured === 'UTC')) return countryFallback;
  return isValidTimeZone(configured) ? configured : (countryFallback || 'UTC');
}

function formatterFor(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }));
  }
  return formatterCache.get(timeZone);
}

function offsetAt(instant, timeZone) {
  const values = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  const representedAsUtc = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute,
    values.second
  );
  return representedAsUtc - instant.getTime();
}

// Booking dates are stored as UTC-midnight calendar dates. The policy time is a hotel-local
// wall-clock value, so resolve that wall clock in the hotel's IANA timezone and return the
// corresponding UTC instant for comparisons, schedulers, and smart-lock validity windows.
export function combineDateAndTime(date, timeStr, timeZone = 'UTC') {
  const calendarDate = new Date(date);
  const [hours, minutes] = String(timeStr || '00:00').split(':').map(Number);
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const wallClockAsUtc = Date.UTC(
    calendarDate.getUTCFullYear(),
    calendarDate.getUTCMonth(),
    calendarDate.getUTCDate(),
    Number.isFinite(hours) ? hours : 0,
    Number.isFinite(minutes) ? minutes : 0,
    0,
    0
  );

  // Re-evaluate once after the first offset estimate so dates close to a DST transition use
  // the offset at the target instant rather than the offset at the initial UTC guess.
  let instantMs = wallClockAsUtc - offsetAt(new Date(wallClockAsUtc), zone);
  instantMs = wallClockAsUtc - offsetAt(new Date(instantMs), zone);
  return new Date(instantMs);
}

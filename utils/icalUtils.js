import dns from 'dns';
import https from 'https';
import net from 'net';
import axios from 'axios';

const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 2000;
const FETCH_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;

// ---- Parsing ----------------------------------------------------------------------------

function utcDay(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day));
}

// Takes a DTSTART/DTEND value and returns the UTC-midnight calendar day it falls on. Only the
// date is used on purpose: OTAs publish stays either as all-day dates or with a check-in/out
// time, and this app reasons in whole nights. Floating and TZID values keep the digits as
// written (the property's own local date), a trailing Z is already UTC.
function toCalendarDay(value) {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value || '');
  if (!match) return null;
  return utcDay(Number(match[1]), Number(match[2]), Number(match[3]));
}

function unescapeText(text) {
  return text.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

// Minimal RFC 5545 reader — enough for the VEVENT stays OTAs publish. Returns
// [{ uid, summary, start, end }] with start/end as UTC-midnight Dates and end exclusive.
export function parseIcsEvents(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let current = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current?.start) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).split(';')[0].toUpperCase();
    const value = line.slice(colon + 1);

    if (name === 'UID') current.uid = value.trim();
    else if (name === 'SUMMARY') current.summary = unescapeText(value).slice(0, 100);
    else if (name === 'STATUS') current.status = value.trim().toUpperCase();
    else if (name === 'DTSTART') current.start = toCalendarDay(value);
    else if (name === 'DTEND') current.end = toCalendarDay(value);
  }

  return events
    .filter(event => event.status !== 'CANCELLED')
    .map(event => {
      let end = event.end;
      if (!end || end <= event.start) {
        end = new Date(event.start);
        end.setUTCDate(end.getUTCDate() + 1);
      }
      return {
        uid: event.uid || `${event.start.toISOString()}_${end.toISOString()}`,
        summary: event.summary || '',
        start: event.start,
        end,
      };
    })
    .slice(0, MAX_EVENTS);
}

// ---- Building ---------------------------------------------------------------------------

function formatDate(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function escapeText(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

// events: [{ uid, start, end }] — start/end are Dates; only their UTC calendar day is used.
export function buildIcs(calendarName, events) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FinSmartHotels//Room Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];

  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${formatDate(event.start)}`,
      `DTEND;VALUE=DATE:${formatDate(event.end)}`,
      // Deliberately generic — never the guest's name; other platforms only need to know the
      // nights are taken.
      'SUMMARY:Reserved',
      'TRANSP:OPAQUE',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// ---- Fetching (server-side request to a user-supplied URL) -------------------------------

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  const lower = ip.toLowerCase();

  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mappedDotted) return isPrivateIPv4(mappedDotted[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    return isPrivateIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }

  // Allowlist rather than blocklist for IPv6: only global unicast (2000::/3) is accepted, minus
  // the 6to4 and Teredo ranges that can embed an arbitrary IPv4 address.
  if (!/^[23]/.test(lower)) return true;
  return lower.startsWith('2002:') || lower.startsWith('2001::') || lower.startsWith('2001:0:');
}

// Validates at connect time, on the address actually being connected to — checking the hostname
// once up front and letting the HTTP client resolve it again would leave a DNS-rebinding gap.
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (error, address, family) => {
    if (error) return callback(error);
    const addresses = Array.isArray(address) ? address.map(entry => entry.address) : [address];
    if (addresses.some(isPrivateAddress)) {
      return callback(new Error('That address is not allowed'));
    }
    return callback(null, address, family);
  });
}

const feedAgent = new https.Agent({ lookup: guardedLookup });

export function normalizeFeedUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim().replace(/^webcal:\/\//i, 'https://');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Enter a valid calendar link');
  }
  if (parsed.protocol !== 'https:') throw new Error('The calendar link must start with https://');
  if (parsed.username || parsed.password) throw new Error('The calendar link must not contain a username or password');
  // Real calendar providers use domain names. An IP literal is only ever an attempt to reach
  // something internal — and Node skips the DNS lookup (so guardedLookup never runs) when the
  // host is already an IP — so every literal is rejected here, public or not. WHATWG URL parsing
  // has already normalized odd IPv4 spellings (decimal, hex, octal) to dotted form.
  if (net.isIP(parsed.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error('Use the calendar link exactly as the other platform gave it, not an IP address');
  }
  return parsed.toString();
}

// Fetches an iCal feed and returns its parsed events. Redirects are followed by hand so every
// hop goes through the same https-only and private-address checks.
export async function fetchFeedEvents(feedUrl) {
  let url = normalizeFeedUrl(feedUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await axios.get(url, {
      httpsAgent: feedAgent,
      timeout: FETCH_TIMEOUT_MS,
      maxRedirects: 0,
      maxContentLength: MAX_FEED_BYTES,
      maxBodyLength: MAX_FEED_BYTES,
      responseType: 'text',
      transformResponse: data => data,
      headers: { Accept: 'text/calendar, text/plain, */*', 'User-Agent': 'FinSmartHotels-CalendarSync/1.0' },
      validateStatus: status => status >= 200 && status < 400,
    });

    if (response.status >= 300) {
      const location = response.headers.location;
      if (!location) throw new Error('The calendar link redirected without a destination');
      url = normalizeFeedUrl(new URL(location, url).toString());
      continue;
    }

    const body = String(response.data || '');
    if (!body.includes('BEGIN:VCALENDAR')) throw new Error('That link did not return a calendar');
    return parseIcsEvents(body);
  }

  throw new Error('The calendar link redirected too many times');
}

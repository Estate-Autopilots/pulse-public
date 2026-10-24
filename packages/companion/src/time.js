// Small time helpers. Pulse attendance runs on the organisation's clock (India), so every client turns the server's
// offset into local wall time instead of trusting the device's own time zone.

const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 4:05:09 for a running timer; 0:00:00 when nothing is running. */
export function stopwatch(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/** "4 h 05 min", "35 min" for sentences. */
export function duration(seconds) {
  const m = Math.max(0, Math.round((seconds || 0) / 60));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${pad(m % 60)} min` : ''}`;
}

/** Minutes after midnight on the organisation's clock. */
export function wallMinutes(at, offsetMinutes) {
  const m = Math.floor(at / 60000) + offsetMinutes;
  return ((m % 1440) + 1440) % 1440;
}

/** "Thu 9 Oct" for a YYYY-MM-DD date. */
export function shortDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "10:15" from "10:00" plus 15 minutes. */
export function addClock(hhmm, minutes) {
  const total = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) + minutes;
  return `${pad(Math.floor(((total % 1440) + 1440) % 1440 / 60))}:${pad(((total % 60) + 60) % 60)}`;
}

/** 12-hour clock text for the person, e.g. "7:00 pm". */
export function friendlyClock(hhmm) {
  const h = Number(hhmm.slice(0, 2)), m = hhmm.slice(3, 5);
  return `${h % 12 || 12}:${m} ${h < 12 ? 'am' : 'pm'}`;
}

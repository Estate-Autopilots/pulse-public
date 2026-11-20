// CHAT-V5: times for "remind me" and "send later" (in the company's time zone), the words for when something happens,
// recent emoji, @everyone / @here, and the words found in a conversation.

/** Minutes the zone is ahead of UTC at `date` (India: 330). */
export function zoneOffset(date, zone = "Asia/Kolkata") {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(date).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((wall - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}
/** The wall clock in the zone as plain numbers (weekday 0 = Sunday). */
function wallOf(date, zone) {
  const z = new Date(date.getTime() + zoneOffset(date, zone) * 60000);
  return { y: z.getUTCFullYear(), m: z.getUTCMonth(), d: z.getUTCDate(), h: z.getUTCHours(), min: z.getUTCMinutes(), wd: z.getUTCDay() };
}
/** The instant of a wall-clock time in the zone (days added to the date given). */
function atWall(w, addDays, hour, minute, zone) {
  const guess = new Date(Date.UTC(w.y, w.m, w.d + addDays, hour, minute));
  return new Date(guess.getTime() - zoneOffset(guess, zone) * 60000);
}

/** Quick choices for "remind me" (`reminder`) or "send later" (`send`): [label, ISO time], soonest first, no repeats. */
export function laterChoices(kind = "reminder", now = new Date(), zone = "Asia/Kolkata") {
  const w = wallOf(now, zone), out = [];
  const add = (label, date) => { if (date.getTime() - now.getTime() >= 60000 && !out.some(([, t]) => t === date.toISOString())) out.push([label, date.toISOString()]); };
  if (kind === "reminder") {
    add("In 20 minutes", new Date(now.getTime() + 20 * 60000));
    add("In 1 hour", new Date(now.getTime() + 3600000));
    add("In 3 hours", new Date(now.getTime() + 3 * 3600000));
  }
  if (w.h < 17) add("This evening, 6:00 pm", atWall(w, 0, 18, 0, zone));
  add("Tomorrow, 9:00 am", atWall(w, 1, 9, 0, zone));
  if (kind === "send") add("Tomorrow, 2:00 pm", atWall(w, 1, 14, 0, zone));
  const toMonday = ((8 - w.wd) % 7) || 7;
  if (toMonday > 1) add("Monday, 9:00 am", atWall(w, toMonday, 9, 0, zone));
  return out;
}

/** When a reminder rings or a message goes, in words: "today, 6:00 pm", "tomorrow, 9:00 am", "Mon 27 Oct, 9:00 am". */
export function whenWords(iso, now = new Date(), zone = "Asia/Kolkata") {
  const d = new Date(iso); if (!Number.isFinite(d.getTime())) return "";
  const a = wallOf(d, zone), b = wallOf(now, zone);
  const days = Math.round((Date.UTC(a.y, a.m, a.d) - Date.UTC(b.y, b.m, b.d)) / 86400000);
  const time = new Intl.DateTimeFormat("en-IN", { timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true }).format(d).replace(/\s?(am|pm)$/i, (m) => ` ${m.trim().toLowerCase()}`);
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : days === -1 ? "yesterday"
    : new Intl.DateTimeFormat("en-IN", { timeZone: zone, weekday: "short", day: "numeric", month: "short", ...(a.y !== b.y ? { year: "numeric" } : {}) }).format(d);
  return `${day}, ${time}`;
}

/** The value of a datetime-local input for an instant, in the zone ("2026-10-25T09:00"). */
export function localInput(iso, zone = "Asia/Kolkata") {
  const w = wallOf(new Date(iso), zone); const p = (n) => String(n).padStart(2, "0");
  return `${w.y}-${p(w.m + 1)}-${p(w.d)}T${p(w.h)}:${p(w.min)}`;
}
/** A datetime-local input's value (wall time in the zone) as an instant, or null. */
export function fromLocalInput(value, zone = "Asia/Kolkata") {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value ?? "")); if (!m) return null;
  return atWall({ y: +m[1], m: +m[2] - 1, d: +m[3] }, 0, +m[4], +m[5], zone).toISOString();
}

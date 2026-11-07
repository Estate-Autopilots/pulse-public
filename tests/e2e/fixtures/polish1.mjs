// POLISH-1 screenshots: HR-POLISH's synthetic desk, plus a person with a full month of attendance, so My desk's month
// calendar can be checked at every size (the plain mock has no days). Identity month@polish1.test reads as the
// synthetic admin; its own day list and no My Pulse (the overview that shows "This month" as a calendar).
export * from "./hr-polish.mjs";
export const VARIANTS = { "month@polish1.test": "admin" };
const send = (data, status = 200) => [status, data];
const pad = (n) => String(n).padStart(2, "0");

function month(today) {
  const [y, m] = today.split("-").map(Number); const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); const days = [];
  for (let d = 1; d <= last; d++) {
    const date = `${y}-${pad(m)}-${pad(d)}`, dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const base = { date, sessions: [], attendance: null, holiday: null, entry: null, leave: null, pendingLeave: false };
    if (date > today) { days.push({ ...base, status: dow === 0 ? "off" : "upcoming" }); continue; }
    if (dow === 0) { days.push({ ...base, status: "off" }); continue; }
    if (d === 2) { days.push({ ...base, status: "holiday", holiday: "Synthetic holiday" }); continue; }
    if (d === 7) { days.push({ ...base, status: "leave", leave: { kind: "annual", halfDay: null } }); continue; }
    const late = d % 5 === 0 ? 12 : 0, mode = d % 4 === 0 ? "wfh" : "office", inMin = 9 * 60 + 52 + late, outMin = 18 * 60 + 40 + (d % 3) * 7;
    const iso = (min) => new Date(Date.parse(`${date}T00:00:00Z`) + (min - 330) * 60000).toISOString();
    const entry = { id: `synthetic-${date}`, personId: "synthetic-admin", date, in: iso(inMin), out: date === today ? null : iso(outMin), mode, late, missedOut: false,
      source: d === 9 ? "regularised" : "self", note: null, breakMinutes: 45, onBreak: false, worked: outMin - inMin - 45 };
    days.push({ ...base, status: date === today ? "today" : "present", entry, sessions: [entry],
      attendance: { date, personId: "synthetic-admin", sessions: 1, flaggedCount: 0, recordedMinutes: entry.worked, eligible: true, minutes: entry.worked, reasons: [], labels: [] } });
  }
  return days;
}

export async function routeAny(url, who, { mockPort, headers }) {
  if (who !== "month@polish1.test") return null;
  if (url.pathname === "/api/v0/me/pulse") return send({ error: "Synthetic: no My Pulse for this person" }, 404);
  if (url.pathname === "/api/v0/hr/self") {
    const r = await fetch(`http://127.0.0.1:${mockPort}${url.pathname}${url.search}`, { headers: { ...headers, "cf-access-authenticated-user-email": "admin@estateautopilots.com" } });
    const self = await r.json(); const today = self.today ?? new Date().toISOString().slice(0, 10);
    self.attendanceEnabled = true;
    self.month = { ...(self.month ?? {}), key: today.slice(0, 7), from: `${today.slice(0, 7)}-01`, to: today, days: month(today), trackedFrom: `${today.slice(0, 7)}-01`, summary: self.month?.summary ?? undefined };
    return [r.status, self];
  }
  return null;
}

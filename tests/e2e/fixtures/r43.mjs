// R43 screenshots on wholly invented data: My desk → History (earlier months, imported reports HR confirmed, leave by
// year, requests, documents, issued payslips), the month calendar with every kind of day, and HR's views next to it.
//   ea-heavy node tests/e2e/hr-polish-shots.mjs --fixtures r43 --serve <port>
// Identity month@r43.test reads as the synthetic admin with a full month and a long history; new@r43.test has none.
export * from "./polish1.mjs";
export const VARIANTS = { "month@r43.test": "admin", "new@r43.test": "admin" };
export const SHOTS = [
  ["history", "/me?tab=history", "month@r43.test"], ["history-new", "/me?tab=history", "new@r43.test"],
  ["attendance", "/me?tab=attendance&section=Your%20month", "month@r43.test"], ["overview", "/me", "month@r43.test"],
  ["hr-month", "/hr?tab=attendance&view=month", "admin"], ["hr-today", "/hr?tab=attendance&view=today", "admin"],
];
const send = (data, status = 200) => [status, data];
const pad = (n) => String(n).padStart(2, "0");

function month(today) {
  const [y, m] = today.split("-").map(Number); const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); const days = [];
  for (let d = 1; d <= last; d++) {
    const date = `${y}-${pad(m)}-${pad(d)}`, dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const base = { date, sessions: [], attendance: null, holiday: null, entry: null, leave: null, pendingLeave: false };
    const iso = (min) => new Date(Date.parse(`${date}T00:00:00Z`) + (min - 330) * 60000).toISOString();
    const work = (inMin, outMin, extra = {}) => {
      const entry = { id: `synthetic-${date}`, personId: "synthetic-admin", date, in: iso(inMin), out: date === today ? null : iso(outMin), mode: "office", late: 0, missedOut: false,
        source: "self", note: null, breakMinutes: 40, onBreak: false, worked: outMin - inMin - 40, ...extra };
      return { ...base, status: date === today ? "today" : "present", entry, sessions: [entry], ...(extra.day ?? {}),
        attendance: { date, personId: "synthetic-admin", sessions: 1, flaggedCount: entry.missedOut ? 1 : 0, recordedMinutes: entry.worked, eligible: !entry.missedOut, minutes: entry.missedOut ? null : entry.worked, reasons: entry.missedOut ? ["missing_checkout"] : [], labels: entry.missedOut ? ["No check-out recorded"] : [] } };
    };
    if (date > today) { days.push({ ...base, status: dow === 0 ? "off" : "upcoming", pendingLeave: d === Number(today.slice(8)) + 3 }); continue; }
    if (d === 5 && dow === 0) { days.push(work(600, 960, { day: { workApproved: true } })); continue; }
    if (dow === 0) { days.push({ ...base, status: "off" }); continue; }
    if (d === 2) { days.push({ ...base, status: "holiday", holiday: "Synthetic Founders' Day" }); continue; }
    if (d === 7) { days.push({ ...base, status: "leave", leave: { kind: "annual", halfDay: null } }); continue; }
    if (d === 8) { days.push({ ...base, status: "absent" }); continue; }
    if (d === 3) { days.push(work(592, 1120, { mode: "field" })); continue; }
    if (d === 6) { days.push(work(610, 1105, { missedOut: true, out: null })); continue; }
    if (d === 9) { days.push(work(615, 1110, { source: "regularised", mode: "wfh" })); continue; }
    days.push(work(592 + (d % 5 === 0 ? 27 : 0), 1120 + (d % 3) * 7, { late: d % 5 === 0 ? 12 : 0 }));
  }
  return days;
}

const history = (today) => ({
  today, attendanceEnabled: true, joinedOn: "2024-11-04", leaveYearStart: 4,
  coverage: { pulseFrom: "2026-04", trackingFrom: "2026-04-01", importedMonths: 5, withHr: 2 },
  attendance: ["2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04"].map((m, i) => ({ month: m, days: i ? 22 - (i % 3) : 9, wfh: i % 3, field: i === 2 ? 1 : 0, corrected: i === 1 ? 2 : 0 })),
  imported: [
    { key: "s1", month: "2026-03-01", monthLabel: "Mar", leaveDays: 1, wfhDays: 2, halfDays: 0, coverage: null, basis: "reported numeric count", sheet: "Mar 26", enteredByHr: false },
    { key: "s2", month: "2026-02-01", monthLabel: "Feb", leaveDays: 0, wfhDays: 1, halfDays: null, coverage: null, basis: "reported numeric count", sheet: "Feb 26", enteredByHr: false },
    { key: "s3", month: "2026-01-01", monthLabel: "Jan", leaveDays: 2, wfhDays: null, halfDays: 1, coverage: null, basis: "Recorded by HR from the January register", sheet: null, enteredByHr: true },
    { key: "s4", month: "2025-12-01", monthLabel: "Dec", leaveDays: 3, wfhDays: 0, halfDays: 0, coverage: null, basis: "counted explicit dates; ranges unresolved", sheet: "Dec 25", enteredByHr: false },
    { key: "s5", month: null, monthLabel: "Nov", leaveDays: 1, wfhDays: 1, halfDays: null, coverage: null, basis: "reported numeric count", sheet: "Nov", enteredByHr: false },
  ],
  leave: [
    { year: 2026, kind: "annual", approved: 4, pending: 1, closed: 0, requests: 4 }, { year: 2026, kind: "sick", approved: 1.5, pending: 0, closed: 1, requests: 3 },
    { year: 2026, kind: "comp_off", approved: 1, pending: 0, closed: 0, requests: 1 }, { year: 2025, kind: "annual", approved: 9, pending: 0, closed: 2, requests: 8 },
  ],
  requests: { total: 11, pending: 1, rows: [
    { id: "r1", kind: "leave", status: "pending", stage: "pod_head", subject: "Annual leave", fromDate: "2026-10-20", toDate: "2026-10-21", updatedAt: `${today}T05:00:00Z` },
    { id: "r2", kind: "work", status: "approved", stage: "pod_head", subject: "Work on a weekly off", fromDate: "2026-10-05", toDate: "2026-10-05", updatedAt: "2026-10-03T05:00:00Z" },
    { id: "r3", kind: "correction", status: "approved", stage: "hr", subject: "Missed check-out", fromDate: "2026-09-18", toDate: "2026-09-18", updatedAt: "2026-09-19T05:00:00Z" },
    { id: "r4", kind: "leave", status: "rejected", stage: "pod_head", subject: "Sick leave", fromDate: "2026-08-11", toDate: "2026-08-11", updatedAt: "2026-08-10T05:00:00Z" },
    { id: "r5", kind: "request", status: "cancelled", stage: "hr", subject: "Other request", fromDate: "2026-07-01", toDate: "2026-07-01", updatedAt: "2026-06-30T05:00:00Z" },
  ] },
  tickets: { total: 3, open: 1 },
  documents: {
    onFile: [{ type: "offer_letter", seenAt: "2024-10-28T05:00:00Z" }, { type: "appointment_letter", seenAt: "2024-11-04T05:00:00Z" }],
    files: [{ id: "f1", kind: "role_terms", title: "Role and terms 2026", name: "terms.pdf", addedAt: "2026-04-02T05:00:00Z" }],
    policies: [{ kind: "leave", title: "Leave policy", version: 3, at: "2026-09-02T05:00:00Z" }, { kind: "attendance", title: "Attendance policy", version: 2, at: "2026-08-14T05:00:00Z" }],
  },
  payslips: [{ month: "2026-09", version: 1, issuedAt: "2026-10-03T05:00:00Z" }, { month: "2026-08", version: 2, issuedAt: "2026-09-05T05:00:00Z" }, { month: "2026-07", version: 1, issuedAt: "2026-08-04T05:00:00Z" }],
});
const empty = (today) => ({ today, attendanceEnabled: true, joinedOn: "2026-10-06", leaveYearStart: 1, coverage: { pulseFrom: null, trackingFrom: "2026-04-01", importedMonths: 0, withHr: 0 },
  attendance: [], imported: [], leave: [], requests: { total: 0, pending: 0, rows: [] }, tickets: { total: 0, open: 0 }, documents: { onFile: [], files: [], policies: [] }, payslips: [] });

export async function routeAny(url, who, { mockPort, headers }) {
  if (!who.endsWith("@r43.test")) return null;
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  if (url.pathname === "/api/v0/hr/self/history") return send(who.startsWith("new@") ? empty(today) : history(today));
  if (url.pathname === "/api/v0/me/pulse") return send({ error: "Synthetic: no My Pulse for this person" }, 404);
  if (url.pathname === "/api/v0/hr/work-calendar") return send({ today, me: "synthetic-admin", days: [], credits: [], patterns: [], work: [], compPolicy: { credit: 1, expiryDays: 90 } });
  if (url.pathname === "/api/v0/hr/self") {
    const r = await fetch(`http://127.0.0.1:${mockPort}${url.pathname}${url.search}`, { headers: { ...headers, "cf-access-authenticated-user-email": "admin@estateautopilots.com" } });
    const self = await r.json(); const day = self.today ?? today;
    self.attendanceEnabled = true;
    self.month = { ...(self.month ?? {}), key: day.slice(0, 7), from: `${day.slice(0, 7)}-01`, to: day, days: who.startsWith("new@") ? [] : month(day), trackedFrom: `${day.slice(0, 7)}-01`, summary: self.month?.summary ?? undefined };
    return [r.status, self];
  }
  return null;
}

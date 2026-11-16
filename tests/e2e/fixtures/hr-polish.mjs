// HR-POLISH: a busy, wholly synthetic HR desk (invented "Synthetic …" people, no real records) for screenshots of
// every HR desk tab. Served by tests/e2e/hr-polish-shots.mjs in front of mock-editors-api.mjs.
const TODAY = "2026-10-08";
const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const at = (date, hm) => new Date(`${date}T${hm}:00+05:30`).toISOString();
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export const policy = { shiftStart: "10:00", shiftEnd: "19:00", graceMinutes: 15, workDays: [1, 2, 3, 4, 5, 6], wfhPerMonth: 4, leaveYearStart: 1, trackingFrom: "2026-04-01", confirmedAt: null };
export const types = [
  { key: "annual", name: "Paid leave", paid: true, annualDays: 18, accrual: "monthly", carryForwardMax: 6, active: true },
  { key: "sick", name: "Sick leave", paid: true, annualDays: 6, accrual: "monthly", carryForwardMax: 0, active: true },
  { key: "comp_off", name: "Comp-off", paid: true, annualDays: null, accrual: "none", carryForwardMax: 0, active: true },
  { key: "unpaid", name: "Unpaid leave", paid: false, annualDays: null, accrual: "none", carryForwardMax: 0, active: true },
];

const ROLES = ["Video editor", "Senior designer", "Shoot coordinator", "Client servicing", "Motion designer", "Photographer", "Accounts", "Pod head"];
const PODS = ["Studio", "West pod", "Growth", null];
const NAMES = ["Synthetic Aarav Mifos", "Synthetic Morgan Fernandes-Iyer", "Synthetic Taylor", "Synthetic Sam", "Synthetic Rila Kapoor", "Synthetic Jordan Pillai",
  "Synthetic Casey D'Souza", "Synthetic Neel Banerjee", "Synthetic Alex Thomas", "Synthetic Ira Chatterjee", "Synthetic Dev Malhotra", "Synthetic Noor Shaikh", "Synthetic Kedab Rao", "Synthetic Leela Menon"];
export const people = NAMES.map((name, i) => ({ id: `synthetic-p${i + 1}`, name, role: ROLES[i % ROLES.length], pod: PODS[i % PODS.length], department: i % 2 ? "Creative" : "Operations",
  userNo: 100 + i, photoAt: null, joinedOn: shift("2025-01-06", i * 23), status: "active", employmentType: i === 12 ? "contract" : "full_time" }));
const P = (i) => people[i - 1];
people[7].pod = "Studio"; // Synthetic Neel heads Studio

const entry = (i, inHm, outHm, extra = {}) => {
  const p = P(i); const inAt = at(TODAY, inHm); const out = outHm ? at(TODAY, outHm) : null;
  const worked = Math.round(((out ? Date.parse(out) : Date.parse(at(TODAY, "11:20"))) - Date.parse(inAt)) / 60000) - (extra.breakMinutes ?? 0);
  return { id: `synthetic-entry-${p.id}`, personId: p.id, date: TODAY, in: inAt, out, mode: "office", late: 0, missedOut: false, source: "self", note: null, breakMinutes: 0, onBreak: false, worked, ...extra };
};
const eligible = (p, minutes) => ({ eligible: true, minutes, reasons: [], labels: [], date: TODAY, personId: p.id, sessions: 1, flaggedCount: 0, recordedMinutes: minutes });
const rosterRow = (i, status, e, more = {}) => { const p = P(i); return { ...p, canSignIn: true, trackedFrom: "2026-09-01", status, attendance: e && e.out ? eligible(p, e.worked) : null, sessions: e ? [e] : [], entry: e, leave: null, ...more }; };

const roster = [
  rosterRow(1, "in", entry(1, "09:52", null)),
  rosterRow(2, "in", entry(2, "10:31", null, { late: 16 })),
  rosterRow(3, "break", entry(3, "09:58", null, { onBreak: true, breakMinutes: 12 })),
  rosterRow(4, "in", entry(4, "10:05", null, { mode: "wfh" })),
  rosterRow(5, "in", entry(5, "09:40", null, { mode: "field" })),
  rosterRow(6, "done", entry(6, "07:00", "11:05", { source: "regularised" })),
  rosterRow(7, "leave", null, { leave: { kind: "annual", halfDay: null } }),
  rosterRow(8, "leave", null, { leave: { kind: "sick", halfDay: "first" } }),
  rosterRow(9, "not_in", null),
  rosterRow(10, "not_in", null),
  rosterRow(11, "untracked", null, { trackedFrom: null }),
  rosterRow(12, "outcome", null),
  { ...rosterRow(13, "not_in", null), canSignIn: false },
  rosterRow(14, "in", entry(14, "10:12", null)),
];

const balance = (key, available, extra = {}) => ({ key, accrued: available + 2, carried: 0, adjusted: 0, used: 2, pending: 0, available, ...extra });
export const leaveRequests = [
  { id: "synthetic-leave-1", personId: P(9).id, name: P(9).name, fromDate: TODAY, toDate: TODAY, kind: "sick", status: "pending", halfDay: null, days: 1,
    reason: "Fever since last night and the doctor has asked me to rest today. I will keep my phone on for anything urgent on the synthetic shoot handover and share the edit notes with the pod by evening.",
    createdAt: ago(26), decidedAt: null, decisionNote: null, decidedBy: null, photoAt: null, balance: balance("sick", 1.5) },
  { id: "synthetic-leave-2", personId: P(2).id, name: P(2).name, fromDate: shift(TODAY, 6), toDate: shift(TODAY, 8), kind: "annual", status: "pending", halfDay: null, days: 3,
    reason: "Family wedding out of town.", createdAt: ago(5), decidedAt: null, decisionNote: null, decidedBy: null, photoAt: null, balance: balance("annual", 7) },
  { id: "synthetic-leave-3", personId: P(14).id, name: P(14).name, fromDate: shift(TODAY, 2), toDate: shift(TODAY, 2), kind: "annual", status: "pending", halfDay: "second", days: 0.5,
    reason: null, createdAt: ago(0.6), decidedAt: null, decisionNote: null, decidedBy: null, photoAt: null, balance: balance("annual", 0) },
  { id: "synthetic-leave-4", personId: P(5).id, name: P(5).name, fromDate: shift(TODAY, 12), toDate: shift(TODAY, 13), kind: "unpaid", status: "pending", halfDay: null, days: 2,
    reason: "Visa appointment and travel.", createdAt: ago(50), decidedAt: null, decisionNote: null, decidedBy: null, photoAt: null, balance: null },
];
export const regularisations = [
  { id: "synthetic-reg-1", personId: P(1).id, name: P(1).name, date: shift(TODAY, -2), kind: "missed_punch", inTime: "10:02", outTime: "19:14", reason: "Forgot to check out after the client review ran late.", status: "pending", createdAt: ago(20), decidedAt: null, decisionNote: null, decidedBy: null, photoAt: null },
  { id: "synthetic-reg-2", personId: P(6).id, name: P(6).name, date: shift(TODAY, -1), kind: "on_duty", inTime: "07:00", outTime: "15:30", reason: "Synthetic sunrise shoot at the site; travelled straight from home.", status: "pending", createdAt: ago(3), decidedAt: null, decisionNote: null, decidedBy: null, photoAt: null },
];

const excluded = (i, days, labels) => ({ type: "statistics_excluded", personId: P(i).id, name: P(i).name, date: shift(TODAY, -days), detail: `${labels.join("; ")}. Day excluded from averages; review the attendance correction.` });
export const anomalies = [
  excluded(2, 1, ["Session not yet closed", "Over the provisional 12-hour session bound"]),
  excluded(4, 1, ["Session not yet closed", "Over the provisional 12-hour session bound"]),
  excluded(1, 2, ["Check-out needs correction", "Correction awaiting a decision"]),
  excluded(10, 3, ["Over the provisional 12-hour daily bound"]),
  excluded(5, 4, ["Session not yet closed", "Over the provisional 12-hour session bound"]),
  excluded(14, 5, ["Sessions overlap"]),
  excluded(3, 6, ["Break times need review", "Breaks overlap"]),
  { type: "late", personId: P(2).id, name: P(2).name, date: shift(TODAY, -1), detail: "Late 4 times in the last 14 days." },
  { type: "late", personId: P(9).id, name: P(9).name, date: shift(TODAY, -2), detail: "Late 3 times in the last 14 days." },
  { type: "late", personId: P(14).id, name: P(14).name, date: shift(TODAY, -3), detail: "Late 3 times in the last 14 days." },
  { type: "absent", personId: P(10).id, name: P(10).name, date: shift(TODAY, -1), detail: "2 working days without a check-in or approved leave." },
  { type: "absent", personId: P(9).id, name: P(9).name, date: shift(TODAY, -4), detail: "One working day without a check-in or approved leave." },
  { type: "absent", personId: P(13).id, name: P(13).name, date: shift(TODAY, -2), detail: "3 working days without a check-in or approved leave." },
  { type: "long_break", personId: P(3).id, name: P(3).name, date: shift(TODAY, -2), detail: "Breaks added up to 2 h 40 min." },
  { type: "long_break", personId: P(6).id, name: P(6).name, date: shift(TODAY, -5), detail: "Breaks added up to 3 h 5 min." },
];

const trend = Array.from({ length: 14 }, (_, i) => {
  const date = shift(TODAY, i - 13); const sunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
  return { date, present: sunday ? 1 : [9, 10, 8, 11, 9, 7, 10, 11, 9, 8, 10, 9, 11, 7][i], wfh: sunday ? 0 : [1, 2, 1, 0, 2, 1, 1, 2, 0, 1, 2, 1, 1, 1][i], late: sunday ? 0 : [1, 0, 2, 1, 0, 3, 1, 0, 1, 2, 0, 1, 1, 1][i] };
});

export const upcoming = [
  { id: "synthetic-up-1", personId: P(7).id, name: P(7).name, fromDate: shift(TODAY, -1), toDate: shift(TODAY, 1), kind: "annual", status: "approved", halfDay: null, days: 3, reason: null, createdAt: ago(200), decidedAt: ago(190), decisionNote: null, decidedBy: "Synthetic HR" },
  { id: "synthetic-up-2", personId: P(11).id, name: P(11).name, fromDate: shift(TODAY, 4), toDate: shift(TODAY, 4), kind: "comp_off", status: "approved", halfDay: null, days: 1, reason: null, createdAt: ago(100), decidedAt: ago(90), decisionNote: null, decidedBy: "Synthetic HR" },
  { id: "synthetic-up-3", personId: P(3).id, name: P(3).name, fromDate: shift(TODAY, 9), toDate: shift(TODAY, 12), kind: "annual", status: "approved", halfDay: null, days: 4, reason: null, createdAt: ago(300), decidedAt: ago(280), decisionNote: null, decidedBy: "Synthetic HR" },
];
export const holidays = [{ day: "2026-10-20", name: "Synthetic Dussehra", optional: false }, { day: "2026-11-09", name: "Synthetic Diwali (Laxmi Puja)", optional: false }, { day: "2026-11-10", name: "Synthetic Bhai Dooj", optional: true }];

export function desk(me) {
  return {
    attendanceEnabled: true, date: TODAY, today: TODAY, clock: "11:20", policy, day: { kind: "working" },
    attendance: { filter: { version: "provisional-v1", provisional: true, maxMinutes: 720 }, from: shift(TODAY, -13), to: TODAY, recordedDays: 48, eligibleDays: 41, flaggedCount: 7, excludedDays: 7, coverage: 0.85, workedMinutes: 7626, recordedMinutes: 9902, averageMinutes: 186 },
    people: roster,
    counts: { headcount: 14, in: 6, onBreak: 1, done: 1, wfh: 1, late: 1, leave: 2, notIn: 3, canSignIn: 13 },
    pending: { leave: leaveRequests, regularisations }, tickets: { open: 4, unassigned: 2, high: 1 },
    upcoming, holidays, anomalies, trend, types, me,
  };
}
/** The same desk with nothing waiting and nothing unusual: the empty states. */
export function quietDesk(me) {
  return { ...desk(me), pending: { leave: [], regularisations: [] }, anomalies: [], upcoming: [], holidays: [], tickets: { open: 0, unassigned: 0, high: 0 } };
}
export { TODAY };

// ---- The other HR desk tabs ----
const MONTH_DAYS = (month) => { const [y, m] = month.split("-").map(Number); const n = new Date(Date.UTC(y, m, 0)).getUTCDate(); return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`); };
const dateCells = (month) => MONTH_DAYS(month).map((date) => ({ date, off: new Date(`${date}T00:00:00Z`).getUTCDay() === 0, holiday: holidays.find((h) => h.day === date && !h.optional)?.name ?? null }));
const summary = (s) => ({ filter: { version: "provisional-v1", provisional: true, maxMinutes: 720 }, from: "", to: "", recordedDays: s.present, eligibleDays: s.present - s.flagged, flaggedCount: s.flagged, excludedDays: s.flagged, coverage: 0.9, workedMinutes: s.present * 480, recordedMinutes: s.present * 500, averageMinutes: s.present ? 470 + (s.late * 7) % 60 : null, present: s.present, wfh: s.wfh, late: s.late, leave: s.leave, absent: s.absent, missedOut: s.flagged });

export function teamMonth(month) {
  const cells = dateCells(month);
  const rows = people.slice(0, 12).map((p, i) => {
    let present = 0, wfh = 0, late = 0, leave = 0, absent = 0, flagged = 0;
    const days = cells.map((c, d) => {
      const base = { attendance: null, status: "upcoming", mode: null, late: 0, worked: 0, half: false, missedOut: false, open: false };
      if (c.date > TODAY) return base;
      if (c.holiday) return { ...base, status: "holiday" };
      if (c.off) return { ...base, status: "off" };
      if (i === 11) return { ...base, status: "outcome" };
      if (c.date === TODAY) return i < 6 ? { ...base, status: "present", mode: "office", worked: 90, open: true } : { ...base, status: "today" };
      const k = (i * 7 + d * 3) % 23;
      if (k === 4 || (i === 6 && d % 9 === 0)) { leave++; return { ...base, status: "leave", half: k === 4 && i % 2 === 0 }; }
      if (k === 9 && i > 7) { absent++; return { ...base, status: "absent" }; }
      present++; const mode = k % 6 === 1 ? "wfh" : k === 17 ? "field" : "office"; if (mode === "wfh") wfh++;
      const isLate = k % 5 === 2 ? 12 + k : 0; if (isLate) late++;
      const missedOut = k === 13; if (missedOut) flagged++;
      return { ...base, status: "present", mode, late: isLate, worked: 440 + k * 4, missedOut, attendance: { eligible: !missedOut, minutes: missedOut ? null : 440 + k * 4, reasons: missedOut ? ["missed_out"] : [], labels: missedOut ? ["Check-out needs correction"] : [], date: c.date, personId: p.id, sessions: 1, flaggedCount: missedOut ? 1 : 0, recordedMinutes: 440 + k * 4 } };
    });
    return { id: p.id, name: p.name, role: p.role, pod: p.pod, userNo: p.userNo, photoAt: null, trackedFrom: "2026-09-01", canSignIn: i !== 12, summary: summary({ present, wfh, late, leave, absent, flagged }), days };
  });
  return { attendanceEnabled: true, month, from: `${month}-01`, to: cells.at(-1).date, today: TODAY, policy, dates: cells, people: rows };
}

export function teamLeave(month, me) {
  const decided = [
    { ...leaveRequests[0], id: "synthetic-done-1", personId: P(3).id, name: P(3).name, fromDate: shift(TODAY, -20), toDate: shift(TODAY, -19), days: 2, status: "approved", reason: "Synthetic family function.", decidedAt: ago(500), decidedBy: "Synthetic HR", createdAt: ago(520) },
    { ...leaveRequests[1], id: "synthetic-done-2", personId: P(10).id, name: P(10).name, fromDate: shift(TODAY, -6), toDate: shift(TODAY, -6), days: 1, status: "rejected", reason: "Synthetic personal errand.", decidedAt: ago(170), decidedBy: "Synthetic HR", decisionNote: "Two people from the pod are already away that day", createdAt: ago(200) },
    { ...leaveRequests[1], id: "synthetic-done-3", personId: P(4).id, name: P(4).name, fromDate: shift(TODAY, -3), toDate: shift(TODAY, -3), days: 1, kind: "sick", status: "cancelled", reason: null, decidedAt: ago(90), decidedBy: P(4).name, createdAt: ago(100) },
  ];
  const pending = leaveRequests.map(({ balance, ...l }) => l);
  const calendar = [...upcoming, ...pending].filter((l) => l.toDate.slice(0, 7) >= month && l.fromDate.slice(0, 7) <= month);
  return { month, from: `${month}-01`, to: MONTH_DAYS(month).at(-1), today: TODAY, policy, year: 2026, types, holidays, dates: dateCells(month),
    people: people.map((p, i) => ({ ...p, balances: [balance("annual", [7, 4.5, 11, 2, 9, 0, 6.5, 3, 8, 1, 12, 5, 0, 0][i], { used: i % 4 + 1, pending: i === 1 ? 3 : 0 }), balance("sick", [1.5, 3, 2, 0.5, 4, 2, 3, 1, 1.5, 2, 3, 0, 0, 2.5][i])] })),
    requests: [...pending, ...decided], calendar,
    adjustments: [{ id: "synthetic-adj-1", personId: P(5).id, name: P(5).name, kind: "annual", year: 2026, days: 3, reason: "Synthetic opening balance carried from the old sheet", createdAt: ago(900), by: "Synthetic HR" }], me };
}

export function flows(me) {
  const ev = (action, hours, by, note = null) => ({ id: `ev-${action}-${hours}`, action, note, at: ago(hours), by });
  const f = (id, i, kind, subject, from, to, status, stage, extra = {}) => ({ id: `synthetic-flow-${id}`, personId: P(i).id, name: P(i).name, kind, sourceId: `src-${id}`, subject, note: null, details: {}, fromDate: from, toDate: to, status, stage, needsHr: [], decisionNote: null, headName: P(8).name, canDecide: status === "pending", history: [ev("submitted", 30, P(i).name)], ...extra });
  return { me, staff: true, cofounder: false, rows: [
    f("1", 9, "leave", "sick leave", TODAY, TODAY, "pending", "pod_head", { note: leaveRequests[0].reason, details: { days: 1 } }),
    f("2", 2, "leave", "annual leave", shift(TODAY, 6), shift(TODAY, 8), "pending", "hr", { note: "Family wedding out of town.", details: { days: 3, advanceNotice: { late: true, given: 6, required: 14, unit: "days" } }, needsHr: ["long leave"] }),
    f("3", 1, "correction", "missed_punch attendance correction", shift(TODAY, -2), shift(TODAY, -2), "pending", "pod_head", { note: regularisations[0].reason, details: { inTime: "10:02:00", outTime: "19:14:00" } }),
    f("4", 6, "work", `Work on ${shift(TODAY, 3)}`, shift(TODAY, 3), shift(TODAY, 3), "pending", "pod_head", { note: "Synthetic Sunday shoot for the brochure launch." }),
    f("5", 5, "request", "September salary slip shows the wrong bank", TODAY, TODAY, "pending", "hr", { needsHr: ["salary affecting"], note: "The slip lists my old synthetic bank account; please update it before the next run." , history: [ev("submitted", 50, P(5).name), ev("ask", 26, "Synthetic HR", "Please share the new cancelled cheque."), ev("reply", 20, P(5).name, "Uploaded it to the request.")] }),
    f("6", 14, "leave", "unpaid leave", shift(TODAY, 12), shift(TODAY, 13), "pending", "cofounder", { needsHr: ["unpaid leave"], details: { days: 2 }, history: [ev("submitted", 60, P(14).name), ev("forward", 40, "Synthetic HR", "Unpaid leave in the launch week; co-founder to decide.")], canDecide: false }),
    f("7", 3, "leave", "annual leave", shift(TODAY, -20), shift(TODAY, -19), "approved", "pod_head", { details: { days: 2 }, history: [ev("submitted", 600, P(3).name), ev("approved", 580, P(8).name)], canDecide: true, decisionNote: null }),
    f("8", 10, "leave", "annual leave", shift(TODAY, -6), shift(TODAY, -6), "rejected", "hr", { details: { days: 1 }, decisionNote: "Two people from the pod are already away that day", history: [ev("submitted", 200, P(10).name), ev("rejected", 170, "Synthetic HR", "Two people from the pod are already away that day")], canDecide: true }),
    { ...f("9", 8, "leave", "comp_off leave", shift(TODAY, 5), shift(TODAY, 5), "pending", "hr", { details: { days: 1 } }), personId: me, name: "Synthetic Admin", canDecide: false },
  ] };
}

export function flowSettings() {
  const pods = ["Studio", "West pod", "Growth"];
  return { policy: { leave_approver: "pod_head", correction_approver: "pod_head", work_approver: "pod_head", request_approver: "hr", max_leave_days: 2, balance_buffer: 0, comp_credit: 1, comp_expiry_days: 90, reminder_hours: 24 },
    people: people.map((p) => ({ id: p.id, name: p.name, pod: p.pod, managerId: null, photoAt: null, role: p.role })),
    pods: [{ name: "Studio", headId: P(8).id }, { name: "West pod", headId: P(2).id }], cofounders: [{ personId: P(11).id, active: true }],
    patterns: [{ personId: P(6).id, name: P(6).name, workDays: [2, 3, 4, 5, 6, 7], fromDate: "2026-09-01", toDate: null, reason: "Synthetic Sunday shoots" }],
    suggestions: [{ id: "synthetic-sugg-1", title: "Reports to", personId: P(3).id, proposed: { managerId: P(11).id, basis: "Synthetic org chart sheet" }, evidence: null }, { id: "synthetic-sugg-2", title: "Reports to", personId: P(7).id, proposed: { managerId: P(11).id, basis: "Synthetic org chart sheet" }, evidence: null }],
    podNames: pods };
}

export function tickets(me) {
  const t = (no, i, category, subject, priority, status, hours, extra = {}) => ({ id: `synthetic-ticket-${no}`, no, personId: P(i).id, name: P(i).name, photoAt: null, category, subject, priority, status, assigneeId: null, assigneeName: null, createdAt: ago(hours + 5), updatedAt: ago(hours), resolvedAt: null, comments: no % 3, ...extra });
  return { me, staff: true, categories: ["payroll", "leave", "attendance", "equipment", "workplace", "grievance", "other"], assignees: [{ id: me, name: "Synthetic Admin" }, { id: "synthetic-hr", name: "Synthetic HR" }],
    tickets: [
      t(31, 5, "payroll", "September salary slip shows the wrong bank account", "high", "open", 3),
      t(30, 1, "equipment", "Laptop charger stopped working after the synthetic shoot", "normal", "in_progress", 20, { assigneeId: "synthetic-hr", assigneeName: "Synthetic HR" }),
      t(29, 9, "leave", "Can I carry forward leave into next year?", "low", "waiting", 30, { assigneeId: me, assigneeName: "Synthetic Admin" }),
      t(28, 12, "workplace", "Air conditioning in the edit bay is too cold", "normal", "open", 52),
      t(27, 3, "attendance", "Check-in did not register on Monday morning", "normal", "resolved", 90, { assigneeId: "synthetic-hr", assigneeName: "Synthetic HR", resolvedAt: ago(80) }),
      t(26, 7, "other", "Request for an experience letter", "low", "closed", 300, { assigneeId: me, assigneeName: "Synthetic Admin", resolvedAt: ago(290) }),
    ] };
}

export function payroll() {
  return { people: people.map((p) => ({ id: p.id, name: p.name, role: p.role, pod: p.pod, department: p.department, userNo: p.userNo, photoAt: null, status: p.status, joinedOn: p.joinedOn, employmentType: p.employmentType })),
    figures: null, canWrite: true, log: [{ at: ago(30), viewer: "Synthetic HR", people: 14 }, { at: ago(200), viewer: "Synthetic Admin", people: 3 }] };
}

/** The fixture's answer for an HR route, or null to fall through to mock-editors-api.mjs. */
export function route(url, variant, me) {
  const p = url.pathname, month = url.searchParams.get("month") ?? TODAY.slice(0, 7);
  if (p === "/api/v0/hr/attendance") return [200, variant === "hr" ? { ...teamMonth(month), attendanceEnabled: false } : teamMonth(month)];
  if (p === "/api/v0/hr/leave") return [200, teamLeave(month, me)];
  if (p === "/api/v0/hr/flows") return [200, variant === "quiet" ? { ...flows(me), rows: [] } : flows(me)];
  if (p === "/api/v0/hr/flow-settings") return [200, flowSettings()];
  if (p === "/api/v0/hr/tickets") return [200, variant === "quiet" ? { ...tickets(me), tickets: [] } : tickets(me)];
  if (p === "/api/v0/hr/payroll") return [200, payroll()];
  return null;
}

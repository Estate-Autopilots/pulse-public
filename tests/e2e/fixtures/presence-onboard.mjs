// PRESENCE-ONBOARD screenshots: synthetic people and days only (no real staff, no real ID numbers).
// Variants are identities `<variant>@presence.test`: out, arrive, in, break, done, new (employee) and hr.
const TODAY = "2026-10-10";
const NOW = { out: "2026-10-10T04:41:00Z", arrive: "2026-10-10T04:24:00Z", in: "2026-10-10T07:12:00Z", break: "2026-10-10T08:05:00Z", done: "2026-10-10T13:52:00Z", new: "2026-10-10T04:41:00Z", hr: "2026-10-10T07:12:00Z" };
const OFFICE = { id: "00000000-0000-4000-8000-0000000000a1", name: "Baner Studio", lat: 18.559, lng: 73.786, radius: 150, wifi: [{ ssid: "Synthetic-Studio", bssids: [] }], publicIpRanges: [], test: false };
const IN_AT = "2026-10-10T04:26:00Z";
export const employee = (v) => !["hr"].includes(v);
export const personId = (v) => v === "hr" ? "synthetic-hr" : "synthetic-sam";

const entry = (v) => v === "in" ? { id: "e-today", date: TODAY, in: IN_AT, out: null, mode: "office", late: 0, missedOut: false, onBreak: false, breakStartedAt: null, closedBreakSeconds: 0 }
  : v === "break" ? { id: "e-today", date: TODAY, in: IN_AT, out: null, mode: "office", late: 0, missedOut: false, onBreak: true, breakStartedAt: "2026-10-10T07:40:00Z", closedBreakSeconds: 0 }
  : v === "done" ? { id: "e-today", date: TODAY, in: IN_AT, out: "2026-10-10T13:45:00Z", mode: "office", late: 0, missedOut: false, onBreak: false, breakStartedAt: null, closedBreakSeconds: 35 * 60 } : null;

export function companion(v) {
  const state = v === "in" ? "in" : v === "break" ? "break" : v === "done" ? "done" : "out";
  return {
    attendanceEnabled: true, person: { id: personId(v), name: v === "hr" ? "Synthetic HR" : "Synthetic Sam", firstName: v === "hr" ? "Synthetic" : "Sam" },
    now: NOW[v] ?? NOW.in, today: TODAY, clock: "12:42", timezone: "Asia/Kolkata", utcOffsetMinutes: 330,
    shift: { start: "10:00", end: "19:00", graceMinutes: 15, onTimeBy: "10:15", workingDay: true, mode: "office" },
    shiftStartsAt: "2026-10-10T04:30:00Z", shiftEndsAt: "2026-10-10T13:30:00Z", state, holiday: null, entry: entry(v),
    nextShift: null, upcoming: [], streak: { onTime: v === "new" ? 0 : 4, firstCheckIn: false }, waiting: v === "hr" ? { count: 3, href: "/me/approvals" } : null,
    presence: { dwellMinutes: 3, leaveMinutes: 15, autoCheckIn: false, offices: [OFFICE], sites: [] }, links: { desk: "/me", corrections: "/me?tab=attendance" },
    week: v === "new" ? { onTime: 0, late: 0, missed: 0, days: [{ date: "2026-10-05", state: "off" }, { date: "2026-10-06", state: "off" }, { date: "2026-10-07", state: "off" }, { date: "2026-10-08", state: "off" }, { date: "2026-10-09", state: "off" }, { date: TODAY, state: "today" }] }
      : { onTime: 4 + (state === "out" ? 0 : 1), late: 1, missed: 0, days: [{ date: "2026-10-05", state: "on_time" }, { date: "2026-10-06", state: "on_time" }, { date: "2026-10-07", state: "late" },
        { date: "2026-10-08", state: "on_time" }, { date: "2026-10-09", state: "on_time" }, { date: TODAY, state: state === "out" ? "today" : "on_time" }] },
    arrival: v === "arrive" ? { at: "2026-10-10T04:23:00Z", office: OFFICE.name } : null,
  };
}

const policy = { shiftStart: "10:00", shiftEnd: "19:00", graceMinutes: 15, workDays: [1, 2, 3, 4, 5, 6], wfhPerMonth: 4, leaveYearStart: 4, trackingFrom: "2026-10-01", confirmedAt: "2026-09-30T10:00:00Z" };
const leaveType = { key: "paid", name: "Paid leave", paid: true, annualDays: 18, accrual: "monthly", carryForwardMax: 6, active: true };
const mk = (date, inUtc, outUtc, late = 0, mode = "office", missedOut = false) => ({ id: `e-${date}`, personId: "synthetic-sam", date, in: `${date}T${inUtc}:00Z`, out: outUtc ? `${date}T${outUtc}:00Z` : null, mode, late, missedOut, source: "self", note: null, breakMinutes: 40, onBreak: false, worked: outUtc ? 505 : 0 });
const ENTRIES = { "2026-10-01": mk("2026-10-01", "04:25", "13:40"), "2026-10-03": mk("2026-10-03", "04:20", "13:35"), "2026-10-05": mk("2026-10-05", "04:28", "13:31"),
  "2026-10-06": mk("2026-10-06", "04:29", "13:50"), "2026-10-07": mk("2026-10-07", "05:02", "13:58", 32), "2026-10-08": mk("2026-10-08", "04:24", null, 0, "office", true), "2026-10-09": mk("2026-10-09", "04:27", "13:33", 0, "wfh") };
function days(v) {
  const out = [];
  for (let d = 1; d <= 31; d++) {
    const date = `2026-10-${String(d).padStart(2, "0")}`, wd = new Date(`${date}T00:00:00Z`).getUTCDay();
    const e = v === "new" ? null : ENTRIES[date] ?? (date === TODAY ? entry(v) && { ...mk(TODAY, "04:26", null), ...entry(v), personId: "synthetic-sam", source: "self", note: null, breakMinutes: 0, worked: 0 } : null);
    const status = date > TODAY ? "upcoming" : date === TODAY ? (e ? "present" : "today") : wd === 0 ? "off" : date === "2026-10-02" ? "holiday" : date === "2026-10-04" ? "off" : e ? "present" : v === "new" ? "untracked" : "absent";
    out.push({ date, status, holiday: date === "2026-10-02" ? "Gandhi Jayanti" : null, entry: e, sessions: e ? [e] : [], attendance: e ? { date, personId: "synthetic-sam", sessions: 1, flaggedCount: e.missedOut ? 1 : 0, recordedMinutes: e.worked, eligible: !e.missedOut, minutes: e.worked, reasons: e.missedOut ? ["missed_out"] : [], labels: e.missedOut ? ["Check-out not recorded"] : [] } : null,
      leave: null, pendingLeave: false, automaticHalfDay: date === "2026-10-07" });
  }
  return out;
}
const summary = (v) => ({ filter: { version: "synthetic", provisional: true, maxMinutes: 720 }, from: "2026-10-01", to: "2026-10-31", recordedDays: v === "new" ? 0 : 7, eligibleDays: v === "new" ? 0 : 6, flaggedCount: v === "new" ? 0 : 1, excludedDays: 0, coverage: v === "new" ? null : 0.86,
  workedMinutes: v === "new" ? 0 : 3030, recordedMinutes: 3030, averageMinutes: v === "new" ? null : 505, present: v === "new" ? 0 : 7, wfh: v === "new" ? 0 : 1, late: v === "new" ? 0 : 1, leave: 0, absent: v === "new" ? 0 : 0, missedOut: v === "new" ? 0 : 1 });

export function hrSelf(v) {
  const e = entry(v);
  return {
    attendanceEnabled: true, reconciliation: null, rules: { late: null },
    person: { id: personId(v), name: "Synthetic Sam", role: "Video editor", pod: "Pod 2", department: "Creative", userNo: 12, photoAt: null, status: "active", joinedOn: "2025-06-01", managerId: null, managerName: "Synthetic Lead", skills: [], employmentType: "full_time", username: "synthetic.sam" },
    self: true, today: TODAY, clock: "12:42", policy,
    can: { act: true, decide: false, record: false, performance: false, adjust: false },
    now: { state: e ? (e.out ? "done" : e.onBreak ? "break" : "in") : "out", entry: e ? { ...mk(TODAY, "04:26", e.out ? "13:45" : null), onBreak: e.onBreak, worked: e.out ? 524 : e.onBreak ? 194 : 166, breakMinutes: e.onBreak ? 25 : 0 } : null, holiday: null, leave: null },
    month: { key: "2026-10", from: "2026-10-01", to: "2026-10-31", days: days(v), summary: summary(v), trackedFrom: v === "new" ? null : "2026-10-01" },
    wfh: { used: v === "new" ? 0 : 1, allowance: 4 },
    leave: { year: 2026, yearStartsMonth: 4, provisional: false, trackingFrom: "2026-04-01", types: [leaveType], balances: [{ key: "paid", accrued: 9, carried: 2, adjusted: 0, used: 3, pending: 0, available: 8 }], requests: [] },
    regularisations: v === "new" ? [] : [{ id: "r-1", personId: "synthetic-sam", name: "Synthetic Sam", date: "2026-10-08", kind: "missed_punch", inTime: "09:54", outTime: "19:05", reason: "Forgot to check out after the shoot", status: "pending", createdAt: "2026-10-09T05:00:00Z", decidedAt: null, decisionNote: null, decidedBy: null }],
    tickets: [], away: [], holidays: [{ day: "2026-10-20", name: "Diwali (Lakshmi Puja)", optional: false }], performance: null, team: [], approvals: { leave: [], regularisations: [] },
    payroll: v === "new" ? { month: "2026-10", cutoffDay: 26, cutoffDate: "2026-10-26", closed: false, daysLeft: 16, present: 0, wfh: 0, late: 0, leave: 0, absent: 0, missedOut: 0, halfDays: 0, pendingCorrections: 0, pendingLeave: 0 }
      : { month: "2026-10", cutoffDay: 26, cutoffDate: "2026-10-26", closed: false, daysLeft: 16, present: 7, wfh: 1, late: 1, leave: 0, absent: 0, missedOut: 1, halfDays: 1, pendingCorrections: 1, pendingLeave: 0 },
  };
}

export function day(v) {
  if (v === "new") return { attendanceEnabled: true, date: TODAY, today: TODAY, self: true, sessions: [], events: [], corrections: [] };
  const e = entry(v) ?? (v === "arrive" ? null : null);
  const sessions = e ? [{ id: "e-today", in: IN_AT, out: e.out, mode: "office", late: 0, source: "self", inVia: "mobile", inTrigger: v === "done" ? "auto" : "suggested", inQueued: false,
    outVia: e.out ? "desktop" : null, outTrigger: e.out ? "manual" : null, outQueued: false, office: v === "done" ? OFFICE.name : null,
    breaks: v === "break" ? [{ id: "b1", start: "2026-10-10T07:40:00Z", end: null }] : e.out || v === "in" ? [{ id: "b1", start: "2026-10-10T07:35:00Z", end: "2026-10-10T08:10:00Z" }] : [] }] : [];
  const events = [{ id: "ev1", at: "2026-10-10T04:23:00Z", kind: "arrival_asked", detail: null, signals: ["wifi"], office: OFFICE.name, device: "phone", entryId: null, correctionId: null, disputedAt: null, disputeId: null }];
  if (v === "done") events.push({ id: "ev2", at: IN_AT, kind: "auto_check_in", detail: null, signals: ["geofence", "wifi"], office: OFFICE.name, device: "phone", entryId: "e-today", correctionId: null, disputedAt: null, disputeId: null },
    { id: "ev3", at: "2026-10-10T13:20:00Z", kind: "reminder", detail: "end", signals: ["schedule"], office: null, device: null, entryId: null, correctionId: null, disputedAt: null, disputeId: null });
  if (v === "break") events.push({ id: "ev4", at: "2026-10-10T08:01:00Z", kind: "reminder", detail: "break", signals: ["schedule"], office: null, device: null, entryId: null, correctionId: null, disputedAt: null, disputeId: null });
  return { attendanceEnabled: true, date: TODAY, today: TODAY, self: true, sessions, events, corrections: [] };
}

const KINDS = [{ kind: "aadhaar", label: "Aadhaar (masked)", required: true, idNumber: "aadhaar", sort: 10, active: true }, { kind: "pan", label: "PAN card", required: true, idNumber: "pan", sort: 20, active: true },
  { kind: "bank_proof", label: "Cancelled cheque or passbook", required: false, idNumber: null, sort: 30, active: true }];
export function onboarding(v, who = personId(v)) {
  const fresh = v === "new";
  return {
    person: { id: who, name: "Synthetic Sam", firstName: "Sam", role: "Video editor", pod: "Pod 2", joinedOn: "2025-06-01", workPhone: "+91 90000 00010", photo: !fresh },
    self: who === personId(v), canSeeDetails: true, canSeeIds: true,
    details: fresh ? { personalPhone: null, personalEmail: null } : { dob: "1997-03-14", address: "Flat 4, Synthetic Lane, Baner", city: "Pune", pincode: "411045", personalPhone: "+91 90000 00010", personalEmail: "sam.home@example.test", emergencyName: "Synthetic Parent", emergencyRelation: "Parent", emergencyPhone: "+91 90000 00011" },
    bank: fresh ? null : "Example Bank ••••6789",
    documents: KINDS.map(({ kind, label, required, idNumber }) => ({ kind, label, required, idNumber,
      document: fresh ? null : kind === "aadhaar" ? { id: "d-aadhaar", status: "verified", source: "self", addedAt: "2026-10-09T06:00:00Z", checkedAt: "2026-10-09T09:00:00Z", masked: "XXXX XXXX 0124", hasFile: true, fileName: "aadhaar-masked.pdf", mime: "application/pdf", size: 120000, drive: null, note: null }
        : kind === "pan" ? null : null })),
    steps: fresh ? {} : { welcome: { state: "done", at: "2026-10-09T05:00:00Z" }, details: { state: "done", at: "2026-10-09T05:02:00Z" }, bank: { state: "done", at: "2026-10-09T05:04:00Z" } },
    consent: fresh ? {} : { version: "arrival-v1", at: "2026-10-09T05:06:00Z", auto: false, withdrawnAt: null },
    notice: null, apps: { phone: !fresh, desktop: false, chrome: false },
    missing: fresh ? ["dob", "phone", "email", "address", "emergency", "bank", "photo", "doc:aadhaar", "doc:pan"] : ["doc:pan"], percent: fresh ? 0 : 89, completedAt: null,
    proposals: fresh ? [{ id: "p1", field: "dob", value: "1997-03-14", documentKind: null, source: "hr_sheet", sourceLabel: "HR sheet · Employee details 2025 (row 12)", proposedAt: "2026-10-10T03:00:00Z" },
      { id: "p2", field: "personalEmail", value: "sam.home@example.test", documentKind: null, source: "roster", sourceLabel: "Joining form · Synthetic Sam", proposedAt: "2026-10-10T03:00:00Z" }]
      : [{ id: "p3", field: "document", value: null, documentKind: "pan", source: "drive", sourceLabel: "Drive · HR/KYC/Synthetic Sam/PAN.pdf", proposedAt: "2026-10-10T03:00:00Z" }],
    attendanceEnabled: true, filesReady: true,
  };
}

const NAMES = ["Aarav Synthetic", "Beheze Synthetic", "Cudula Synthetic", "Dopar Synthetic", "Eshan Synthetic", "Farah Synthetic", "Gikavi Synthetic", "Hazez Synthetic", "Ishaan Synthetic", "Jaya Synthetic", "Kehob Synthetic", "Lata Synthetic", "Mugin Synthetic", "Neha Synthetic"];
const ROLES = ["Video editor", "Designer", "Videographer", "Sales", "Editor", "Ops"];
export function roster() {
  const people = NAMES.map((name, i) => {
    const stage = i % 7; // 0 not invited, 1 invited, 2 profile 30%, 3 profile 70%, 4 no app, 5 never checked in, 6 ready
    return { id: `00000000-0000-4000-8000-${String(100 + i).padStart(12, "0")}`, name, role: ROLES[i % ROLES.length], pod: `Pod ${(i % 3) + 1}`, joinedOn: "2025-0" + ((i % 9) + 1) + "-01",
      invite: stage === 0 ? null : { status: stage === 1 ? "sent" : "used", at: "2026-10-09T05:00:00Z", blocked: null }, canSignIn: stage !== 0,
      signedInAt: stage >= 2 ? "2026-10-09T06:00:00Z" : null, missing: stage === 2 ? ["dob", "address", "bank", "doc:aadhaar", "doc:pan", "photo"] : stage === 3 ? ["bank", "doc:pan"] : stage < 2 ? ["dob", "phone", "email", "address", "emergency", "bank", "photo", "doc:aadhaar", "doc:pan"] : [],
      percent: stage === 2 ? 33 : stage === 3 ? 78 : stage < 2 ? 0 : 100,
      apps: { phone: stage >= 5, desktop: stage === 6 && i % 2 === 0, chrome: stage === 6 && i % 3 === 0 }, firstCheckIn: stage === 6 ? "2026-10-09" : stage === 3 ? "2026-10-10" : null, lastCheckIn: stage === 6 ? TODAY : null,
      outcome: false, consent: stage >= 4, nudged: stage === 5 && i === 5 ? { checkin: "2026-10-10T05:30:00Z" } : null, proposals: stage === 2 ? 2 : 0, completedAt: stage >= 4 ? "2026-10-09T08:00:00Z" : null };
  });
  return { people, kinds: KINDS, sendEnabled: false, canEdit: true, settings: checkinSettings(), filesReady: true };
}
export function checkinSettings() {
  return { arrival: "ask", dwellMinutes: 3, leaveMinutes: 15, cutoffDay: 26, onboardingReminders: true, shift: { start: "10:00", end: "19:00" },
    reminders: { enabled: true, approvedBy: "HR: Synthetic HR · 2026-10-10", startOffset: 0, longBreak: 60 }, offices: { count: 1, withNetworks: 1 }, attendanceEnabled: true, canEdit: true };
}

/** The API answers for this round; anything else goes on to the shared mock. */
export function route(url, v) {
  const p = url.pathname;
  if (p === "/api/v0/companion") return [200, companion(v)];
  if (p === "/api/v0/hr/self" && employee(v)) return [200, hrSelf(v)];
  if (p === "/api/v0/attendance/day") return [200, day(v)];
  if (p === "/api/v0/onboarding") return [200, onboarding(v)];
  const one = p.match(/^\/api\/v0\/onboarding\/([^/]+)$/);
  if (one) { const r = roster().people.find((x) => x.id === one[1]); const s = onboarding("in", one[1]); return [200, r ? { ...s, self: false, person: { ...s.person, name: r.name, firstName: r.name.split(" ")[0], role: r.role, pod: r.pod } } : s]; }
  if (p === "/api/v0/hr/onboard") return [200, roster()];
  if (p === "/api/v0/hr/checkin-settings") return [200, checkinSettings()];
  if (p === "/api/v0/hr/work-calendar") return [200, { days: [], patterns: [], requests: [] }];
  return null;
}

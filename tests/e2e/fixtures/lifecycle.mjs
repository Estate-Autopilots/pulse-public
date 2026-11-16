// LIFECYCLE screenshots on wholly invented data (no real names, no real figures): People moves, the joining and leaving
// checklists, the alumni directory, value against cost, role seats, staffing gaps and My Pulse. Served by
//   ea-heavy node tests/e2e/hr-polish-shots.mjs --fixtures lifecycle --serve <port>
// in front of mock-editors-api.mjs.
const TODAY = "2026-10-11";
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const iso = (date, hm = "11:00") => new Date(`${date}T${hm}:00+05:30`).toISOString();
const MONTH = TODAY.slice(0, 7);

const PEOPLE = [
  ["lc-asha", "Asha Rao", "Video editor", "West pod", "Creative", "2024-11-04"], ["lc-dev", "Dev Malhotra", "Video editor", "West pod", "Creative", "2026-08-03"],
  ["lc-meera", "Meera Iyer", "Senior designer", "Studio", "Creative", "2023-06-12"], ["lc-kabir", "Kabir Shah", "Performance marketer", "Growth", "Performance", "2025-02-17"],
  ["lc-nisha", "Nisha Pillai", "Shoot coordinator", "Studio", "Production", "2025-09-01"], ["lc-rifob", "Rifob Das", "Performance marketer", "Growth", "Performance", "2024-04-22"],
  ["lc-tara", "Tara Seduh", "Client servicing", "West pod", "Operations", "2025-12-08"], ["lc-vikram", "Vikram Jivop", "Pod head", "West pod", "Creative", "2022-09-05"],
  ["lc-leela", "Leela Nair", "HR", null, "Operations", "2023-01-09"], ["lc-ahoro", "Ahoro Menon", "Videographer", "Studio", "Production", "2025-05-19"],
  ["lc-zoya", "Zoya Khan", "Motion designer", "Studio", "Creative", "2026-09-22"], ["lc-ishaan", "Ishaan Bose", "Graphic designer", "West pod", "Creative", "2024-02-12"],
].map(([id, name, role, pod, department, joinedOn]) => ({ id, name, role, pod, department, joinedOn, photoAt: null }));
const P = Object.fromEntries(PEOPLE.map((p) => [p.id, p]));
const brief = (id) => { const p = P[id]; return { id: p.id, name: p.name, role: p.role, pod: p.pod, department: p.department, photoAt: null }; };
const ALUMNI = [
  { id: "lc-farah", name: "Farah Qipedot", role: "Graphic designer", pod: "West pod", department: "Creative", joinedOn: "2023-03-06", leftOn: "2026-08-29", leftType: "resigned" },
  { id: "lc-omi", name: "Omi Kireteso", role: "Production head", pod: "Studio", department: "Production", joinedOn: "2022-11-14", leftOn: "2026-04-15", leftType: "resigned" },
  { id: "lc-pia", name: "Pia Sen", role: "Video editor", pod: "West pod", department: "Creative", joinedOn: "2025-01-20", leftOn: "2026-03-31", leftType: "terminated" },
  { id: "lc-sana", name: "Sana Mirza", role: "Performance marketer", pod: "Growth", department: "Performance", joinedOn: "2024-08-05", leftOn: "2026-05-31", leftType: "resigned" },
];

const reason = (source, kind, summary, on, weight, lastDay = null) => ({ source, kind, summary, on, weight, lastDay });
const moves = {
  today: TODAY, pods: ["Growth", "Studio", "West pod"],
  counts: { candidate: 2, offer: 1, joining: 1, probation: 2, active: 31, notice: 1, left: 14 },
  cases: [
    { id: "lc-case-leave", kind: "leaving", effectiveOn: shift(TODAY, 5), leftType: "resigned", person: brief("lc-ishaan"), done: 4, total: 9, next: "settlement" },
    { id: "lc-case-join", kind: "joining", effectiveOn: "2026-09-22", leftType: null, person: brief("lc-zoya"), done: 4, total: 7, next: "domains" },
  ],
  review: [
    { personId: "lc-kabir", name: "Kabir Shah", role: "Performance marketer", pod: "Growth", photoAt: null, status: "open", confidence: "high", proposedOn: "2026-09-30", proposedType: "resigned", alreadyInactive: false,
      reasons: [reason("mail", "resigned", "Resignation mail to HR, 21 Sep 2026 (last working day 30 Sep 2026)", "2026-09-21", 3, "2026-09-30"), reason("attendance", "quiet", "No check-in in the last two weeks while the team checks in", TODAY, 1),
        reason("roster", "not_listed", "Not on the roster import of 5 Oct 2026", "2026-10-05", 1)], openedAt: iso("2026-10-11"), refreshedAt: iso(TODAY) },
    { personId: "lc-tara", name: "Tara Seduh", role: "Client servicing", pod: "West pod", photoAt: null, status: "open", confidence: "medium", proposedOn: "2026-07-31", proposedType: null, alreadyInactive: false,
      reasons: [reason("hr_sheet", "absent", "Not on the latest salary sheet (Sep 2026); last on Jul 2026", "2026-08-01", 2), reason("work", "quiet", "Nothing recorded in Pulse since 28 Jul 2026", "2026-07-28", 1)], openedAt: iso("2026-10-11"), refreshedAt: iso(TODAY) },
    { personId: "lc-ahoro", name: "Ahoro Menon", role: "Videographer", pod: "Studio", photoAt: null, status: "open", confidence: "low", proposedOn: "2026-09-01", proposedType: null, alreadyInactive: false,
      reasons: [reason("workspace", "no_signin", "No Workspace sign-in since 1 Sep 2026", "2026-09-01", 2)], openedAt: iso("2026-10-11"), refreshedAt: iso(TODAY) },
    { personId: "lc-omi", name: "Omi Kireteso", role: "Production head", pod: "Studio", photoAt: null, status: "open", confidence: "high", proposedOn: "2026-04-13", proposedType: "resigned", alreadyInactive: true,
      reasons: [reason("mail", "resigned", "Resignation mail to HR, 14 Mar 2026", "2026-03-14", 3), reason("hr_sheet", "absent", "Not on the latest salary sheet (Sep 2026); last on Mar 2026", "2026-04-01", 2)], openedAt: iso("2026-10-11"), refreshedAt: iso(TODAY) },
    { personId: "lc-pia", name: "Pia Sen", role: "Video editor", pod: "West pod", photoAt: null, status: "open", confidence: "high", proposedOn: "2026-03-23", proposedType: "terminated", alreadyInactive: true,
      reasons: [reason("mail", "terminated", "Termination notice from HR, 23 Mar 2026", "2026-03-23", 3)], openedAt: iso("2026-10-11"), refreshedAt: iso(TODAY) },
  ],
  decided: [{ personId: "lc-rifob", name: "Rifob Das", status: "dismissed", note: "Resignation withdrawn on 25 Aug; still working", decidedAt: iso("2026-10-11"), by: "Leela Nair" }],
  unmatched: [{ name: "Kedab Dendge", kind: "resigned", on: "2024-11-22", summary: "Resignation mail to HR, 22 Nov 2024" }],
  lastScan: iso(TODAY, "09:40"),
  pipeline: [
    { ...brief("lc-dev"), status: "active", stage: "probation", since: "2026-08-03", leftType: null, leftOn: null, lastWorkingDay: null, joinedOn: "2026-08-03" },
    { id: "lc-cand-1", name: "Rhea Kapoor", role: "Motion designer", pod: "Studio", department: "Creative", photoAt: null, status: "inactive", stage: "offer", since: "2026-10-09", leftType: null, leftOn: null, lastWorkingDay: null, joinedOn: null },
    { id: "lc-cand-2", name: "Samir Gill", role: "Video editor", pod: "West pod", department: "Creative", photoAt: null, status: "inactive", stage: "candidate", since: "2026-10-10", leftType: null, leftOn: null, lastWorkingDay: null, joinedOn: null },
    { ...brief("lc-zoya"), status: "active", stage: "joining", since: "2026-09-22", leftType: null, leftOn: null, lastWorkingDay: null, joinedOn: "2026-09-22" },
    { ...brief("lc-ishaan"), status: "active", stage: "notice", since: "2026-09-17", leftType: null, leftOn: null, lastWorkingDay: shift(TODAY, 5), joinedOn: "2024-02-12" },
  ],
  alumni: ALUMNI.map((a) => ({ ...a, status: "inactive", stage: "left", since: a.leftOn, lastWorkingDay: a.leftOn, photoAt: null })),
  moves: [
    { id: "m1", personId: "lc-rifob", name: "Rifob Das", kind: "review", from: null, to: null, on: "2026-10-11", leftType: null, detail: { decision: "dismissed" }, note: "Resignation withdrawn", at: iso("2026-10-11", "10:12"), by: "Leela Nair" },
    { id: "m2", personId: "lc-cand-1", name: "Rhea Kapoor", kind: "stage", from: "candidate", to: "offer", on: "2026-10-09", leftType: null, detail: {}, note: "Offer sent by mail", at: iso("2026-10-09", "16:40"), by: "Leela Nair" },
    { id: "m3", personId: "lc-zoya", name: "Zoya Khan", kind: "stage", from: "offer", to: "joining", on: "2026-09-22", leftType: null, detail: {}, note: null, at: iso("2026-09-22", "10:05"), by: "Leela Nair" },
    { id: "m4", personId: "lc-ishaan", name: "Ishaan Bose", kind: "stage", from: "active", to: "notice", on: "2026-09-17", leftType: null, detail: { lastWorkingDay: shift(TODAY, 5) }, note: "Moving to Bengaluru", at: iso("2026-09-17", "12:30"), by: "Leela Nair" },
    { id: "m5", personId: "lc-meera", name: "Meera Iyer", kind: "change", from: null, to: null, on: "2026-09-02", leftType: null, detail: { pod: { from: "West pod", to: "Studio" } }, note: null, at: iso("2026-09-02", "09:30"), by: "Vikram Jivop" },
    { id: "m6", personId: "lc-farah", name: "Farah Qipedot", kind: "stage", from: "notice", to: "left", on: "2026-08-29", leftType: "resigned", detail: {}, note: null, at: iso("2026-08-29", "18:10"), by: "Leela Nair" },
  ],
  can: { act: true, review: true },
};

const step = (key, status, pending, proposal, extra = {}) => ({ key, status, pending, confirmed: status !== "todo" && !extra.auto, auto: false, proposal, result: {}, note: null, doneBy: status === "done" ? "Leela Nair" : null, doneAt: status === "done" ? iso("2026-10-10") : null, ...extra });
const staff = PEOPLE.filter((p) => !["lc-ishaan", "lc-kabir"].includes(p.id)).map((p) => ({ ...brief(p.id) }));
const leaving = {
  id: "lc-case-leave", kind: "leaving", status: "open", effectiveOn: shift(TODAY, 5), leftType: "resigned", note: "Moving to Bengaluru", openedAt: iso("2026-09-17"), openedBy: "Leela Nair", closedAt: null,
  person: { ...brief("lc-ishaan"), stage: "notice" }, done: 4, total: 9, canAct: true, canWorkspace: true, people: staff,
  steps: [
    step("work", "todo", 4, { tasks: [
      { id: "t1", title: "Festive carousel for Skyline Homes", status: "in_progress", dueAt: iso(shift(TODAY, 2), "18:00"), project: "Skyline Homes launch", claimed: false, to: brief("lc-meera") },
      { id: "t2", title: "Brochure revisions, round 2", status: "open", dueAt: iso(shift(TODAY, 4), "18:00"), project: "Harbour Point", claimed: false, to: brief("lc-meera") },
      { id: "t3", title: "Logo lock-ups for Palm Grove", status: "open", dueAt: null, project: "Palm Grove", claimed: true, to: null },
    ], reviews: [{ id: "t4", title: "Story frames for the site visit reel", status: "done", to: brief("lc-vikram") }], imported: 12 }),
    step("projects", "todo", 2, { owned: [{ id: "pr1", name: "Brand refresh: Harbour Point", kind: "internal", to: brief("lc-vikram") }], memberOf: 3 }),
    step("pods", "todo", 3, { pod: "West pod", manager: "Vikram Jivop", reports: [], heads: [], roles: ["pgs"], domains: [{ id: "d1", title: "Static design for West pod clients" }] }),
    step("settlement", "todo", 1, { lastWorkingDay: shift(TODAY, 5), leaveKind: "annual", leaveDays: 4.5, noticeRequiredDays: 30, noticeServedDays: 31, noticeRecoveryDays: 0, compOffDays: 1, settlementBy: shift(TODAY, 50), ruleConfirmed: false }),
    step("assets", "done", 0, { items: [{ name: "Computer: Studio iMac 3", returned: true }, { name: "Company ID card", returned: true }, { name: "Drawing tablet", returned: true }] }),
    step("access", "todo", 3, { credential: true, sessions: 2, appTokens: 1, devices: 1 }),
    step("chats", "todo", 4, { groups: [{ id: "g1", name: "West pod", kind: "pod" }, { id: "g2", name: "Creative", kind: "team" }, { id: "g3", name: "Festive campaign", kind: "custom" }, { id: "g4", name: "team@", kind: "group" }] }),
    step("workspace", "todo", 2, { accounts: ["ishaan@example.test"], groups: ["creative@example.test", "pod2@example.test"], ticks: { suspend: { by: "Synthetic Admin", at: iso("2026-10-11") }, drive: { by: "Synthetic Admin", at: iso("2026-10-11") } } }),
    step("alumni", "todo", 1, { stage: "notice", on: shift(TODAY, 5), leftType: "resigned" }),
  ],
};
leaving.steps[0].status = "done"; leaving.steps[0].pending = 0; leaving.steps[0].doneBy = "Leela Nair"; leaving.steps[0].doneAt = iso("2026-10-10"); leaving.steps[0].proposal = { tasks: [], reviews: [], imported: 12 };
leaving.steps[1].status = "done"; leaving.steps[1].pending = 0; leaving.steps[1].doneBy = "Leela Nair"; leaving.steps[1].proposal = { owned: [], memberOf: 0 };
leaving.steps[2].status = "done"; leaving.steps[2].pending = 0; leaving.steps[2].proposal = { pod: null, manager: null, reports: [], heads: [], roles: [], domains: [] };
const joining = {
  id: "lc-case-join", kind: "joining", status: "open", effectiveOn: "2026-09-22", leftType: null, note: null, openedAt: iso("2026-09-22"), openedBy: "Leela Nair", closedAt: null,
  person: { ...brief("lc-zoya"), stage: "joining" }, done: 4, total: 7, canAct: true, canWorkspace: true, people: staff, categories: { motion: "Motion graphics", video_edit: "Video editing" },
  steps: [
    step("record", "done", 0, { role: "Motion designer", pod: "Studio", department: "Creative", joinedOn: "2026-09-22", manager: "Meera Iyer" }, { auto: true, confirmed: false }),
    step("invite", "done", 0, { credential: "active", invitation: "used", workspace: false }, { auto: true, confirmed: false }),
    step("welcome", "todo", 1, { completedAt: null, seenAt: iso("2026-09-22", "10:30") }),
    step("groups", "done", 0, { pod: "Studio", department: "Creative", suggested: { pod: "Studio", department: "Creative" }, groups: ["Studio", "Creative", "team@"] }, { auto: true, confirmed: false }),
    step("domains", "todo", 1, { current: [], suggested: ["motion", "video_edit"] }),
    step("payroll", "done", 0, { payrollFrom: "2026-09-22", suggested: "2026-09-22" }),
    step("probation", "todo", 1, { from: null, to: null, suggestedFrom: "2026-09-22", suggestedTo: "2026-12-21", stage: "joining" }),
  ],
};

const trend = (base) => [0, 1, 2, 3, 4, 5].map((k) => ({ month: `2026-${String(5 + k).padStart(2, "0")}-01`, ratio: Math.max(0, Math.round((base + Math.sin(k + base * 3) * 0.6) * 100) / 100) }));
const vrow = (id, cost, value, linked, tasks, accepted, deliveries, onTime, withDue, band, confidence, tenureDays, allowance = 1, returned = 0) => ({ person: { ...P[id], stage: id === "lc-ishaan" ? "notice" : "active" },
  cost, value, linked, pooled: value - linked, ratio: cost ? Math.round((value / cost) * 100) / 100 : null, units: tasks + deliveries, points: accepted * 3, tasks, accepted, deliveries, returned,
  acceptRate: tasks ? Math.round((accepted / tasks) * 100) / 100 : null, onTimeRate: withDue ? Math.round((onTime / withDue) * 100) / 100 : null, withDue, tenureDays, band: { band, allowance }, confidence, trend: trend(cost ? value / cost : 0) });
const value = {
  month: `${MONTH}-01`,
  company: { revenue: 1840000, linkedRevenue: 1290000, coverage: 0.7, cost: 812000, value: 1840000, median: 2.1, people: 12, withCost: 12 },
  rows: [
    vrow("lc-ahoro", 42000, 118000, 96000, 14, 12, 22, 9, 11, "strong", "high", 510),
    vrow("lc-asha", 48000, 164000, 141000, 21, 19, 30, 15, 17, "strong", "high", 707),
    vrow("lc-dev", 36000, 61000, 44000, 9, 7, 11, 5, 8, "on_par", "medium", 70, 0.75),
    vrow("lc-ishaan", 52000, 71000, 52000, 8, 6, 9, 3, 7, "below", "medium", 973, 1, 2),
    vrow("lc-kabir", 61000, 140000, 120000, 12, 11, 0, 8, 10, "on_par", "high", 602),
    vrow("lc-leela", 55000, 0, 0, 0, 0, 0, 0, 0, "not_measured", "low", 1372),
    vrow("lc-meera", 74000, 233000, 201000, 24, 23, 36, 20, 22, "strong", "high", 1218),
    vrow("lc-nisha", 39000, 66000, 30000, 11, 9, 0, 7, 9, "on_par", "medium", 406, 1, 1),
    vrow("lc-rifob", 58000, 152000, 133000, 13, 12, 0, 10, 12, "on_par", "high", 903),
    vrow("lc-tara", 41000, 38000, 20000, 4, 3, 0, 2, 4, "below", "low", 309),
    vrow("lc-vikram", 96000, 248000, 214000, 15, 15, 18, 12, 13, "on_par", "high", 1498),
    vrow("lc-zoya", 45000, 9000, 0, 2, 1, 3, 1, 2, "ramp", "low", 20, 0),
  ],
  method: {
    value: "The month's invoiced revenue (Zoho, from finance live) shared out to the work that earned it. Revenue from a client Pulse can link goes to the people who finished that client's tasks and deliveries this month or last, by work units; the rest is shared by everyone's work units this month.",
    units: "A work unit is 1 per finished task someone else gave or accepted (a task one makes and finishes alone counts nothing), plus 1 per credited delivery. Tasks carry no value points.",
    cost: "Salary for the month from the HR salary records. Tools are not attributed per person yet.",
    band: "Value ÷ cost against the company's median for the month: Strong at 1.25× the median or more, On par from 0.75×, Below under it. New joiners: no band in the first 30 days; the bar is halved to day 60 and three-quarters to day 90.",
    confidence: "High: the salary is known, 10 or more work units, and at least half the value from linked clients. Medium: the salary and 3 or more units. Low otherwise.",
  },
};

const seats = { seats: [
  { id: "lc-seat-gd", label: "Graphic designer · West pod · Static design", role: "Graphic designer", pod: "West pod", domain: "design", past: 1, current: 1,
    holders: [{ id: "lc-farah", name: "Farah Qipedot", from: "2023-03-06", to: "2026-08-29", current: false, source: "derived" }, { id: "lc-ishaan", name: "Ishaan Bose", from: "2024-02-12", to: null, current: true, source: "derived" }] },
  { id: "lc-seat-ve", label: "Video editor · West pod · Video editing", role: "Video editor", pod: "West pod", domain: "video_edit", past: 1, current: 2,
    holders: [{ id: "lc-pia", name: "Pia Sen", from: "2025-01-20", to: "2026-03-31", current: false, source: "derived" }, { id: "lc-asha", name: "Asha Rao", from: "2024-11-04", to: null, current: true, source: "derived" }, { id: "lc-dev", name: "Dev Malhotra", from: "2026-08-03", to: null, current: true, source: "derived" }] },
  { id: "lc-seat-ph", label: "Production head · Studio", role: "Production head", pod: "Studio", domain: null, past: 1, current: 0, holders: [{ id: "lc-omi", name: "Omi Kireteso", from: "2022-11-14", to: "2026-04-15", current: false, source: "derived" }] },
  { id: "lc-seat-pm", label: "Performance marketer · Growth · Meta ads", role: "Performance marketer", pod: "Growth", domain: "meta_ads", past: 1, current: 2,
    holders: [{ id: "lc-sana", name: "Sana Mirza", from: "2024-08-05", to: "2026-05-31", current: false, source: "derived" }, { id: "lc-rifob", name: "Rifob Das", from: "2024-04-22", to: null, current: true, source: "derived" }, { id: "lc-kabir", name: "Kabir Shah", from: "2025-02-17", to: null, current: true, source: "derived" }] },
  { id: "lc-seat-sd", label: "Senior designer · Studio · Static design", role: "Senior designer", pod: "Studio", domain: "design", past: 0, current: 1, holders: [{ id: "lc-meera", name: "Meera Iyer", from: "2023-06-12", to: null, current: true, source: "derived" }] },
  { id: "lc-seat-md", label: "Motion designer · Studio", role: "Motion designer", pod: "Studio", domain: null, past: 0, current: 1, holders: [{ id: "lc-zoya", name: "Zoya Khan", from: "2026-09-22", to: null, current: true, source: "derived" }] },
] };
const month = (k, start, units, tasks, accepted, returned, deliveries, onTime, withDue, assigned, present, workdays, season, cost) => ({ k, month: start, units, normUnits: Math.round((units / season) * 10) / 10, tasks, accepted, returned, deliveries, onTime, withDue, assigned, present, workdays, tracked: workdays > 0, season, cost });
const months = (from, n, scale, cost, tracked = true) => Array.from({ length: n }, (_, i) => { const m = new Date(Date.parse(`${from}T00:00:00Z`)); m.setUTCMonth(m.getUTCMonth() + i); const s = [1, 0.9, 1.15, 1.05, 0.85, 1.2, 1, 0.95][i % 8];
  const t = Math.round((6 + i * 0.8) * scale); return month(i + 1, m.toISOString().slice(0, 10), Math.round(t * 1.6), t, Math.round(t * 0.9), i % 3 === 0 ? 1 : 0, Math.round(t * 0.7), Math.round(t * 0.75), t, t + 1, tracked ? 22 : 0, tracked ? 24 : 0, s, cost); });
const compare = {
  seat: { id: "lc-seat-gd", label: "Graphic designer · West pod · Static design" }, window: 8, cost: true, people: PEOPLE.map((p) => ({ id: p.id, name: p.name, role: p.role, status: "active" })),
  method: "Each holder is read month by month from their own first month, so month 3 is everyone's third month. Work units are normalised for the season (the company's output that calendar month against its average month) and shown against the tasks they were given; quality is acceptance and work sent back; attendance counts check-in days against working days where check-ins were recorded. Under 60 days is too early to judge.",
  holders: [
    { person: { id: "lc-farah", name: "Farah Qipedot", photoAt: null, current: false }, from: "2023-03-06", to: "2026-08-29", source: "derived", note: null, tenureDays: 1272, tooEarly: false, months: months("2023-03-01", 12, 1, 38000, false) },
    { person: { id: "lc-ishaan", name: "Ishaan Bose", photoAt: null, current: true }, from: "2024-02-12", to: null, source: "derived", note: null, tenureDays: 973, tooEarly: false, months: months("2024-02-01", 12, 0.8, 52000) },
    { person: { id: "lc-rhea", name: "Rhea Kapoor", photoAt: null, current: true }, from: "2026-09-29", to: null, source: "manual", note: "Took over from Ishaan’s notice period", tenureDays: 12, tooEarly: true,
      months: [month(1, "2026-09-01", 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 1, null), month(2, "2026-10-01", 5, 3, 2, 0, 2, 2, 3, 4, 8, 9, 1.05, null)] },
  ],
};
const fitP = (id, why, score) => ({ id, name: P[id].name, pod: P[id].pod, role: P[id].role, photoAt: null, score, why });
const gaps = {
  openWork: [
    { category: "design", label: "Static design", open: 7, pooled: 4, urgent: 2, best: [fitP("lc-meera", "In their domain: Static design for Studio clients; Did 31 similar static design (9 for this client); 3 open tasks", 61), fitP("lc-ishaan", "Did 22 similar static design; 4 open tasks; leave from Thu 15 Oct", 18)] },
    { category: "video_shoot", label: "Shoots", open: 3, pooled: 3, urgent: 1, best: [fitP("lc-ahoro", "Did 18 similar shoots (6 for this client); usually done in 2 days; 1 open task", 32)] },
    { category: null, label: "Not sorted", open: 2, pooled: 0, urgent: 0, best: [] },
  ],
  overloaded: [{ id: "lc-meera", name: "Meera Iyer", pod: "Studio", open: 14, overdue: 3 }],
  vacantSeats: [{ id: "lc-seat-ph", label: "Production head · Studio", lastHolder: { id: "lc-omi", name: "Omi Kireteso", to: "2026-04-15" } }],
  clientsAtRisk: [{ id: "lc-client-1", name: "Harbour Point", units: 26, leaving: 17, people: ["Ishaan Bose", "Farah Qipedot"] }],
  singlePerson: [{ category: "drone", label: "Drone shoots", person: { id: "lc-ahoro", name: "Ahoro Menon" }, share: 0.94, units: 17 }],
  medianOpen: 4,
};

const directory = { attendanceEnabled: true, pods: ["Studio", "West pod", "Growth"], canEdit: true, viewer: "synthetic-admin",
  people: [...PEOPLE.map((p, i) => ({ ...p, status: "active", userNo: 101 + i, pulseId: null, username: p.name.toLowerCase().replace(/ /g, "."), accounts: [], evidence: "Synthetic", managerId: null, managerName: i ? "Vikram Jivop" : null,
    email: null, skills: [], workLocation: null, deliveries8w: 0, checkedIn: false, sources: 0, flags: [], stage: p.id === "lc-ishaan" ? "notice" : p.id === "lc-dev" ? "probation" : p.id === "lc-zoya" ? "joining" : "active",
    possiblyLeft: ["lc-kabir", "lc-tara", "lc-ahoro"].includes(p.id), leftOn: null })),
  ...ALUMNI.map((a, i) => ({ ...a, status: "inactive", userNo: 80 + i, pulseId: null, username: null, accounts: [], evidence: "Synthetic", managerId: null, managerName: null, email: null, skills: [], workLocation: null, photoAt: null,
    deliveries8w: 0, checkedIn: false, sources: 0, flags: [], stage: "left", possiblyLeft: false }))] };

const pulse = {
  person: { id: "synthetic-sam", name: "Asha Rao", role: "Video editor", pod: "West pod", department: "Creative", joinedOn: "2024-11-04", stage: "active", probationTo: null, lastWorkingDay: null, photoAt: null },
  today: { date: TODAY, hour: 10, due: [{ id: "t11", title: "Site-visit reel: final cut", status: "in_progress", dueAt: iso(TODAY, "18:00"), late: false }, { id: "t12", title: "Captions for the walkthrough", status: "open", dueAt: iso(shift(TODAY, -1), "18:00"), late: true }],
    open: 6, inProgress: 2, shift: { name: "Day", start: "09:00:00", end: "18:00:00" }, workingDay: true },
  week: { from: shift(TODAY, -6), done: 7, accepted: 5, points: 34, deliveries: 9, minutes: 1830, checkInMinutes: 2310, streak: 9 },
  growth: {
    domains: [{ id: "d1", title: "Video editing for West pod clients", status: "active", basis: "agreement" }, { id: "d2", title: "Motion graphics", status: "proposed", basis: "agreement" }],
    kinds: [{ key: "video_edit", label: "Video editing", recent: 38, before: 31 }, { key: "motion", label: "Motion graphics", recent: 6, before: 0 }, { key: "captions", label: "Captions", recent: 4, before: 2 }],
    feedback: [{ kind: "accepted", text: "Clean cut, the client approved it first time", task: "Harbour Point teaser", taskId: "t21", by: "Vikram Jivop", at: iso(shift(TODAY, -2)) },
      { kind: "returned", text: "Logo at the end is cut off on phones", task: "Palm Grove reel", taskId: "t22", by: "Vikram Jivop", at: iso(shift(TODAY, -5)) }],
    learnNext: [{ key: "drone", label: "Drone shoots", open: 4, doers: 1 }, { key: "color", label: "Colour grading", open: 3, doers: 2 }],
  },
  money: { payslips: [{ month: "2026-09", version: 1, issuedAt: iso("2026-10-03"), net: null, reimbursements: null }, { month: "2026-08", version: 1, issuedAt: iso("2026-09-03"), net: null, reimbursements: null }],
    leaveKind: "annual", leaveDays: 7.5, compOffDays: 1, pointsThisMonth: 52, incentives: null },
  recognition: { kudos: [{ id: "k1", from: { id: "lc-meera", name: "Meera Iyer" }, note: "Stayed late to fix the Skyline export before the client call. Saved the day.", at: iso(shift(TODAY, -1)), task: { id: "t31", title: "Skyline Homes launch film" } },
    { id: "k2", from: { id: "lc-vikram", name: "Vikram Jivop" }, note: "Three reels accepted with no changes this week", at: iso(shift(TODAY, -4)), task: null }], given: 3,
    accepted: [{ id: "t21", title: "Harbour Point teaser", at: iso(shift(TODAY, -2)), points: 8, by: "Vikram Jivop" }, { id: "t23", title: "Walkthrough reel v2", at: iso(shift(TODAY, -3)), points: 5, by: "Vikram Jivop" }] },
  knows: [
    { key: "role", label: "Your role", value: "Video editor", source: "Your HR record" }, { key: "pod", label: "Pod and team", value: "West pod · Creative", source: "Your HR record" },
    { key: "manager", label: "You report to", value: "Vikram Jivop", source: "Pod heads set by HR" }, { key: "joined", label: "You joined", value: "2024-11-04", source: "Your HR record" },
    { key: "stage", label: "Where you are", value: "active", source: "Moves recorded by HR" }, { key: "signin", label: "How you sign in", value: "Google Workspace", source: "Sign-in settings" },
    { key: "work", label: "Work credited to you", value: "212 finished tasks, 380 deliveries", source: "Tasks in Pulse and Drive uploads from your own account; shared logins are not credited unless confirmed" },
    { key: "sources", label: "Where your name appears", value: "Planned groups roster · creative@, HR records", source: "Rosters and documents Pulse reads" },
    { key: "attendance", label: "Attendance Pulse has", value: "8 days this month", source: "Your check-ins in the app, on the web or the desktop" },
  ],
  value: [5, 6, 7, 8, 9, 10].map((m, i) => ({ month: `2026-${String(m).padStart(2, "0")}-01`, units: 40 + i * 4, points: 20 + i * 5, tasks: 18 + i, accepted: 16 + i, deliveries: 22 + i * 2, acceptRate: 0.9, onTimeRate: 0.86 })),
  colleagues: PEOPLE.filter((p) => p.id !== "lc-asha").map((p) => ({ id: p.id, name: p.name, pod: p.pod })),
};

export const SHOTS = [
  ["moves", "/hr?tab=moves", "admin"], ["moves-leaving", "/hr/moves/lc-case-leave", "admin"], ["moves-joining", "/hr/moves/lc-case-join", "admin"],
  ["alumni", "/people?status=past", "admin"], ["team-stages", "/people?view=list", "admin"],
  ["value", "/leadership?tab=people&view=value", "admin"], ["finance-people", "/finance?tab=people", "admin"],
  ["seats", "/leadership?tab=people&view=seats", "admin"], ["seat-compare", "/leadership?tab=people&view=seats&seat=lc-seat-gd", "admin"],
  ["staffing", "/leadership?tab=people&view=staffing", "admin"], ["my-pulse", "/me", "asha@lifecycle.test"],
];

const send = (body) => [200, body];
export function route(url) {
  const p = url.pathname;
  if (p === "/api/v0/lifecycle") return send(moves);
  if (p === "/api/v0/lifecycle/cases/lc-case-leave") return send(leaving);
  if (p === "/api/v0/lifecycle/cases/lc-case-join") return send(joining);
  if (p === "/api/v0/value") return send(value);
  if (p === "/api/v0/seats") return send(seats);
  if (p.startsWith("/api/v0/seats/")) return send(compare);
  if (p === "/api/v0/staffing-gaps") return send(gaps);
  if (p === "/api/v0/people") return send(directory);
  return null;
}
/** The plain staff member's own home: My Pulse beside the mock's own day, under the same invented name. */
export async function routeAny(url, who, { mockPort, headers }) {
  // Screenshots only (a staff identity of its own, so specs run through the harness see the plain mock).
  if (who !== "asha@lifecycle.test") return null;
  if (url.pathname === "/api/v0/me/pulse") return send(pulse);
  if (url.pathname === "/api/v0/hr/self") {
    const r = await fetch(`http://127.0.0.1:${mockPort}${url.pathname}${url.search}`, { headers: { "cf-access-authenticated-user-email": String(headers["cf-access-authenticated-user-email"]) } });
    const self = await r.json(); if (self.person) self.person = { ...self.person, name: "Asha Rao", role: "Video editor", pod: "West pod" };
    self.attendanceEnabled = true; // a staff member who checks in, as at EA
    return [r.status, self];
  }
  return null;
}

/** For mock-editors-api.mjs (the specs' managed server): the LIFECYCLE reads and writes, answered synthetically. */
const ME_PATHS = /^\/api\/v0\/(lifecycle(\/|$)|value(\/mine)?$|seats(\/|$)|staffing-gaps$|me\/pulse$|me\/corrections$|kudos(\/|$)|people\/[^/]+\/lifecycle$)/;
export function mockAnswer(url, method, role, me, body = {}) {
  const p = url.pathname;
  if (!ME_PATHS.test(p)) return null;
  const staff = ["hr", "admin", "leadership"].includes(role);
  if (method === "GET") {
    if (p === "/api/v0/me/pulse") return [200, { ...pulse, person: { ...pulse.person, id: me.person, name: me.name } }];
    if (p === "/api/v0/value/mine") return [200, { months: pulse.value }];
    if (/^\/api\/v0\/people\/[^/]+\/lifecycle$/.test(p)) return [200, { today: TODAY, stage: "active", since: null, leftType: null, leftOn: null, employment: null, events: [], cases: [], review: null, canMove: staff }];
    if (!staff) return [403, { error: "People moves are for HR, leadership and admins" }];
    return route(url) ?? [404, { error: "Not found" }];
  }
  if (p.startsWith("/api/v0/kudos")) return [200, p.endsWith("/hide") ? { ok: true } : { id: "lc-kudos-new" }];
  if (p === "/api/v0/me/corrections") return [200, { id: "lc-ticket-new" }];
  if (!["hr", "admin"].includes(role) && !p.startsWith("/api/v0/seats")) return [403, { error: "HR or an admin records people moves" }];
  if (/^\/api\/v0\/lifecycle\/reviews\//.test(p)) return [200, body.action === "dismiss" ? { status: "dismissed" } : body.effectiveOn > TODAY ? { stage: "notice", caseId: "lc-case-leave" } : { stage: "left", caseId: "lc-case-leave" }];
  const stepRun = p.match(/^\/api\/v0\/lifecycle\/cases\/[^/]+\/steps\/([a-z]+)$/);
  if (stepRun) return [200, { key: stepRun[1], status: body.skip ? "skipped" : "done", result: {}, caseDone: false }];
  if (/\/move$/.test(p)) return [200, { stage: body.to, from: "active", since: TODAY, caseId: ["notice", "left", "joining"].includes(body.to) ? "lc-case-leave" : null }];
  if (p === "/api/v0/lifecycle/candidates") return [200, { id: "lc-cand-new" }];
  if (p === "/api/v0/lifecycle/refresh") return [200, { people: 5 }];
  if (/^\/api\/v0\/seats\/[^/]+\/holders$/.test(p)) return [200, { id: "lc-holding-new" }];
  return [404, { error: "Not found" }];
}

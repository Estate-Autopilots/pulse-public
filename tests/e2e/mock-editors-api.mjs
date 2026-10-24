import { screenAnswer, screenHidden, screenTenant } from "./fixtures/screen-hiding.mjs";
import { billingReviewAnswer } from "./fixtures/billing-review.mjs";
import {proposals as ruleProposals} from "../../services/api/src/hr-rules.ts";
import { createServer } from "node:http";
import { mockAnswer as lifecycleAnswer } from "./fixtures/lifecycle.mjs";
import { mockAnswer as tasksAnswer } from "./fixtures/tasks-p0.mjs";
import { serviceQuoteDocument } from "./fixtures/service-quote.mjs";
import { billingPartsAnswer } from "./fixtures/billing-parts.mjs";
import { creativeAnswer } from "./fixtures/creative.mjs";
import { readFileSync } from "node:fs";

// FIN-LIVE: a wholly synthetic live finance model (tests/e2e/fixtures/finance-live.json, invented names and amounts).
const financeLive = JSON.parse(readFileSync(new URL("./fixtures/finance-live.json", import.meta.url), "utf8"));
const financeEmpty = { sources: [], decisions: [], documents: [], budgets: [], forecastEvaluations: [], people: [], synthetic: false, permissions: { write: false },
  summary: { cashIn: 0, cashOut: 0, accrualExpense: 0, invoiced: 0, expenseSources: [], clientCollections: [], consolidatedBasis: "Synthetic" }, discrepancies: [],
  selectedMonth: "2026-10", selectedCurrency: "INR", selectedScale: 2, candidates: [], controls: [], blockers: ["No account-period statements"],
  forecast: { certified: false, reason: "A certified prior period is required", scenario: "base", opening: null, start: "2026-10-10", sourceCutoff: "2026-10-09", closeId: null, overdueAssumptions: 0, weeks: [] },
  schedule: [], queues: { cash: [], source: [], identity: [] }, cases: [], sourceCoverage: { snapshots: 0, coveredAccounts: 0, knownAccounts: 0, certifiedMonths: 0 }, policy: "Synthetic policy" };

// FINANCE-UI: wholly synthetic ad-spend observations (invented accounts, developments and amounts).
const adSpend = (() => {
  const months = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(Date.UTC(2024, 9 + i, 1)), month = d.toISOString().slice(0, 10);
    months.push({ month, kind: "funds", currency: "INR", amount: 260000 + ((i * 37) % 11) * 31000, n: 30 + (i % 7) });
    if (i % 3 === 0) months.push({ month, kind: "billed", currency: "INR", amount: 90000 + (i % 5) * 12000, n: 4 });
  }
  const names = ["Synthetic Skyline Ads", "Synthetic Harbour Homes", "Synthetic Palm Grove", "Synthetic Metro Lofts", "Synthetic Lakeview", "Synthetic Hilltop Villas", "Synthetic Riverside", "Synthetic Garden City"];
  const accounts = names.map((name, i) => ({ accountId: `act_synthetic_${i + 1}`, name, projectKey: i < 5 ? `synthetic-dev-${i + 1}` : null, projectId: null, clientId: null, projectName: i < 5 ? `${name.replace("Synthetic ", "")} launch` : null, clientName: null, manual: i === 1, receipts: 160 - i * 17, months: 20 - i, last: `2026-10-0${(i % 6) + 1}`, amount: 2600000 - i * 290000, inrReceipts: 160 - i * 17, alerts: i % 3 }));
  const rate = (value) => ({ value, low: value - 0.05, high: value + 0.05, n: 120, sufficiency: "ok", priorWeight: 40 });
  return {
    permissions: { ok: true, write: false }, imports: [{ dataset: "ad_receipts", n: 1240, asOf: "2026-10-09", importedAt: "2026-10-09T22:00:00Z" }],
    disclaimer: "Synthetic receipts for screenshots: payments seen in mail, not current platform spend.",
    totals: [{ currency: "INR", n: 1240, amount: months.reduce((n, x) => n + x.amount, 0), first: "2024-10-03", last: "2026-10-06" }, { currency: "USD", n: 12, amount: 840, first: "2025-02-01", last: "2025-11-01" }],
    months, accounts, projects: [], clients: [], benchmark: 420,
    segments: [{ key: "mid_income", cpl: 380, leads: 5200, n: 3 }, { key: "luxury", cpl: 910, leads: 1400, n: 2 }],
    cpl: [1, 2, 3, 4, 5].map((i) => ({ project_key: `synthetic-dev-${i}`, projectId: null, segment: i < 4 ? "mid_income" : "luxury", spend: 900000 + i * 120000, leads: 2400 - i * 300, noted: 300 - i * 30, visits: 40 - i * 4, planned: 60 - i * 5, cpl: 360 + i * 110, estimate: { value: 380 + i * 100, low: 330 + i * 100, high: 430 + i * 100, n: 2400 - i * 300, priorLeads: 50 }, rate: rate(0.2 + i * 0.03), visitCost: 22000 + i * 3000 })),
  };
})();

const accounts = [
  { account: "alex.editor@example.test", holder_person_id: "00000000-0000-0000-0000-000000000001", sharedLogin: false, identityVerified: true, thisWeek: 3, allTime: 47, drafts: 1, finals: 2, lastDelivery: "2026-10-05T09:15:00Z" },
  { account: "studio@example.test", holder_person_id: null, sharedLogin: true, identityVerified: false, thisWeek: 1, allTime: 12, drafts: 1, finals: 0, lastDelivery: "2026-10-04T10:00:00Z" },
  { account: "sam.editor@example.test", holder_person_id: "00000000-0000-0000-0000-000000000002", sharedLogin: false, identityVerified: true, thisWeek: 3, allTime: 19, drafts: 1, finals: 2, lastDelivery: "2026-10-05T09:15:00Z" },
];

const claimOwnerId = accounts[2].holder_person_id;
const claimDelivery = { id: "synthetic-shared-delivery", projectName: "Synthetic Campaign", fileName: "Synthetic model video.mp4", kind: "final", deliveredAt: "2026-10-05T09:15:00Z" };
let claimStatus = "unclaimed";
const designClaimable = { id: "synthetic-shared-design", projectName: "Synthetic Design Campaign", fileName: "Synthetic brochure.pdf", type: "brochure", uploadedAt: "2026-10-05T08:30:00Z" };
let designClaimStatus = "unclaimed";
const designReview = { id: "synthetic-design-for-review", projectName: "Synthetic Design Campaign", fileName: "Synthetic claimed brochure.pdf", type: "brochure", uploadedAt: "2026-09-29T08:30:00Z" };
let designReviewStatus = "unclaimed";
let designReviewPersonId = null;
// EST-1737: the ai-team tenant's Team list, two current people, one alumnus and three AI employees (all synthetic).
const AI_TEAM_PEOPLE = [["avery", "Avery Example", "active"], ["rowan", "Rowan Example", "active"], ["jules", "Jules Example", "inactive"]].map(([key, name, status], i) => ({
  id: `synthetic-team-${key}`, name, status, role: i ? "Editor" : "Producer", userNo: i + 1, username: null, pod: null, department: "Creative", accounts: [], evidence: "",
  joinedOn: "2025-04-01", managerId: null, managerName: null, photoAt: null, email: null, skills: [], workLocation: null, deliveries8w: 0, checkedIn: false, sources: 0, flags: [],
}));
const AI_TEAM_AGENTS = [
  { id: "synthetic-ai-scout", employeeId: "NW-AI-001", name: "Scout", title: "Research assistant", ownerName: "Avery Example", lane: "quick", status: "on", budgetLeft: 182000 },
  { id: "synthetic-ai-quill", employeeId: "NW-AI-002", name: "Quill", title: "Copy assistant", ownerName: "Rowan Example", lane: "thinking", status: "paused", budgetLeft: 0 },
  { id: "synthetic-ai-atlas", employeeId: "NW-AI-003", name: "Atlas", title: "Planning assistant", ownerName: null, lane: "thinking", status: "on", budgetLeft: 45500 },
];
const designPeople = new Map([
  ["designer-a@estateautopilots.com", "synthetic-designer-a"],
  ["designer-b@estateautopilots.com", "synthetic-designer-b"],
]);
const designNames = new Map([
  ["synthetic-designer-a", "Synthetic Designer A"],
  ["synthetic-designer-b", "Synthetic Designer B"],
]);
const claimableAccountId = "00000000-0000-0000-0000-000000000301";
const managerClaimAccountId = "00000000-0000-0000-0000-000000000302";
const accountClaims = [{
  id: "00000000-0000-0000-0000-000000000401",
  accountId: managerClaimAccountId,
  handle: "synthetic-manager@example.test",
  personId: "synthetic-manager",
  personName: "Synthetic Manager",
  status: "pending",
  createdAt: "2026-10-06T09:00:00Z",
}];

const editorWeek = (personId, week) => {
  const values = personId === accounts[0].holder_person_id || personId === claimOwnerId
    ? { model_video: [4, 1, 2], vov: [6, 0, 0], founder_video: [1, 0, 0], testimonial: [1, 0, 0], walkthrough: [1, 0, 0], other: [0, 0, 0] }
    : { model_video: [4, 0, 0], vov: [2, 0, 0], founder_video: [null, 0, 0], testimonial: [null, 0, 0], walkthrough: [null, 0, 0], other: [null, 0, 0] };
  const types = Object.fromEntries(Object.entries(values).map(([type, [target, drafts, finals]]) => [type, {
    target,
    delivered: { drafts, finals: finals + (personId === claimOwnerId && claimStatus === "confirmed" && type === "model_video" ? 1 : 0) },
    claimed: { drafts: 0, finals: personId === claimOwnerId && claimStatus === "confirmed" && type === "model_video" ? 1 : 0 },
    gap: target === null ? null : Math.max(0, target - drafts - finals - (personId === claimOwnerId && claimStatus === "confirmed" && type === "model_video" ? 1 : 0)),
    placeholder: true,
  }]));
  return { week, types };
};

const weekStart = (week) => {
  const match = week.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return "2026-10-05";
  const jan4 = new Date(Date.UTC(Number(match[1]), 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (Number(match[2]) - 1) * 7);
  return monday.toISOString().slice(0, 10);
};

const shiftDay = (value, days) => new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

const isoWeekFor = (value) => {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};

const periodFor = (url) => {
  const requestedWeek = url.searchParams.get("week");
  const requestedPeriod = url.searchParams.get("period");
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  let kind = requestedWeek ? "week" : requestedPeriod === "last" ? "last" : fromParam && toParam ? "custom" : "this";
  const from = requestedWeek ? weekStart(requestedWeek) : requestedPeriod === "last" ? "2026-09-28" : fromParam ?? "2026-10-05";
  const to = requestedWeek ? shiftDay(from, 6) : requestedPeriod === "last" ? "2026-10-04" : toParam ?? shiftDay(from, 6);
  if (from === "2026-10-05" && to === "2026-10-11") kind = "this";
  else if (from === "2026-09-28" && to === "2026-10-04") kind = "last";
  const week = to === shiftDay(from, 6) && new Date(`${from}T00:00:00Z`).getUTCDay() === 1 ? isoWeekFor(from) : null;
  return { from, to, kind, week, today: "2026-10-05", inProgress: kind === "this" };
};

const designTypes = ["single_image_ad", "carousel", "brochure", "logo", "pitch_deck", "other"];
const designTypeCounts = (values = {}) => Object.fromEntries(designTypes.map((type) => [type, values[type] ?? 0]));
const designers = [
  { personId: "synthetic-sam", name: "Synthetic Sam", sharedLogin: false, types: designTypeCounts({ carousel: 3, logo: 1 }) },
  { personId: "synthetic-blair", name: "Synthetic Blair", sharedLogin: false, types: designTypeCounts() },
  { personId: "synthetic-manager", name: "Synthetic Manager", sharedLogin: false, types: designTypeCounts({ brochure: 2 }) },
  { personId: null, name: "shared login", sharedLogin: true, types: designTypeCounts({ pitch_deck: 1 }) },
];
const designersForWeek = (week) => {
  const rows = designers.map((designer) => ({
    ...designer,
    types: week === "2026-W41" ? designTypeCounts() : designTypeCounts(designer.types),
    claimed: designTypeCounts(),
  }));
  if (week === "2026-W40") {
    const confirmed = designReviewStatus === "confirmed";
    const shared = rows.find((designer) => designer.sharedLogin);
    shared.types.brochure = confirmed ? 0 : 1;
    rows.push({
      personId: "synthetic-designer-b", name: "Synthetic Designer B", sharedLogin: false,
      types: designTypeCounts(confirmed ? { brochure: 1 } : {}),
      claimed: designTypeCounts(confirmed ? { brochure: 1 } : {}),
    });
  }
  return rows.map((designer) => week === "2026-W39" && designer.personId === "synthetic-sam" && accountClaims.some((claim) => claim.personId === designer.personId && claim.status === "confirmed")
    ? { ...designer, types: { ...designer.types, carousel: designer.types.carousel + 1 } }
    : designer);
};
const designerDays = (week) => {
  const start = weekStart(week);
  const values = week === "2026-W41" ? Array.from({ length: 7 }, () => ({})) : [{ carousel: 2 }, { carousel: 1, logo: 1 }, {}, {}, {}, {}, {}];
  return values.map((counts, index) => ({ day: shiftDay(start, index), types: designTypeCounts(counts) }));
};

const summary = (account, period) => {
  const editor = accounts.find((item) => item.account === account) ?? accounts[0];
  const week = period.week ?? `${period.from} – ${period.to}`;
  return {
    week,
    period,
    uploaderAccount: editor.account,
    deliveries: { value: editor.thisWeek, why: { detail: "Synthetic weekly total from the editor API fixture." } },
    drafts: editor.drafts,
    finals: editor.finals,
    usual: 2.5,
    files: 8,
    indexedProjects: 2,
    lastIndexedAt: "2026-10-05T10:00:00Z",
    scope: "Synthetic editor account",
    projects: [],
    recentDeliveries: [],
    account: editor.account,
    holder_person_id: editor.holder_person_id,
    sharedLogin: editor.sharedLogin,
    identityVerified: editor.identityVerified,
    turnaroundDetail: "Turnaround is not available in this fixture.",
    days: [{ day: "2026-10-05", deliveries: editor.thisWeek, drafts: editor.drafts, finals: editor.finals }],
    weeks: [{ week, start: period.from, deliveries: editor.thisWeek }],
    timeline: [],
  };
};

const hrPolicy = { shiftStart: "09:00", shiftEnd: "18:00", graceMinutes: 0, workDays: [1, 2, 3, 4, 5], wfhPerMonth: null, leaveYearStart: 1, trackingFrom: "2026-01-01", confirmedAt: null };
const hrType = { key: "annual", name: "Annual leave", paid: true, annualDays: 12, accrual: "monthly", carryForwardMax: 0, active: true };
const hrRequest = { id: "synthetic-leave-request", personId: "synthetic-taylor", name: "Synthetic Taylor", fromDate: "2026-10-12", toDate: "2026-10-13", kind: "annual", status: "pending", halfDay: null, days: 2, reason: "Synthetic personal day", createdAt: "2026-10-05T09:00:00Z", decidedAt: null, decisionNote: null, decidedBy: null, photoAt: null };
const hrPeople = [
  { id: "synthetic-taylor", name: "Synthetic Taylor", role: "Designer", pod: "Studio", department: "Design", userNo: null, photoAt: null, joinedOn: null, balances: [{ key: "annual", accrued: 8, carried: 0, adjusted: 0, used: 1, pending: 0, available: 7 }] },
  { id: "synthetic-sam", name: "Synthetic Sam", role: "Editor", pod: "Studio", department: "Creative", userNo: null, photoAt: null, joinedOn: null, balances: [] },
];
// The HR desk as the service sends it. Synthetic Sam's row is in the shape an older service sent (no per-session
// rows): the desk must still render it (pulse-dev, 9 Oct 2026, showed "This view could not load" instead).
const hrEntry = (personId, inAt, worked) => ({ id: `synthetic-entry-${personId}`, personId, date: "2026-10-06", in: inAt, out: null, mode: "office", late: 0, missedOut: false, source: "self", note: null, breakMinutes: 0, onBreak: false, worked });
const hrDesk = (me) => ({
  date: "2026-10-06", today: "2026-10-06", clock: "11:20", policy: hrPolicy, day: { kind: "working" },
  attendance: { filter: { version: "synthetic", provisional: true, maxMinutes: 720 }, from: "2026-09-23", to: "2026-10-06", recordedDays: 9, eligibleDays: 8, flaggedCount: 1, excludedDays: 1, coverage: 0.89, workedMinutes: 3872, recordedMinutes: 4652, averageMinutes: 484 },
  people: [
    { id: "synthetic-taylor", name: "Synthetic Taylor", role: "Designer", pod: "Studio", department: "Design", userNo: null, photoAt: null, joinedOn: null, canSignIn: true, trackedFrom: "2026-09-01", status: "in", attendance: null,
      sessions: [hrEntry("synthetic-taylor", "2026-10-06T03:35:00Z", 125)], entry: hrEntry("synthetic-taylor", "2026-10-06T03:35:00Z", 125), leave: null },
    { id: "synthetic-sam", name: "Synthetic Sam", role: "Editor", pod: "Studio", department: "Creative", userNo: null, photoAt: null, joinedOn: null, canSignIn: true, trackedFrom: "2026-09-01", status: "in",
      entry: hrEntry("synthetic-sam", "2026-10-06T04:10:00Z", 90), leave: null },
  ],
  counts: { headcount: 2, in: 2, onBreak: 0, done: 0, wfh: 0, late: 0, leave: 0, notIn: 0, canSignIn: 2 },
  pending: { leave: [hrRequest], regularisations: [] }, tickets: { open: 0, unassigned: 0, high: 0 },
  upcoming: [], holidays: [], anomalies: [],
  // Only today has check-ins: too few days for a chart.
  trend: Array.from({ length: 14 }, (_, i) => ({ date: `2026-${i < 8 ? "09" : "10"}-${String(i < 8 ? 23 + i : i - 7).padStart(2, "0")}`, present: i === 13 ? 2 : 0, wfh: 0, late: 0 })),
  types: [hrType], me,
});
const hrDates = (month) => {
  const [year, monthNo] = month.split("-").map(Number), count = new Date(Date.UTC(year, monthNo, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, "0")}`, weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    return { date, off: weekday === 0 || weekday === 6, holiday: null };
  });
};
const hrSelf = (name, personId) => ({
  person: { id: personId, name, role: "Designer", pod: "Studio", department: "Design", userNo: null, photoAt: null, status: "active", joinedOn: null, managerId: null, managerName: null, skills: [], employmentType: "full_time", username: null },
  self: true, today: "2026-10-06", clock: "10:00", policy: hrPolicy,
  can: { act: true, decide: false, record: false, performance: false, adjust: false },
  now: { state: "out", entry: null, holiday: null, leave: null },
  month: { key: "2026-10", from: "2026-10-01", to: "2026-10-31", days: [], summary: { filter: { version: "synthetic", provisional: true, maxMinutes: 720 }, from: "2026-10-01", to: "2026-10-31", present: 0, wfh: 0, late: 0, leave: 0, absent: 0, missedOut: 0, workedMinutes: 0, recordedMinutes: 0, recordedDays: 0, eligibleDays: 0, flaggedCount: 0, excludedDays: 0, coverage: null, averageMinutes: null }, trackedFrom: null },
  wfh: { used: 0, allowance: null },
  leave: { year: 2026, yearStartsMonth: 1, provisional: false, trackingFrom: "2026-01-01", types: [hrType], balances: [], requests: [{ ...hrRequest, id: "synthetic-own-request", personId, name, reason: "Synthetic personal day" }] },
  regularisations: [], tickets: [], away: [], holidays: [], performance: null, team: [], approvals: { leave: [], regularisations: [] },
});
const hrLeave = (month, me) => {
  const dates = hrDates(month), from = `${month}-01`, to = `${month}-${String(dates.length).padStart(2, "0")}`;
  const calendar = month === "2026-10" ? [hrRequest] : [];
  return { month, from, to, today: "2026-10-06", policy: hrPolicy, year: 2026, types: [hrType], holidays: [], dates,
    people: hrPeople, requests: calendar, calendar, adjustments: [], me };
};

// HR desk → Policies (HR-UI round): a leave draft with a table and "(confirm)" items, a published code of conduct.
const POLICY_DRAFT = `# Synthetic Leave Policy

Version 1 (draft) · Synthetic fixture
Items marked **(confirm)** need confirmation before publishing.

## 1. Leave entitlement

- Two synthetic days a month, carried up to **12 days** **(confirm)**. Leave above the
  limit lapses on 31 March.
- Half days count as 0.5.

## 2. Types of leave

| Type | How it works |
| --- | --- |
| Paid leave | From the monthly entitlement |
| Paternity leave | 5 working days **(confirm)** |

## 3. Applying for leave

1. Apply in **Pulse → My desk → Leave**.
   - 1–2 days: 3 working days ahead.
   - 3 or more days: 2 weeks ahead.
2. Your Pod Head approves.
`;
const policyDocs = [
  { id: "synthetic-policy-leave", kind: "leave", title: "Synthetic Leave Policy", body: POLICY_DRAFT, version: 1, revision: 1, status: "draft", created_by: "synthetic-hr", author: "Synthetic HR", editor: null, publisher: null, created_at: "2026-10-05T09:00:00Z", updated_at: null, published_at: null },
  { id: "synthetic-policy-conduct", kind: "conduct", title: "Synthetic Code of Conduct", body: "# Synthetic Code of Conduct\n\n## 1. Respect\n\n- Be kind to colleagues.\n- Keep client work confidential.\n", version: 1, revision: 1, status: "published", created_by: "synthetic-hr", author: "Synthetic HR", editor: null, publisher: "Synthetic HR", created_at: "2026-10-01T09:00:00Z", updated_at: null, published_at: "2026-10-01T09:30:00Z" },
];
const policyAcks = [];
const policyList = (staff, me) => {
  const latest = (kind, published) => policyDocs.filter((d) => d.kind === kind && (!published || d.status === "published")).sort((a, b) => b.version - a.version)[0];
  const rows = [...new Set(policyDocs.map((d) => d.kind))].map((kind) => latest(kind, staff)).filter(Boolean)
    .map((d) => ({ ...d, acknowledged: policyAcks.some((a) => a.document_id === d.id && a.person_id === me), ackCount: policyAcks.filter((a) => a.document_id === d.id).length }));
  return { rows, canEdit: !staff, headcount: hrPeople.length, versions: staff ? [] : policyDocs.map(({ id, kind, title, version, status, created_at, published_at }) => ({ id, kind, title, version, status, created_at, published_at })), acks: staff ? [] : policyAcks.map((a) => ({ ...a, name: "Synthetic Sam" })) };
};
const hrFlowSettings = { policy: { leave_approver: "pod_head", correction_approver: "pod_head", work_approver: "pod_head", request_approver: "pod_head", max_leave_days: 3, balance_buffer: 0, comp_credit: 1, comp_expiry_days: 90, reminder_hours: 24 },
  people: hrPeople.map((p) => ({ id: p.id, name: p.name, pod: p.pod, managerId: null })), pods: [], cofounders: [], patterns: [{ personId: "synthetic-sam", name: "Synthetic Sam", workDays: [2, 3, 4, 5, 6, 7], fromDate: "2026-09-01", toDate: null, reason: "Synthetic Sunday shoots" }], suggestions: [], podNames: ["Studio"] };

const readJson = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
};
// Like the API (MODULE_API in services/api/src/modules.ts), a switched-off module's routes answer 404 as if they did
// not exist. Northwind switches off every module, so one pattern covers them all.
const MODULE_API = /^\/(v1\/designs|api\/v0\/(designers|design-deliveries|map|acquisition|portal|chats|groups|inbox|communication|briefs|finance|money|hr|leave|attendance|shifts|me\/hr|people\/[^/]+\/(hr|hr-contact|salary)|companion\/(wallet|late-dispute)|delivery\/(client-access|commerce|demo-media|media|policy|publication|release|support)))(\/|$)/;
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = decodeURIComponent(url.pathname);
  const period = periodFor(url);
  response.setHeader("Content-Type", "application/json");
  const review = await billingReviewAnswer(request, path);
  if (review) { response.end(JSON.stringify(review)); return; }
  const billingParts = billingPartsAnswer(path, request.method);
  if (billingParts) { response.end(JSON.stringify(billingParts)); return; }
  const identity = String(request.headers["cf-access-authenticated-user-email"] ?? "").toLowerCase();
  const creativeOn = process.env.PULSE_CREATIVE === "1" || identity.endsWith("@creative-on.example");
  if (creativeOn) {
    const creative = creativeAnswer(url, request.method, identity);
    if (creative) { response.statusCode = creative[0]; response.end(JSON.stringify(creative[1])); return; }
  }
  const designPersonId = designPeople.get(identity);
  const isDesigner = designPersonId !== undefined;
  // Synthetic second companies: Northwind has switched off the modules AC does not use (EST-647); its twin Northwind-on
  // keeps every module. The address's local part is the role: admin, hr or staff. On-leave (EST-1196) has every module and
  // today is a day of approved leave.
  const company = identity.match(/^(admin|leadership|hr|staff)@(northwind|northwind-on|on-leave|creative-on|screen-[a-z-]+|ai-add|ai-team(?:-empty|-error)?)\.example$/);
  const northwind = company?.[2] === "northwind" || identity === "owner@northwind.test";
  const role = company?.[1] === "leadership" ? "leadership" : identity === "accountant@example.test" ? "accountant" : identity === "hr@estateautopilots.com" || company?.[1] === "hr" ? "hr" : identity === "admin@estateautopilots.com" || company?.[1] === "admin" || identity === "owner@northwind.test" || ["finance-admin@example.test", "finance-outage@example.test"].includes(identity) ? "admin" : identity === "manager@estateautopilots.com" || identity === "manager-attendance-off@estateautopilots.com" ? "manager" : identity === "editor@estateautopilots.com" || isDesigner || company?.[1] === "staff" ? "person" : "staff";
  const reviewerId = role === "staff" ? "synthetic-sam" : isDesigner ? designPersonId : role === "person" ? claimOwnerId : role === "manager" ? "synthetic-manager" : role === "hr" ? "synthetic-hr" : "synthetic-admin";
  const reviewerName = role === "staff" || role === "person" ? "Synthetic Sam" : role === "manager" ? "Synthetic Manager" : role === "hr" ? "Synthetic HR" : "Synthetic Admin";
  // A synthetic password session (the Pulse phone app signs in this way) reads as the same staff person.
  const viaPassword = String(request.headers["x-pulse-session"] ?? "").startsWith("syntheticshellsession");
  const me = { email: identity, orgName: "Northwind Studio", person: reviewerId, role, name: reviewerName, pod: "Studio", username: null, photoAt: null, hrAccess: role !== "staff", via: viaPassword ? "password" : "access",
    // Like the API (services/api/src/modules.ts SERVER_SWITCHED), the Creative Strategy app (EST-1474) is off unless the
    // server switches it on; the other server-switched modules have no rail entry, so only it needs mirroring here.
    // Pulse HQ belongs to the Pulse organisation only (ORG_ONLY), which no synthetic company here is.
    modules: { off: [...(northwind ? ["designers", "map", "acquisition", "chats", "briefs", "money", "hr"] : []), ...(creativeOn ? [] : ["creative"]), "pulse_hq"] } };
  const screen = screenTenant(identity);
  if (screen) {
    me.hiddenScreens = screenHidden(screen, role);
    if (identity.endsWith("@screen-off.example")) me.modules.off.push("map");
    const answer = screenAnswer(screen, url, request.method, me, request.method === "POST" ? await readJson(request) : {});
    if (answer) { response.statusCode = answer[0]; response.end(JSON.stringify(answer[1])); return; }
  }
  if (northwind && MODULE_API.test(path)) {
    response.statusCode = 404;
    response.end(JSON.stringify({ message: `Route ${request.method}:${request.url} not found`, error: "Not Found", statusCode: 404 }));
    return;
  }
  // LIFECYCLE: People moves, checklists, value, seats, staffing gaps and My Pulse (synthetic, tests/e2e/fixtures/lifecycle.mjs).
  if (/^\/api\/v0\/(lifecycle|value|seats|staffing-gaps|me\/pulse|me\/corrections|kudos|people\/[^/]+\/lifecycle)/.test(path)) {
    const answer = lifecycleAnswer(url, request.method ?? "GET", role, me, request.method === "POST" ? await readJson(request) : {});
    if (answer) { response.statusCode = answer[0]; response.end(JSON.stringify(answer[1])); return; }
  }
  // TASKS-P0: a task page, a person's board, mentions and role actions (synthetic, tests/e2e/fixtures/tasks-p0.mjs).
  if (/^\/api\/v0\/(tasks|work\/(options|comments|asks|watch|notices|project-categories|list|views))(\/|$)/.test(path)) {
    const answer = tasksAnswer(url, request.method ?? "GET", role, me, request.method === "POST" ? await readJson(request) : {});
    if (answer && "binary" in answer) { response.setHeader("Content-Type", answer.type); response.setHeader("Content-Disposition", answer.disposition); response.setHeader("X-Content-Type-Options", "nosniff"); response.end(answer.binary); return; }
    if (answer) { response.statusCode = answer[0]; response.end(JSON.stringify(answer[1])); return; }
  }
  const pendingClaim = {
    id: "synthetic-delivery-claim", deliveryId: claimDelivery.id, personId: claimOwnerId, personName: "Synthetic Sam",
    projectName: claimDelivery.projectName, fileName: claimDelivery.fileName, kind: claimDelivery.kind,
    deliveredAt: claimDelivery.deliveredAt, status: "pending", creditedVia: "claim", createdAt: "2026-10-05T10:00:00Z",
  };
  if (path === "/v1/accounts/claimable" && request.method === "GET") {
    const active = !accountClaims.some((claim) => claim.accountId === claimableAccountId && ["pending", "confirmed"].includes(claim.status));
    response.end(JSON.stringify({ accounts: role === "staff" && active ? [{ id: claimableAccountId, handle: "synthetic-editor@example.test", deliveryCount: 3, lastDelivery: "2026-10-05T09:15:00Z" }] : [] }));
    return;
  }
  if (path === "/v1/accounts/claims" && request.method === "GET") {
    const status = url.searchParams.get("status");
    const canReview = ["admin", "hr", "manager", "pgs", "leadership"].includes(role);
    const claims = accountClaims.filter((claim) => (claim.personId === reviewerId || (canReview && claim.personId !== reviewerId))
      && (!status || claim.status === status));
    response.end(JSON.stringify({ claims }));
    return;
  }
  const accountClaimRoute = path.match(/^\/v1\/accounts\/([^/]+)\/claim(?:\/(decide|revert))?$/);
  if (accountClaimRoute && request.method === "POST") {
    const body = await readJson(request);
    const accountId = accountClaimRoute[1];
    const action = accountClaimRoute[2];
    let claim = accountClaims.find((item) => item.accountId === accountId);
    if (!action && role === "staff" && accountId === claimableAccountId && Object.keys(body).length === 0) {
      claim = { id: "00000000-0000-0000-0000-000000000402", accountId, handle: "synthetic-editor@example.test", personId: reviewerId, personName: reviewerName, status: "pending", createdAt: "2026-10-06T10:00:00Z" };
      accountClaims.push(claim);
    } else if (action === "decide" && ["admin", "hr", "manager", "pgs", "leadership"].includes(role) && claim && claim.personId !== reviewerId && claim.status === "pending" && ["confirmed", "rejected"].includes(body.decision)) {
      claim.status = body.decision;
    } else if (action === "revert" && ["admin", "hr", "manager", "pgs", "leadership"].includes(role) && claim && claim.status === "confirmed") {
      claim.status = "reverted";
    }
    if (!claim) response.statusCode = 404;
    response.end(JSON.stringify(claim ?? { error: "Synthetic account claim was not found." }));
    return;
  }
  if (path === "/v1/deliveries/claimable" && request.method === "GET") {
    if (role !== "person") response.statusCode = 403;
    response.end(JSON.stringify(role === "person" ? { week: url.searchParams.get("week") ?? "2026-W41", deliveries: claimStatus === "unclaimed" ? [claimDelivery] : [] } : { error: "A personal account is required." }));
    return;
  }
  if (path === "/v1/designs/claimable" && request.method === "GET") {
    const week = url.searchParams.get("week") ?? "2026-W41";
    if (!isDesigner) response.statusCode = 403;
    const reviewPending = week === "2026-W40" && designReviewStatus === "pending" && designReviewPersonId === reviewerId;
    const designs = week === "2026-W40"
      ? (designReviewStatus === "unclaimed" || reviewPending ? [{ ...designReview, status: reviewPending ? "pending" : "claimable" }] : [])
      : (designClaimStatus === "unclaimed" ? [{ ...designClaimable, status: "claimable" }] : []);
    response.end(JSON.stringify(isDesigner ? { week, designs } : { error: "Only designers can view claimable design exports." }));
    return;
  }
  const designClaimRoute = path.match(/^\/v1\/designs\/([^/]+)\/claim$/);
  if (designClaimRoute && request.method === "POST") {
    const body = await readJson(request);
    if (!isDesigner) response.statusCode = 403;
    else if (Object.keys(body).length) response.statusCode = 400;
    else if (designClaimRoute[1] === designReview.id && designReviewStatus === "unclaimed") {
      designReviewStatus = "pending";
      designReviewPersonId = reviewerId;
    } else if (designClaimRoute[1] === designClaimable.id && designClaimStatus === "unclaimed") {
      designClaimStatus = "pending";
    } else response.statusCode = 409;
    const design = designClaimRoute[1] === designReview.id ? designReview : designClaimable;
    const status = designClaimRoute[1] === designReview.id ? designReviewStatus : designClaimStatus;
    response.end(JSON.stringify(response.statusCode >= 400 ? { error: "The design is not available to claim." } : {
      id: `synthetic-${design.id}-claim`, designId: design.id, personId: reviewerId,
      status, creditedVia: "claim", createdAt: "2026-10-05T10:00:00Z",
    }));
    return;
  }
  if (path === "/v1/designs/claims" && request.method === "GET") {
    const week = url.searchParams.get("week") ?? "2026-W41";
    const status = url.searchParams.get("status") ?? "pending";
    const canReview = role === "admin" || role === "manager";
    if (!canReview) response.statusCode = 403;
    const pending = status === "pending" && designReviewStatus === "pending";
    const claims = canReview && week === "2026-W40" && pending ? [{
      id: "synthetic-design-claim-review", designId: designReview.id, personId: designReviewPersonId,
      personName: designNames.get(designReviewPersonId), projectName: designReview.projectName,
      fileName: designReview.fileName, type: designReview.type, uploadedAt: designReview.uploadedAt,
      status: "pending", creditedVia: "claim", createdAt: "2026-10-05T10:00:00Z",
    }] : [];
    response.end(JSON.stringify(canReview ? { week, claims } : { error: "Only admins or managers can review design claims." }));
    return;
  }
  if (path === "/v1/deliveries/claims" && request.method === "GET") {
    if (role !== "admin" && role !== "manager") response.statusCode = 403;
    const claims = (role === "admin" || role === "manager") && claimStatus === "pending" && (url.searchParams.get("status") ?? "pending") === "pending" ? [pendingClaim] : [];
    response.end(JSON.stringify(role === "admin" || role === "manager" ? { week: url.searchParams.get("week") ?? "2026-W41", claims } : { error: "Only admins or managers can review delivery claims." }));
    return;
  }
  const deliveryClaimRoute = path.match(/^\/v1\/deliveries\/([^/]+)\/claim$/);
  if (deliveryClaimRoute && request.method === "POST") {
    const body = await readJson(request);
    if (role !== "person") response.statusCode = 403;
    else if (deliveryClaimRoute[1] !== claimDelivery.id || claimStatus !== "unclaimed") response.statusCode = 409;
    else if (Object.keys(body).length) response.statusCode = 400;
    else claimStatus = "pending";
    response.end(JSON.stringify(response.statusCode >= 400 ? { error: "The delivery is not available to claim." } : { ...pendingClaim, status: claimStatus }));
    return;
  }
  const decideRoute = path.match(/^\/v1\/deliveries\/([^/]+)\/claim\/decide$/);
  if (decideRoute && request.method === "POST") {
    const body = await readJson(request);
    if (role !== "admin" && role !== "manager") response.statusCode = 403;
    else if (body.decision !== "confirmed" && body.decision !== "rejected") response.statusCode = 400;
    else if (decideRoute[1] === designReview.id && designReviewStatus === "pending") designReviewStatus = body.decision;
    else if (decideRoute[1] === designClaimable.id && designClaimStatus === "pending") designClaimStatus = body.decision;
    else if (decideRoute[1] === claimDelivery.id && claimStatus === "pending") claimStatus = body.decision;
    else response.statusCode = 404;
    const responseBody = decideRoute[1] === designReview.id
      ? { id: "synthetic-design-claim-review", designId: designReview.id, personId: designReviewPersonId, status: designReviewStatus }
      : decideRoute[1] === designClaimable.id
        ? { id: "synthetic-design-claim", designId: designClaimable.id, status: designClaimStatus }
        : { ...pendingClaim, status: claimStatus };
    response.end(JSON.stringify(response.statusCode >= 400 ? { error: "The pending claim could not be decided." } : responseBody));
    return;
  }
  const weeklyMatch = path.match(/^\/v1\/editors\/([^/]+)\/week$/);
  if (weeklyMatch) {
    const personId = weeklyMatch[1];
    const editor = accounts.find((item) => item.holder_person_id === personId);
    if (!editor && ![...designPeople.values()].includes(personId)) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "Synthetic editor was not found." }));
      return;
    }
    response.end(JSON.stringify(editorWeek(personId, url.searchParams.get("week") ?? "2026-W41")));
    return;
  }
  if (path === "/api/v0/editors") {
    const periodAccounts = accounts.map((account) => account.holder_person_id === claimOwnerId && claimStatus === "confirmed"
      ? { ...account, thisWeek: account.thisWeek + 1 } : account);
    response.end(JSON.stringify({ week: period.week ?? `${period.from} – ${period.to}`, period, accounts: periodAccounts }));
    return;
  }
  if (path === "/api/v0/people") {
    const people = company?.[2] === "ai-add" ? ["active", "past"].map((status) => ({
      id: `synthetic-${status}-owner`, name: `Synthetic ${status === "active" ? "Owner" : "Alumnus"}`, status, role: "Designer", userNo: null,
      username: null, pod: null, department: null, accounts: [], evidence: "", joinedOn: null, managerId: null, managerName: null,
      photoAt: null, email: null, skills: [], workLocation: null, deliveries8w: 0, checkedIn: false, sources: 0, flags: [],
    })) : company?.[2]?.startsWith("ai-team") ? AI_TEAM_PEOPLE : [];
    response.end(JSON.stringify({ people, pods: [], canEdit: ["hr", "admin"].includes(role), viewer: reviewerId }));
    return;
  }
  // EST-1737: the real API refuses this to everyone but leaders and admins; here it answers anyone at ai-team, so
  // ai-team-list.spec.ts proves the Team page itself never asks for, or shows, AI rows to anyone else.
  // Other fixtures have an empty roster, so existing Team/add-member/tracking checks keep their normal view.
  if (path === "/api/v0/agents/team") {
    if (company?.[2] === "ai-team-error") { response.statusCode = 503; response.end(JSON.stringify({ message: "Synthetic roster unavailable" })); return; }
    response.end(JSON.stringify({ agents: company?.[2] === "ai-team" ? AI_TEAM_AGENTS : [] }));
    return;
  }
  // Settings → Sign-in: an admin's two-step policy switch (services/api account-security.ts, pulse.auth_policy_save()).
  if (path === "/api/v0/admin/auth-policy" && request.method === "GET" && role === "admin") {
    response.end(JSON.stringify({ required: false, graceUntil: null }));
    return;
  }
  // EST-1398: Settings → Sign-in reads the access list on the server; the Google calls are routed in google-sign-in.spec.ts.
  if (path === "/api/v0/admin/access" && (role === "admin" || role === "hr")) {
    response.end(JSON.stringify({ requests: [], people: [{ id: "synthetic-sam", name: "Synthetic Sam", userNo: null, username: "sam", role: "staff", pod: "Studio", accounts: [], photoAt: null,
      authStatus: "active", loginStatus: "active", mustChange: false, issuedAt: null, lastLoginAt: null, locked: false }] }));
    return;
  }
  if (path === "/api/v0/auth/branding") {
    response.end(JSON.stringify({ name: "Northwind Studio" }));
    return;
  }
  if (path === "/api/v0/me") {
    response.end(JSON.stringify(identity === "quote-leadership@example.test" ? { ...me, role: "leadership" } : me));
    return;
  }
  const quoteDocument = serviceQuoteDocument(path);
  if (quoteDocument) { response.end(JSON.stringify(quoteDocument)); return; }
  if (path === "/api/v0/finance" || path.startsWith("/api/v0/finance/live")) {
    if (identity === "finance-outage@example.test") {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "Synthetic Finance service unavailable" }));
      return;
    }
    if (role !== "admin" || identity === "finance-admin@example.test") {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: "Live finance views are leadership-only" }));
      return;
    }
    if (path === "/api/v0/finance/live/records") {
      const kind = url.searchParams.get("kind") ?? "invoice";
      const rows = kind === "invoice" ? financeLive.model.collections.invoices.slice(0, 100).map((i) => ({ key: i.number, body: i, source: { type: "mail", mailbox: "marketing@example.test", sent: i.date, attachment: `${i.number}.pdf` }, confidence: "high", hash: "a".repeat(64) })) : [];
      response.end(JSON.stringify({ total: rows.length, rows }));
      return;
    }
    response.end(JSON.stringify(path === "/api/v0/finance" ? { ...financeEmpty, live: url.searchParams.get("pilot") === "synthetic" ? null : financeLive } : financeLive));
    return;
  }
  if (path === "/api/v0/settings" && identity === "finance-admin@example.test") {
    response.end(JSON.stringify({ org: { name: "Northwind Studio" }, roles: [], people: [], permissions: [], canGrant: false, canEdit: false }));
    return;
  }
  if (path === "/api/v0/money/ad-spend" && role === "admin") {
    response.end(JSON.stringify(adSpend));
    return;
  }
  if (path === "/api/v0/money" && role === "admin") {
    response.end(JSON.stringify({ rows: [], total: 0, page: 0, dataset: "money_sheet_transactions", datasets: ["money_sheet_transactions"], workspace: null, payroll: null, aaEnabled: false,
      summary: { datasets: [] }, permissions: { read: true, amounts: true, write: false }, plans: [], people: [], projects: [], grants: [] }));
    return;
  }
  if (path === "/api/v0/finance/desk") {
    response.end(JSON.stringify({
      records: [{kind: "purchase", key: "synthetic-invoice", body: {date: "2026-09-01", vendor: "Synthetic Software", vendorGSTIN: "27ABCDE1234F1Z5", ourGSTINPresent: false, invoiceNo: "SYN-1", taxable: "100", cgst: "9", sgst: "9", igst: "0", total: "118", currency: "INR", inr: "118", status: "extracted"}}],
      files: [{key: "synthetic-invoice", name: "2026-09-01_Synthetic-Software_118_SYN-1.pdf", mime: "application/pdf"}],
      sends: [], synthetic: true, accountant: role === "accountant", canManage: role === "admin", canApprove: role === "admin", company: "Vikriya Solutions LLP", intakeMode: "fixtures", accountingSystem: "Zoho Books if confirmed", setup: [], people: [],
    }));
    return;
  }
  if (path === "/api/v0/designers") {
    const week = url.searchParams.get("week") ?? period.week ?? "2026-W41";
    response.end(JSON.stringify({ week, designers: designersForWeek(week) }));
    return;
  }
  const designerMatch = path.match(/^\/api\/v0\/designers\/([^/]+)$/);
  if (designerMatch) {
    if (role === "manager" || role === "pgs" || designerMatch[1] !== me.person) {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: "Daily design detail is self-only." }));
      return;
    }
    const week = url.searchParams.get("week") ?? period.week ?? "2026-W41";
    response.end(JSON.stringify({ week, days: designerDays(week) }));
    return;
  }
  if (path === "/api/v0/hr/self" && role === "staff") {
    response.end(JSON.stringify({ ...hrSelf("Synthetic Sam", "synthetic-sam"), attendanceEnabled: false }));
    return;
  }
  if (path === "/api/v0/hr/self") {
    const self = { ...hrSelf(me.name, me.person), attendanceEnabled: true };
    if (company?.[2] === "on-leave") self.now = { state: "leave", entry: null, holiday: null, leave: { kind: "annual", halfDay: null } };
    if (identity === "manager-attendance-off@estateautopilots.com") {
      self.attendanceEnabled = false;
      self.team = [{ id: "synthetic-report", name: "Synthetic Report", role: "Editor", pod: "Studio", department: "Creative", userNo: null, photoAt: null, joinedOn: null, canSignIn: false, trackedFrom: null, status: "untracked", attendance: null, sessions: [], entry: null, leave: null }];
      self.approvals.leave = [{ ...hrRequest, id: "synthetic-manager-approval", personId: "synthetic-report", name: "Synthetic Report" }];
    }
    response.end(JSON.stringify(self));
    return;
  }
  if (path === "/api/v0/hr/desk" && role !== "staff") {
    // HR's synthetic tenant has attendance switched off (main's attendance gate); admins see the full desk.
    response.end(JSON.stringify({ ...hrDesk(me.person), attendanceEnabled: role !== "hr" }));
    return;
  }
  if (path === "/api/v0/hr/attendance" && role !== "staff") {
    const month = url.searchParams.get("month") ?? "2026-10";
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
    response.end(JSON.stringify({ attendanceEnabled: role !== "hr", month, from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}`,
      today: "2026-10-06", policy: hrPolicy, dates: hrDates(month), people: [] }));
    return;
  }
  if (path === "/api/v0/hr/leave") {
    if (role === "staff") response.statusCode = 403;
    response.end(JSON.stringify(role === "staff" ? { error: "HR and organisation admins only." } : hrLeave(url.searchParams.get("month") ?? "2026-10", me.person)));
    return;
  }
  if(path==='/api/v0/hr/rules') {
    response.statusCode=['hr','admin'].includes(role)?200:403;
    response.end(JSON.stringify(response.statusCode===200?{today:'2026-10-06',proposals:ruleProposals,versions:[],people:hrPeople.map(p=>({...p,handover:[]})),emergencies:[]}:{error:'HR access required'}));return;
  }
  if(path==='/api/v0/leave/notice') {response.end(JSON.stringify({flag:null}));return;}
  if(path==='/api/v0/leave/emergencies') {response.end(JSON.stringify({rule:null,rows:[]}));return;}
  if (path.startsWith("/api/v0/hr/polic") || ["/api/v0/hr/flow-settings", "/api/v0/hr/work-calendar", "/api/v0/shifts", "/api/v0/hr/presence"].includes(path)) {
    const employee = role === "staff" || role === "person" || role === "manager";
    const send = (status, data) => { response.statusCode = status; response.end(JSON.stringify(data)); };
    if (path === "/api/v0/hr/policies" && request.method === "GET") return send(200, policyList(employee, me.person));
    if (path === "/api/v0/hr/policies/acknowledge" && request.method === "POST") {
      const body = await readJson(request), doc = policyDocs.find((d) => d.id === body.documentId && d.status === "published");
      if (!doc) return send(400, { error: "Please check the selected record and entered values" });
      if (!policyAcks.some((a) => a.document_id === doc.id && a.person_id === me.person)) policyAcks.push({ document_id: doc.id, person_id: me.person, at: "2026-10-06T10:00:00Z" });
      return send(200, { ok: true });
    }
    if (employee) return send(403, { error: "HR and organisation admins only" });
    if (path === "/api/v0/hr/policies/draft" && request.method === "POST") {
      const body = await readJson(request), latest = policyDocs.filter((d) => d.kind === body.kind).sort((a, b) => b.version - a.version)[0];
      if ((latest?.version ?? 0) !== body.version || (latest?.status === "draft" && latest.revision !== body.revision)) return send(409, { error: "This document changed. Refresh before saving your revision." });
      if (String(body.title ?? "").trim().length < 2 || String(body.body ?? "").trim().length < 10) return send(400, { error: "Please check the selected record and entered values" });
      const at = new Date().toISOString();
      if (latest?.status === "draft") { Object.assign(latest, { title: body.title, body: body.body.trim(), revision: latest.revision + 1, updated_at: at, editor: me.name }); return send(200, { id: latest.id, version: latest.version, revision: latest.revision, savedAt: at }); }
      const doc = { id: `synthetic-policy-${body.kind}-${(latest?.version ?? 0) + 1}`, kind: body.kind, title: body.title, body: body.body.trim(), version: (latest?.version ?? 0) + 1, revision: 1, status: "draft", created_by: me.person, author: me.name, editor: null, publisher: null, created_at: at, updated_at: null, published_at: null };
      policyDocs.push(doc); return send(200, { id: doc.id, version: doc.version, revision: 1, savedAt: at });
    }
    if (path === "/api/v0/hr/policies/publish" && request.method === "POST") {
      const body = await readJson(request), doc = policyDocs.find((d) => d.id === body.documentId);
      if (!doc) return send(404, { error: "Please check your request" });
      if (doc.status !== "draft" || doc.revision !== body.revision) return send(409, { error: "This document changed. Refresh before saving your revision." });
      Object.assign(doc, { status: "published", published_at: new Date().toISOString(), publisher: me.name }); return send(200, { id: doc.id, version: doc.version, publishedAt: doc.published_at });
    }
    if (path === "/api/v0/hr/policy") return send(200, { policy: hrPolicy, confirmedBy: null, types: [hrType, { key: "unpaid", name: "Unpaid leave", paid: false, annualDays: null, accrual: "none", carryForwardMax: 0, active: true }], holidays: [{ day: "2026-11-09", name: "Synthetic Festival", optional: false }], today: "2026-10-06", canEdit: true });
    if (path === "/api/v0/hr/policy-attention") return send(200, { rulesUnconfirmed: true, holidays: 2, openingBalances: 0, historyUnlinked: 3, podsWithoutHead: 1, offices: 0 });
    if (path === "/api/v0/hr/flow-settings") return send(200, hrFlowSettings);
    if (path === "/api/v0/hr/work-calendar") return send(200, { today: "2026-10-06", me: me.person, days: [], credits: [], patterns: hrFlowSettings.patterns, work: [{ id: "synthetic-day-off-work", personId: "synthetic-sam", name: "Synthetic Sam", day: "2026-10-11", status: "pending" }], compPolicy: { credit: 1, expiryDays: 90 } });
    if (path === "/api/v0/shifts") return send(200, { shifts: [{ id: "synthetic-shift-day", name: "Synthetic day shift", start: "10:00", end: "19:00", grace: 15 }], assignments: [{ id: "synthetic-assignment", person_id: "synthetic-sam", name: "Synthetic Sam", shift_id: "synthetic-shift-day", mode: "office", valid_from: "2026-09-01", valid_to: null }], people: hrPeople.map((p) => ({ id: p.id, name: p.name })) });
    if (path === "/api/v0/hr/presence") return send(200, { offices: [], dwellMinutes: 3, leaveMinutes: 15, autoCheckIn: false, sites: true, siteCount: 0, siteLimit: 50, canEdit: true });
  }
  // Four isolated sparse-chart cases; existing fixture weeks keep their ordinary shape.
  const chartCount = /^2025-W0[1-4]$/.test(period.week ?? "") ? Number(period.week.slice(-1)) - 1 : 1;
  if (path === "/api/v0/home" && company && role !== "admin") {
    // The synthetic companies' HR and staff homes, with attendance on and leave waiting: every HR panel has data.
    const leave = { id: "synthetic-northwind-leave", personId: "synthetic-sam", name: "Synthetic Sam", fromDate: "2026-10-12", toDate: "2026-10-12", kind: "Paid leave", status: "pending" };
    const home = { role, viewer: me, period, generatedAt: "2026-10-05T10:00:00Z", attendanceEnabled: true,
      freshness: { files: 8, projects: 2, deliveries: 6, lastIndexedAt: "2026-10-05T10:00:00Z" },
      attendance: { headcount: 2, entries: [{ id: "synthetic-northwind-entry", personId: "synthetic-sam", name: "Synthetic Sam", checkedInAt: "2026-10-05T04:00:00Z", checkedOutAt: null }], ownOpen: false, canCheckIn: true, checkedInToday: 1, present: 1 },
      leave: { pending: [leave], onLeaveToday: [], upcoming: [leave] } };
    const trend = Array.from({ length: 12 }, (_, i) => ({ week: `2024-W${String(41 + i).padStart(2, "0")}`, start: shiftDay("2024-10-07", i * 7), deliveries: i % 3, projects: i % 3 ? 1 : 0 }));
    response.end(JSON.stringify(role === "hr"
      ? { ...home, view: "hr", peopleChanges: [{ id: "synthetic-sam", name: "Synthetic Sam", role: "Editor", pod: "Studio", status: "active", createdAt: "2026-09-01T00:00:00Z", activeFrom: "2026-09-01", activeTo: null }] }
      : { ...home, view: "editor", account: identity, deliveries: 2, deliveriesPrev: 1, projects: 1, projectsPrev: 1, drafts: 0, finals: 2, today: 1, yesterday: 0, usual: 1,
        trend, daily: [], topProjects: [{ projectId: "synthetic-northwind-project", projectName: "Synthetic Northwind Project", count: 2, drafts: 0, finals: 2, lastDeliveredAt: "2026-10-05T09:00:00Z" }], recent: [], attention: { total: 0, projects: [] } }));
    return;
  }
  if (path === "/api/v0/home") {
    // Isolated longest-label fixture for the phone dashboard freshness regression.
    const staleFailed = period.week === "2025-W05";
    const trend = Array.from({ length: 12 }, (_, i) => ({ week: `2024-W${String(41 + i).padStart(2, "0")}`, start: shiftDay("2024-10-07", i * 7), deliveries: i >= 12 - chartCount ? i - 8 : 0, projects: i >= 12 - chartCount ? 1 : 0 }));
    response.end(JSON.stringify({ view: "leadership", role: "admin", viewer: me, period, generatedAt: "2026-10-05T10:00:00Z", attendanceEnabled: false,
      freshness: { files: 8, projects: 2, deliveries: 6, lastIndexedAt: staleFailed ? "2026-10-03T10:00:00Z" : "2026-10-05T10:00:00Z",
        ...(staleFailed ? { upstreamAt: "2026-10-03T10:00:00Z", lastRun: { ok: false, error: "Synthetic sync failure", startedAt: "2026-10-05T09:50:00Z" } } : {}) },
      attendance: null, leave: { pending: [], onLeaveToday: [], upcoming: [] }, accounts: [], pods: [],
      deliveries: trend.reduce((n, w) => n + w.deliveries, 0), deliveriesPrev: 0, projects: 2, projectsPrev: 0, drafts: 1, finals: 2,
      today: 0, yesterday: 0, usual: 0, trend, daily: [], topProjects: [], recent: [], attention: { total: 0, projects: [] } }));
    return;
  }
  if (path === "/api/v0/insights") {
    response.end(JSON.stringify({
      period, generatedAt: "2026-10-05T10:00:00Z", weeks: [], mix: [], segments: [], clients: Array.from({ length: chartCount }, (_, i) => ({ clientId: `chart-client-${i}`, name: `Synthetic chart client ${i + 1}`, projects: 1, count: i + 2 })), clientCount: chartCount,
      locations: [], portfolio: { activeClients: chartCount, activeClientsBefore: 0, projects: chartCount }, stages: { delivering: chartCount >= 1 ? 1 : 0, quiet: chartCount >= 2 ? 1 : 0, dormant: chartCount >= 3 ? 1 : 0, noDeliveries: 0 }, quiet: [], quietTotal: 0, pods: [], teams: [],
      people: { headcount: 2, canSignIn: 2, withManager: 0, noPod: 0, noTeam: 0, inToday: 0, onLeave: 0, credited: 1 },
      attendance: [], hrQueue: { leave: 0, corrections: 0 }, ...(company ? { attendanceEnabled: true } : {}), accounts: [
        { account: accounts[0].account, shared: false, purpose: null, personId: accounts[0].holder_person_id, person: "Synthetic Editor", total: 47, recent: 3, inPeriod: 3, lastDelivery: accounts[0].lastDelivery },
        { account: accounts[1].account, shared: true, purpose: null, personId: null, person: null, total: 12, recent: 1, inPeriod: 1, lastDelivery: accounts[1].lastDelivery },
        { account: accounts[2].account, shared: false, purpose: null, personId: accounts[2].holder_person_id, person: "Synthetic Sam", total: 19, recent: 3, inPeriod: 3, lastDelivery: accounts[2].lastDelivery },
      ],
      identity: { recent: 4, total: 59, shared: 1, sharedTotal: 12, credited: 3, unlinked: 0, sharedLogins: 1, unlinkedAccounts: 0 },
    }));
    return;
  }
  const match = path.match(/^\/api\/v0\/editors\/(.+)$/);
  if (match) {
    response.end(JSON.stringify(summary(match[1], period)));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "Synthetic API route not found." }));
});

server.listen(Number(process.env.PORT ?? 8123), "127.0.0.1");

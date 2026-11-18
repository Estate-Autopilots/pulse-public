// AGREEMENTS screenshots (tests/e2e/agreements-shots.mjs): synthetic people, policies and agreements only. The pay
// policy is HR-PEOPLE's own document (people/pay/policy-doc.mjs payPolicyDoc) split by the API's split (policyTerms).
import { DEFAULT_TEMPLATE } from "../../../services/api/src/comp-model.ts";
import { payPolicyDoc } from "../../../apps/web/app/people/pay/policy-doc.mjs";
import { policyTerms } from "../../../packages/invoice-doc/src/agreement-text.js";

const pay = payPolicyDoc({ approvers: "founders", probationApproval: "hr", managers: "none", probationDays: 90, remindDays: 14, noticeProbation: null, noticeConfirmed: 30,
  offerDays: 7, encashBasis: "basic", encashDivisor: 30, recoverMax: 12, components: DEFAULT_TEMPLATE, claimCategories: [{ key: "travel", label: "Travel", cap: 3000 }], claimThreshold: 5000 },
{ company: "Lotus Studio" });
const POLICIES = {
  pay: { id: "agr-pay-3", kind: "pay", title: "Pay policy", version: 3, publishedAt: "2026-11-13T05:30:00Z", publishedBy: "Isha Kapoor", body: pay.body },
  leave: { id: "agr-leave-2", kind: "leave", title: "Leave policy", version: 2 },
  wfh: { id: "agr-wfh-1", kind: "wfh", title: "Work from home policy", version: 1 },
  conduct: { id: "agr-conduct-1", kind: "conduct", title: "Code of conduct", version: 1 },
};
const LEAVE = "# Leave policy\n\n## 1. How much leave\nYou get 18 days of paid leave a year, added each month.\n\n## 2. Asking for leave\nAsk in Pulse at least 3 working days before. Your manager answers within a day.";
const WFH = "# Work from home policy\n\n## 1. When\nUp to 2 days a week, agreed with your manager the week before.\n\n## 2. Being reachable\nKeep Pulse open and answer within an hour during work hours.";
const CONDUCT = "# Code of conduct\n\n## 1. Respect\nBe kind to colleagues and clients.\n\n## 2. Client work\nKeep client work confidential.";
const due = (p) => ({ id: p.id, kind: p.kind, title: p.title, version: p.version, publishedAt: p.publishedAt, publishedBy: p.publishedBy, ...policyTerms(p.body) });
const ack = (p, at, via = "steps", terms = 4, current = true) => ({ documentId: p.id, kind: p.kind, title: p.title, version: p.version, at, via, terms, current });
const OTHERS = [ack(POLICIES.leave, "2026-11-10T06:00:00Z"), ack(POLICIES.wfh, "2026-10-02T06:00:00Z", "steps", 3), ack(POLICIES.conduct, "2026-10-02T06:05:00Z", "steps", 6)];
const EARLIER = [{ documentId: "agr-pay-2", kind: "pay", title: "Pay policy", version: 2, at: "2026-09-01T06:00:00Z", via: "desk", terms: 0, current: false }];

/** Who each synthetic identity is: the mock's person it reads as, and the name on screen. `keep`: an acceptance stays. */
export const PEOPLE = {
  "diya@agreements.test": { as: "staff@example.test", name: "Diya Nair" },
  "kedab@agreements.test": { as: "staff@example.test", name: "Kedab Mifos", keep: true },
  "sana@agreements.test": { as: "staff@example.test", name: "Sana Qipedot", keep: true },
  "aarav@agreements.test": { as: "staff@example.test", name: "Aarav Shah", done: true },
  "isha@agreements.test": { as: "hr@estateautopilots.com", name: "Isha Kapoor", done: true, team: true },
  // AGREEMENTS round 14 Nov: someone new with an offer to answer in Pulse (an offer is answered term by term too).
  "rifob@agreements.test": { as: "staff@example.test", name: "Rifob Iyer", done: true, offer: true },
};
const kept = new Set();

const who = (id, name, extra = {}) => ({ id, name, ...extra });
const TEAM = { scope: "company", people: 12, policies: [
  { ...POLICIES.pay, body: undefined, accepted: ["Isha Kapoor", "Kedab Mifos", "Sana Qipedot", "Vikram Rao", "Lakshmi Pillai", "Farhan Ali", "Meera Jivop", "Tanvi Desai", "Ahoro Menon"]
    .map((n, i) => who(`p-a${i}`, n, { at: `2026-11-1${3 - (i % 2)}T0${i % 9}:30:00Z`, via: "steps" })),
    pending: [who("p-aarav", "Aarav Shah"), who("p-diya", "Diya Nair"), who("p-rifob", "Rifob Iyer", { remindedAt: "2026-11-13T09:00:00Z" })] },
  { ...POLICIES.leave, publishedAt: "2026-11-08T05:30:00Z", accepted: Array.from({ length: 12 }, (_, i) => who(`l-${i}`, ["Isha Kapoor", "Kedab Mifos", "Sana Qipedot", "Vikram Rao", "Lakshmi Pillai", "Farhan Ali", "Meera Jivop", "Tanvi Desai", "Ahoro Menon", "Aarav Shah", "Diya Nair", "Rifob Iyer"][i], { at: "2026-11-10T06:00:00Z", via: "steps" })), pending: [] },
  { ...POLICIES.conduct, publishedAt: "2026-10-01T05:30:00Z", accepted: ["Isha Kapoor", "Kedab Mifos", "Sana Qipedot", "Vikram Rao", "Lakshmi Pillai", "Farhan Ali", "Meera Jivop"].map((n, i) => who(`c-${i}`, n, { at: "2026-10-02T06:00:00Z", via: "steps" })),
    pending: [who("p-aarav", "Aarav Shah"), who("p-ahoro", "Ahoro Menon"), who("p-diya", "Diya Nair"), who("p-rifob", "Rifob Iyer"), who("p-tanvi", "Tanvi Desai")] },
] };
const CONTRACTS = [
  { id: "agr-emp", key: "agr-emp", title: "Employment agreement", status: "active", version: 2, kind: "employment", signedAt: "2026-06-02T06:00:00Z", canAccept: false },
  { id: "agr-nda", key: "agr-nda", title: "Confidentiality agreement (NDA)", status: "active", version: 1, kind: "nda", signedAt: "2026-06-02T06:10:00Z", canAccept: false },
];

// People → Agreements (round 14 Nov): People & pay's offers, where each stands; the team's agreements; people for a new offer.
const offer = (id, name, role, status, extra = {}) => ({ id, personId: `p-${id}`, name, role, status, startOn: "2026-12-01", validUntil: "2026-11-21", probationDays: 90, noticeDays: 15,
  proposedAt: "2026-11-12T06:00:00Z", approvedAt: null, sentAt: null, openedAt: null, answeredAt: null, answerName: null, answerVia: null, letterId: null, signedLetterId: null,
  proposedBy: "Isha Kapoor", approvedBy: null, mine: false, ...extra });
const OFFERS = { writer: true, approver: true, today: "2026-11-14", offers: [
  offer("farhan", "Farhan Ali", "Design intern", "draft", { proposedAt: null, mine: true }),
  offer("rifob", "Rifob Iyer", "Designer", "proposed", { proposedBy: "Meera Jivop" }),
  offer("tanvi", "Tanvi Desai", "Account manager", "sent", { approvedAt: "2026-11-12T09:00:00Z", approvedBy: "Vikram Rao", sentAt: "2026-11-12T10:00:00Z", openedAt: "2026-11-13T08:30:00Z", letterId: "l-tanvi" }),
  offer("ahoro", "Ahoro Menon", "Site supervisor", "accepted", { startOn: "2026-11-03", approvedAt: "2026-10-28T09:00:00Z", approvedBy: "Vikram Rao", sentAt: "2026-10-28T10:00:00Z",
    openedAt: "2026-10-28T12:00:00Z", answeredAt: "2026-10-29T07:00:00Z", answerName: "Ahoro Menon", answerVia: "pulse", letterId: "l-ahoro", signedLetterId: "l-ahoro-signed" }),
] };
const party = (name, role, mine = false) => ({ id: null, key: name, kind: mine ? "company" : "person", role, name, orgId: null, personId: mine ? null : `p-${name}`, onPulse: true, acceptedAt: null,
  acceptedVersion: null, acceptedBy: null, acceptedNote: null, current: true, mine, email: null, signer: null, signKind: null, signImage: null, declinedAt: null, declinedNote: null });
const TEAM_CONTRACTS = [
  { ...CONTRACTS[0], title: "Employment agreement · Ahoro Menon", updatedAt: "2026-11-03T06:00:00Z", parties: [party("Lotus Studio", "employer", true), party("Ahoro Menon", "employee")] },
  { ...CONTRACTS[1], id: "agr-nda-tanvi", key: "agr-nda-tanvi", status: "proposed", signedAt: null, title: "Confidentiality agreement (NDA) · Tanvi Desai", updatedAt: "2026-11-12T06:00:00Z",
    parties: [party("Lotus Studio", "employer", true), party("Tanvi Desai", "employee")] },
];
const PAY_PEOPLE = [["Kabir Rao", "Video editor (proposed)", "candidate"], ["Lakshmi Pillai", "Accountant", "active"], ["Meera Jivop", "Project lead", "active"], ["Sana Qipedot", "Designer", "active"]]
  .map(([name, role, stage], i) => ({ id: `pp-${i}`, name, role, pod: null, department: null, photoAt: null, stage, current: stage === "active", hasRecord: stage === "active" }));
// Rifob's offer to answer: Pulse's offer letter, split as the API splits it (comp.ts letterTerms).
const OFFER_DUE = { id: "agr-offer-rifob", type: "offer", kind: "offer", title: "Offer of employment", role: "Designer", version: 1, publishedAt: "2026-11-13T10:00:00Z", publishedBy: "Vikram Rao", intro: "",
  terms: [
    { key: "o1-your-role-and-start-date", number: null, title: "Your role and start date", text: "We are pleased to offer you the role of Designer at Lotus Studio, starting on 1 Dec 2026." },
    { key: "o2-your-pay", number: null, title: "Your pay", text: "Your salary will be ₹40,000 a month (₹4,80,000 a year, cost to company); the breakdown is below.\n\n| Part | Pay |\n| --- | --- |\n| Basic | ₹20,000 a month · ₹2,40,000 a year |\n| House rent allowance | ₹8,000 a month · ₹96,000 a year |\n| Special allowance | ₹12,000 a month · ₹1,44,000 a year |\n| **Total** | **₹40,000 a month · ₹4,80,000 a year** |" },
    { key: "o3-probation-and-notice", number: null, title: "Probation and notice", text: "Your first 90 days are a probation period, until 28 Feb 2027. During probation either side may end the employment with 15 days' notice; after confirmation the notice period is 30 days." },
    { key: "o4-other-terms", number: null, title: "Other terms", text: "You will work from the Pune studio, Monday to Friday." },
  ], closing: { title: "What happens next", text: "This offer is open until 21 Nov 2026. To accept it, use the link we shared with you, or answer it in Pulse.\n\nWe look forward to working with you." } };

/** Answers the Agreements routes for these identities; null lets the mock answer (as the person they read as). */
export async function answer(url, method, identity, body) {
  const p = PEOPLE[identity]; if (!p) return null;
  const path = url.pathname;
  if (path === "/api/v0/agreements/policies" && method === "GET") {
    const accepted = p.done || kept.has(identity);
    return [200, { due: [...(p.offer ? [OFFER_DUE] : []), ...(accepted ? [] : [due(POLICIES.pay)])], accepted: accepted ? [ack(POLICIES.pay, "2026-11-13T07:12:00Z", "steps", 6), ...OTHERS, ...EARLIER] : [...OTHERS, ...EARLIER], team: !!p.team }];
  }
  const accepting = path.match(/^\/api\/v0\/agreements\/policies\/([^/]+)\/accept$/);
  if (accepting && method === "POST") {
    const keys = policyTerms(POLICIES.pay.body).terms.map((t) => t.key);
    if (accepting[1] !== POLICIES.pay.id || JSON.stringify(body?.terms) !== JSON.stringify(keys)) return [409, { error: "This policy changed while you were reading. Read it again, then accept." }];
    if (p.keep) kept.add(identity);
    return [200, { documentId: POLICIES.pay.id, kind: "pay", version: 3, at: new Date().toISOString(), via: "steps" }];
  }
  if (path === "/api/v0/agreements/team") return [200, TEAM];
  if (path === "/api/v0/agreements/people") return p.team ? [200, OFFERS] : [403, { error: "HR and founders see offers" }];
  if (path === `/api/v0/agreements/offers/${OFFER_DUE.id}/accept` && method === "POST") {
    if (JSON.stringify(body?.terms) !== JSON.stringify(OFFER_DUE.terms.map((t) => t.key))) return [409, { error: "This offer changed while you were reading. Read it again, then accept." }];
    return [200, { documentId: OFFER_DUE.id, kind: "offer", version: 1, at: new Date().toISOString(), via: "steps", letterId: "l-rifob-signed" }];
  }
  if (path === "/api/v0/contracts" && method === "GET" && p.team) return [200, { company: TEAM_CONTRACTS, mine: [], canMake: true, canManage: true, us: { id: "org" }, signedThisMonth: 1, clients: [], people: [], templates: [] }];
  if (path === "/api/v0/comp/people" && method === "GET" && p.team) return [200, { today: "2026-11-14", people: PAY_PEOPLE, figuresHidden: true, can: { read: true, write: true, approve: true }, policy: { approvers: "founders", managers: "none", currency: "INR", remindDays: 14 } }];
  if (path === "/api/v0/hr/policies/agr-pay-3/remind" && method === "POST") return [200, { reminded: 2 }];
  // My desk → Policies: the same company, with the real pay policy waiting and three accepted.
  if (path === "/api/v0/hr/policies" && method === "GET") {
    const accepted = p.done || kept.has(identity);
    const row = (d, body, ack, at) => ({ id: d.id, kind: d.kind, title: d.title, body, version: d.version, revision: 1, status: "published", acknowledged: ack, ackCount: 9,
      created_at: at, updated_at: null, published_at: at, author: "Isha Kapoor", editor: null, publisher: "Isha Kapoor" });
    return [200, { rows: [row(POLICIES.pay, POLICIES.pay.body, accepted, POLICIES.pay.publishedAt), row(POLICIES.leave, LEAVE, true, "2026-11-08T05:30:00Z"),
      row(POLICIES.wfh, WFH, true, "2026-10-01T05:30:00Z"), row(POLICIES.conduct, CONDUCT, true, "2026-10-01T05:30:00Z")], canEdit: false, headcount: 12, versions: [], acks: [], word: null }];
  }
  if (path === "/api/v0/contracts/mine") return [200, { mine: identity === "diya@agreements.test" ? CONTRACTS : [] }];
  return null;
}

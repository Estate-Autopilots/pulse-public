// CONTRACTS-2: the words an agreement says (lib/agreements.mjs) and its text helpers (@pulse/invoice-doc agreement-text).
import assert from "node:assert/strict";
import test from "node:test";
import { ago, chainStep, draftName, eventWords, grouped, linkMessage, linkWords, stageOf, trackOf, whatsappHref } from "./agreements.mjs";
import { agreementClauses, blankLabel, blanksIn, clauseChanges, clauseName, diffLines, fillAgreement, STARTER_AGREEMENT, SHEET_BLANKS, STARTER_SERVICE_AGREEMENT, STARTER_TEMPLATES } from "../../../../packages/invoice-doc/src/agreement-text.js";

const NOW = Date.parse("2026-11-08T10:00:00Z");
const us = "org-us";
const party = (o) => ({ name: "Lotus Interiors", mine: false, orgId: null, current: false, declinedAt: null, ...o });
const ours = party({ name: "Kedab's Studio", orgId: us, current: true });
const base = { status: "proposed", parties: [ours, party()], progress: { sentAt: "2026-11-07T10:00:00Z", openedAt: null, seenAt: null, changes: 0 }, signedAt: null, updatedAt: "2026-11-07T10:00:00Z" };

test("each agreement says where it is, in plain words, with one group to act on", () => {
  assert.deepEqual(stageOf({ ...base, status: "draft" }, us, NOW), { key: "draft", group: "needs_you", label: "Ready to send", tone: "action" });
  assert.equal(stageOf(base, us, NOW).label, "Waiting for Lotus Interiors");
  assert.equal(stageOf({ ...base, progress: { ...base.progress, openedAt: "2026-11-08T08:00:00Z", seenAt: "2026-11-08T08:00:00Z" } }, us, NOW).label, "Opened 2 hours ago");
  assert.equal(stageOf({ ...base, progress: { ...base.progress, changes: 2 } }, us, NOW).label, "Asked for 2 changes");
  assert.equal(stageOf({ ...base, parties: [ours, party({ declinedAt: "2026-11-08T09:00:00Z" })] }, us, NOW).label, "Lotus Interiors said no");
  assert.equal(stageOf({ ...base, status: "active", signedAt: "2026-11-04T06:00:00Z" }, us, NOW).label, "Signed 4 Nov");
  const theyDid = { ...base, parties: [{ ...ours, current: false }, party({ current: true })] };
  assert.equal(stageOf(theyDid, us, NOW).label, "Your signature is missing");
  assert.equal(stageOf({ ...base, status: "cancelled" }, us, NOW).group, "closed");
});

test("the track shows Sent, Opened and Signed", () => {
  assert.deepEqual(trackOf({ status: "draft", progress: null }).map((s) => s.done), [false, false, false]);
  assert.deepEqual(trackOf({ status: "proposed", progress: { openedAt: "x" } }).map((s) => s.done), [true, true, false]);
  assert.deepEqual(trackOf({ status: "active", progress: null }).map((s) => s.done), [true, true, true]);
});

test("the list puts what needs you first and leaves empty groups out", () => {
  const list = [{ ...base, id: "w" }, { ...base, id: "d", status: "draft", updatedAt: "2026-11-08T01:00:00Z" }, { ...base, id: "s", status: "active" }];
  const g = grouped(list, (c) => stageOf(c, us, NOW));
  assert.deepEqual(g.map((x) => [x.key, x.items.map((c) => c.id)]), [["needs_you", ["d"]], ["waiting", ["w"]], ["signed", ["s"]]]);
});

test("time, links and drafts read like a person wrote them", () => {
  assert.equal(ago("2026-11-08T09:59:30Z", NOW), "just now");
  assert.equal(ago("2026-11-08T09:30:00Z", NOW), "30 min ago");
  assert.equal(ago("2026-11-07T08:00:00Z", NOW), "yesterday");
  assert.equal(linkWords("2026-11-21T10:00:00Z", NOW), "The link works until 21 Nov");
  assert.equal(linkWords("2026-11-01T10:00:00Z", NOW), "The link has expired");
  assert.equal(draftName(2, { version: 3, status: "proposed" }), "Draft 2");
  assert.equal(draftName(3, { version: 3, status: "active" }), "Final (draft 3)");
});

test("the activity log says who did what", () => {
  assert.equal(eventWords({ kind: "change_asked", by: "Diya Nair", clause: "2. Price and payment", body: "Can we pay in three parts?" }),
    'Diya Nair asked for a change in "2. Price and payment": "Can we pay in three parts?"');
  assert.equal(eventWords({ kind: "prepared", via: "auto", body: "From quotation Q-12" }), "Vitals OS made the agreement by itself (from quotation Q-12)"); // CONTRACTS-3: the number keeps its capitals
  assert.equal(eventWords({ kind: "opened", by: "Diya Nair", via: "link" }), "Diya Nair opened the link");
});

test("sharing the link opens WhatsApp with the message (nothing is sent by Vitals OS)", () => {
  const msg = linkMessage({ them: "Diya", us: "Kedab's Studio", title: "Nair residence", url: "https://example.test/accept/sign/x", until: "The link works until 21 Nov" });
  assert.match(msg, /^Hello Diya, here is our agreement "Nair residence" from Kedab's Studio\./);
  assert.match(msg, /\(the link works until 21 Nov\)/);
  assert.equal(whatsappHref("hi", "90000 12345"), "https://wa.me/919000012345?text=hi");
  assert.equal(whatsappHref("hi"), "https://wa.me/?text=hi");
});

test("an agreement's words split into clauses by their headings", () => {
  const c = agreementClauses("Intro line.\n\n1. Scope of work\nWe paint.\n1. Design: ₹85,000\n\n## Payment terms\nPay half now.\n2. This is a long numbered sentence that ends with a full stop.\n");
  assert.deepEqual(c.map((x) => [x.number, x.title]), [[null, ""], [1, "Scope of work"], [null, "Payment terms"]]);
  assert.match(c[2].text, /long numbered sentence/);
  assert.match(c[1].text, /1\. Design: ₹85,000/, "a priced line stays in its clause");
  assert.equal(clauseName(c[1]), "1. Scope of work");
  assert.equal(clauseName(c[0]), "Opening");
  assert.ok(agreementClauses(STARTER_AGREEMENT).length >= 7);
});

test("the Master Service Agreement: In short first, ten parts, the Schedule last; the sheet's blanks stay to fill in", () => {
  const parts = agreementClauses(STARTER_SERVICE_AGREEMENT).filter((x) => x.title).map((x) => x.title);
  assert.deepEqual(parts, ["In short", "The services", "Fee and GST", "Monthly invoice and payment", "What you provide", "Your data", "Confidentiality",
    "What each side owns", "Changes and reviews", "Ending this agreement", "Law and courts", "Schedule (the detailed sheet)"]);
  const filled = fillAgreement(STARTER_SERVICE_AGREEMENT, { our_legal_name: "Synthetic Labs Pvt Ltd", our_address: "Plot 4", client_name: "Lotus Interiors", client_address: "Baner",
    document_number: "Q-12", document_date: "1 Nov 2026", items: "• Platform: ₹47,200", total: "₹47,200", today: "15 Nov 2026" });
  assert.deepEqual(blanksIn(filled), ["notice_days", "start_date", "review_date", "court_city", "ai_employees", "users", "support_hours", "client_provides"]);
  assert.deepEqual(blanksIn(filled).every((k) => SHEET_BLANKS.some((b) => b.key === k)), true, "every blank left is one the sheet asks for");
  assert.equal(blankLabel("users"), "People who use it");
  assert.match(filled, /Your data stays your property/);
  assert.deepEqual(STARTER_TEMPLATES.map((t) => [t.key, t.name]), [["standard", "Standard agreement"], ["msa", "Master Service Agreement"]]);
});

test("blanks are filled from the document; a missing one stays visible", () => {
  assert.deepEqual(blanksIn("{{client_name}} and {{ total }} and {{client_name}}"), ["client_name", "total"]);
  assert.equal(fillAgreement("For {{client_name}}, GSTIN {{ client_gstin }}.", { client_name: "Lotus Interiors" }), "For Lotus Interiors, GSTIN {{client_gstin}}.");
});

test("drafts compare line by line and name the clauses that changed", () => {
  const a = "1. Price\nPay ₹1,00,000.\n\n2. Dates\nStart 15 Nov.", b = "1. Price\nPay ₹1,20,000.\n\n2. Dates\nStart 15 Nov.\n\n3. Changes\nIn writing.";
  const d = diffLines(a, b);
  assert.deepEqual(d.filter((x) => x.kind !== "same").map((x) => `${x.kind}:${x.text}`), ["removed:Pay ₹1,00,000.", "added:Pay ₹1,20,000.", "added:", "added:3. Changes", "added:In writing."]);
  assert.deepEqual(clauseChanges(a, b), { changed: ["1. Price"], added: ["3. Changes"], removed: [] });
});

test("lead → live: eight steps, who acts next, one sentence and one next step on each page", () => {
  const q = { number: "Q-12", docType: "quotation", status: "accepted", client: "Lotus Interiors" };
  const can = { agreement: false, invoice: false, onboarding: false };
  const at = (chain, page = "quote") => chainStep({ quote: q, agreement: null, invoice: null, onboarding: null, can, ...chain }, page);
  let s = at({ step: 1, quote: { ...q, status: "issued" } });
  assert.deepEqual(s.steps, ["Lead", "Quote", "Agreement", "Client signs", "Both sign", "Invoice", "Onboarding", "Live"]);
  assert.deepEqual([s.current, s.next, s.then, s.who, s.action, s.percent], [1, "Quote", "Agreement", "Lotus Interiors", null, 13]);
  s = at({ step: 2, can: { ...can, agreement: true } });
  assert.deepEqual([s.who, s.action?.kind, s.text], ["You", "make-agreement", "Lotus Interiors accepted quotation Q-12. Make the agreement: it fills itself from the quotation and your template."]);
  assert.equal(at({ step: 2 }).who, "Admins, leadership, Finance or the seller");
  const draft = { id: "a1", status: "draft" };
  assert.equal(at({ step: 2, agreement: draft }).action?.kind, "open-agreement");
  assert.equal(at({ step: 2, agreement: draft }, "agreement").action, null, "the agreement's own page has Send to sign");
  assert.equal(at({ step: 2, agreement: { id: "a1", status: "cancelled" }, can: { ...can, agreement: true } }).action?.label, "Make a new agreement");
  const sent = { id: "a1", status: "proposed", seenAt: null, asks: 0, waitingFor: ["Lotus Interiors", "Kedab's Studio"] };
  assert.deepEqual([at({ step: 3, agreement: sent }).who, at({ step: 3, agreement: sent }).text], ["Lotus Interiors", "Sent. Waiting for Lotus Interiors to open it, comment or sign."]);
  assert.match(at({ step: 3, agreement: { ...sent, seenAt: "2026-11-15T09:00:00Z" } }).text, /opened it/);
  s = at({ step: 3, agreement: { ...sent, asks: 2 } });
  assert.deepEqual([s.who, s.text], ["You", "Lotus Interiors asked for 2 changes. Answer, and they sign the new draft."]);
  // Once the client signed, the side still to sign is yours.
  const ours = "Kedab's Studio";
  s = at({ step: 4, agreement: { ...sent, waitingFor: [ours] } });
  assert.deepEqual([s.who, s.text], ["You", `Lotus Interiors signed. Now you sign for ${ours}.`]);
  s = at({ step: 5, agreement: { id: "a1", status: "active" }, can: { ...can, invoice: true } }, "agreement");
  assert.deepEqual([s.who, s.action?.kind], ["Finance", "make-invoice"]);
  // A draft invoice says so; on its own page Issue stays the main button, so the card's Start onboarding is quiet.
  const inv = { id: "i1", number: null, status: "draft" };
  s = at({ step: 6, agreement: { id: "a1", status: "active" }, invoice: inv, can: { ...can, onboarding: true } }, "invoice");
  assert.deepEqual([s.current, s.next, s.action?.kind, s.quiet, s.text], [6, "Onboarding", "start-onboarding", true,
    "This invoice is a draft: check it below and issue it. Start the onboarding now (a project with its tasks from quotation Q-12), or it starts when the invoice is paid."]);
  s = at({ step: 6, agreement: { id: "a1", status: "active" }, invoice: { ...inv, number: "INV-3" } });
  assert.deepEqual([s.action?.label, s.quiet, s.text], ["Check the invoice", false, "Invoice INV-3 is made as a draft. Leadership or Finance start the onboarding."]);
  s = at({ step: 6, quote: { ...q, status: "converted" }, agreement: { id: "a1", status: "active" }, invoice: { ...inv, number: "INV-3", status: "issued" } });
  assert.deepEqual([s.who, s.action?.label, s.text], ["Billing", "Open the invoice", "Invoice INV-3 is issued. The onboarding project starts when the invoice is paid."]);
  // While the onboarding's tasks run, the flow is on "Onboarding", not "Live".
  s = at({ step: 7, invoice: { ...inv, status: "issued" }, onboarding: { projectId: "p1", tasks: 5, done: 2 } });
  assert.deepEqual([s.current, s.next, s.who, s.action?.kind, s.text], [6, "Onboarding", "The team", "open-onboarding", "Onboarding: 2 of 5 tasks done. Lotus Interiors is live when all are done."]);
  s = at({ step: 8, invoice: { ...inv, status: "issued" }, onboarding: { projectId: "p1", tasks: 5, done: 5 } });
  assert.deepEqual([s.current, s.next, s.who, s.percent, s.text], [8, null, null, 100, "Lotus Interiors is live. Every step is done."]);

  assert.equal(chainStep({ quote: { ...q, docType: "proforma", status: "issued" }, agreement: null, invoice: null, can, step: 2 }, "quote").steps[1], "Proforma");
});

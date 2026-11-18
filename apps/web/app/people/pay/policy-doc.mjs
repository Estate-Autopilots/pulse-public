// HR-PEOPLE (owner, 13 Nov 2026, T1.1.10–11: "When you input data in here, we should also connect it to a document … the
// document is already filled with … lines and grammar … designed for work, in which we are adding these numbers"): the
// pay policy's answers, as five plain sentences and as the written policy everyone accepts. Plain data, no React: the
// Pay policy page shows it beside the questions, publishing saves it as the company's "pay" policy document (HR policy
// documents, migration 2041), and AGREEMENTS' acceptance view reads that document. policy-doc.test.mjs checks the words
// and that the split agrees with the API's (services/api/src/comp-model.ts splitPay).

/** @typedef {{ key: string; label: string; kind: "earning" | "employer" | "deduction"; of?: string; pct?: number; cap?: number; balance?: boolean }} Component */
/** @typedef {{ approvers: string; probationApproval: string; managers: string; probationDays: number; remindDays: number; noticeProbation: number | null;
 *   noticeConfirmed: number | null; offerDays: number; encashBasis: string; encashDivisor: number; recoverMax: number; components: Component[];
 *   claimCategories?: { key: string; label: string; cap?: number }[]; claimThreshold?: number | null }} PayPolicy */

/** The example a month the page and the document use to show the split. */
export const EXAMPLE_GROSS = 4000000; // ₹40,000 in paise
/** The exit rule's notice when the pay policy leaves it empty (the form's placeholders). */
export const NOTICE_DEFAULT = { probation: 15, confirmed: 30 };

/** The company's structure applied to a monthly gross (paise), as the API does it (comp-model.ts splitPay).
 *  @param {number} gross @param {Component[]} template */
export function splitPay(gross, template) {
  /** @type {Record<string, number>} */
  const out = {};
  const list = Array.isArray(template) ? template : [];
  const earning = list.filter((c) => c.kind === "earning"), others = list.filter((c) => c.kind !== "earning");
  const base = (/** @type {Component} */ c) => (c.of === "gross" || !c.of ? gross : out[c.of] ?? 0);
  for (const c of earning.filter((c) => !c.balance)) out[c.key] = Math.min(c.cap ?? Infinity, Math.round((base(c) * (Number(c.pct) || 0)) / 100));
  const used = Object.values(out).reduce((a, b) => a + b, 0);
  const bal = earning.find((c) => c.balance);
  if (bal) out[bal.key] = Math.max(0, gross - used);
  else if (used !== gross && earning.length) out[earning[earning.length - 1].key] += gross - used;
  for (const c of others) out[c.key] = Math.min(c.cap ?? Infinity, Math.round((base(c) * (Number(c.pct) || 0)) / 100));
  const employer = others.filter((c) => c.kind === "employer").reduce((a, c) => a + out[c.key], 0);
  return { components: out, employer, ctc: 12 * (gross + employer) };
}

/** Paise as rupees with Indian grouping (₹1,18,000), the same as model.ts rupees. @param {number} paise */
export function inr(paise) {
  const n = Math.round(paise), sign = n < 0 ? "−" : "", abs = Math.abs(n), whole = String(Math.floor(abs / 100)), part = abs % 100;
  const last3 = whole.slice(-3), rest = whole.slice(0, -3);
  return `${sign}₹${rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3}${part ? `.${String(part).padStart(2, "0")}` : ""}`;
}

const days = (/** @type {number} */ n) => `${n} ${n === 1 ? "day" : "days"}`;
const months = (/** @type {number} */ n) => `${n} ${n === 1 ? "month" : "months"}`;
const APPROVER = { founders: "a founder", leadership: "leadership", second_hr: "a second person in HR" };
const ofWord = (/** @type {Component} */ c, /** @type {Component[]} */ all) => c.of === "gross" || !c.of ? "gross pay" : all.find((x) => x.key === c.of)?.label ?? c.of;

/** How one part of the split is worked out, in words: "50% of gross pay", "12% of Basic, at most ₹1,800 a month", "the rest".
 *  @param {Component} c @param {Component[]} all */
export function partRule(c, all) {
  if (c.balance) return "the rest";
  return `${Number(c.pct) || 0}% of ${ofWord(c, all)}${c.cap ? `, at most ${inr(c.cap)} a month` : ""}`;
}

/**
 * The five answers as plain sentences (the page's question cards) and the policy as a document (Markdown, the same
 * format HR policy documents use). `numbers` lists every figure the document took from the answers, so the page can
 * highlight where each comes from.
 * @param {PayPolicy} p @param {{ company?: string; head?: string }} [ctx] `head`: who approves a claim first, in the company's words ("pod head")
 */
export function payPolicyDoc(p, ctx = {}) {
  const approver = APPROVER[/** @type {keyof typeof APPROVER} */ (p.approvers)] ?? "a founder";
  const noticeP = p.noticeProbation ?? NOTICE_DEFAULT.probation, noticeC = p.noticeConfirmed ?? NOTICE_DEFAULT.confirmed;
  const components = Array.isArray(p.components) ? p.components : [];
  const split = splitPay(EXAMPLE_GROSS, components);
  const earn = components.filter((c) => c.kind === "earning"), employer = components.filter((c) => c.kind === "employer");
  const dayPay = p.encashDivisor === 26 ? "monthly pay ÷ 26 working days" : "monthly pay ÷ 30";
  const encash = p.encashBasis === "none" ? "Unused leave is not paid out." : `Unused leave is paid out at ${p.encashBasis === "gross" ? "gross" : "Basic"} pay ÷ ${p.encashDivisor} for each day.`;
  const answers = [
    { key: "approve", title: "Who approves pay", sentence: `${approver.charAt(0).toUpperCase()}${approver.slice(1)} approves every pay change, offer, pause and bonus. HR proposes it.`,
      more: p.probationApproval === "founder" ? "A founder approves confirming or extending probation." : "HR records the end of probation." },
    { key: "probation", title: "Probation", sentence: `Probation is ${days(p.probationDays)}, with a reminder ${days(p.remindDays)} before it ends.`,
      more: `An offer stays open for ${days(p.offerDays)}.` },
    { key: "notice", title: "Notice", sentence: `Notice is ${days(noticeP)} during probation and ${days(noticeC)} after it.`, more: "" },
    { key: "day", title: "A day's pay and advances", sentence: `A day's pay is ${dayPay}. An advance or loan is paid back within ${months(p.recoverMax)}.`, more: encash },
    { key: "split", title: "Salary split", sentence: earn.length ? `${earn.map((c) => `${c.label}: ${partRule(c, components)}`).join("; ")}.` : "Pay is one amount a month, not split.",
      more: employer.length ? `The company also pays ${employer.map((c) => `${c.label} (${partRule(c, components)})`).join(", ")}.` : "" },
  ];
  const company = ctx.company?.trim() || "the company";
  const rows = [...earn, ...employer].map((c) => `| ${c.label}${c.kind === "employer" ? " (paid by the company)" : ""} | ${partRule(c, components)} | ${inr(split.components[c.key] ?? 0)} |`);
  const claims = (p.claimCategories ?? []).filter((c) => c.label?.trim());
  const body = [
    `This policy says how pay works at ${company}. It applies to everyone on the team. If anything here is unclear, ask HR before you accept it.`,
    "",
    "## 1. Who approves pay",
    `${answers[0].sentence} Nobody approves a change they proposed, and nobody decides their own pay. ${answers[0].more}`,
    "",
    "## 2. Probation and offers",
    `${answers[1].sentence} Your manager and HR review your work before probation ends. ${answers[1].more}`,
    "",
    "## 3. Notice",
    `${answers[2].sentence} Notice is counted in calendar days from the day you tell HR in writing.`,
    "",
    "## 4. A day's pay, leave and advances",
    `${answers[3].sentence} ${encash}`,
    "",
    "## 5. How your salary is split",
    earn.length ? `Your monthly gross pay is split into these parts. For example, for ${inr(EXAMPLE_GROSS)} a month:` : answers[4].sentence,
    ...(earn.length ? ["", "| Part | How it is worked out | For " + inr(EXAMPLE_GROSS) + " a month |", "| --- | --- | --- |", ...rows] : []),
    ...(claims.length ? ["", "## 6. Claims", `You can claim money you spent for work: ${claims.map((c) => `${c.label}${c.cap ? ` (up to ${inr(c.cap * 100)} a month)` : ""}`).join(", ")}. Your ${ctx.head?.trim() || "manager"} approves a claim${p.claimThreshold ? `; above ${inr(p.claimThreshold * 100)}, HR or a founder approves it too` : ""}.`] : []),
    "",
    "## What happens next",
    "Read each part, then accept the policy. HR keeps a record of who accepted which version and when. When this policy changes, you will be asked to read and accept the new version.",
  ].join("\n");
  /** Every figure the document took from the answers, for the page's highlights. */
  const numbers = [String(p.probationDays), String(p.remindDays), String(p.offerDays), String(noticeP), String(noticeC), String(p.recoverMax), ...Object.values(split.components).map(inr)];
  return { title: "Pay policy", answers, body, split, numbers };
}

/** The fields each answer card changes (the page opens just those when its Change is pressed). */
export const ANSWER_FIELDS = Object.freeze({
  approve: ["approvers", "probationApproval", "managers"],
  probation: ["probationDays", "remindDays", "offerDays"],
  notice: ["noticeProbation", "noticeConfirmed"],
  day: ["encashDivisor", "encashBasis", "recoverMax"],
  split: ["components"],
});

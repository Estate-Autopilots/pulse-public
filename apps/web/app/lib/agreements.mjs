// CONTRACTS-2 (owner, 8 Nov 2026): what an agreement says on the screens, in plain words (grade 6-7), in one place so
// the list, an agreement's page and the client's signing page agree (agreements.test.mjs). The data comes from
// services/api/src/contracts.ts and contract-signing.ts (migration 1850).
import { FALLBACK_ZONE } from "./zone.mjs";

/** The groups of the list, in the order people act on them. */
export const GROUPS = Object.freeze([
  { key: "needs_you", label: "Needs you" },
  { key: "waiting", label: "Waiting for the client" },
  { key: "signed", label: "Signed" },
  { key: "closed", label: "Ended" },
]);

const day = (iso, timeZone) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone });

/** How long ago, in words: "just now", "5 min ago", "2 hours ago", "yesterday", "3 days ago", else the date.
 * @param {string | null} iso @param {number} now @param {string} [timeZone] */
export function ago(iso, now, timeZone = FALLBACK_ZONE) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) { const h = Math.round(s / 3600); return `${h} hour${h === 1 ? "" : "s"} ago`; }
  if (s < 2 * 86400) return "yesterday";
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return `on ${day(iso, timeZone)}`;
}

/**
 * Where an agreement is, for whoever runs it: { key, group, label, tone }. tone: "action" (do something), "wait",
 * "good", "bad", "muted". The client's name goes into the words ("Waiting for Lotus Interiors").
 * @param {{ status: string; parties: { name: string; mine: boolean; orgId: string | null; current: boolean; declinedAt?: string | null }[];
 *   progress?: { sentAt: string | null; openedAt: string | null; seenAt: string | null; changes: number } | null; signedAt?: string | null; endedOn?: string | null }} c
 * @param {string | null} us this company's id @param {number} now @param {string} [timeZone]
 */
export function stageOf(c, us, now, timeZone = FALLBACK_ZONE) {
  const others = c.parties.filter((p) => !p.mine && (!us || p.orgId !== us));
  const them = others.map((p) => p.name).join(", ") || "the other side";
  const p = c.progress ?? null;
  if (c.status === "ended" || c.status === "cancelled") return { key: c.status, group: "closed", label: c.status === "ended" ? "Ended" : "Stopped", tone: "muted" };
  if (c.status === "active") return { key: "signed", group: "signed", label: c.signedAt ? `Signed ${day(c.signedAt, timeZone)}` : "Signed", tone: "good" };
  if (c.status === "draft") return { key: "draft", group: "needs_you", label: "Ready to send", tone: "action" };
  const declined = others.find((x) => x.declinedAt);
  if (declined) return { key: "declined", group: "needs_you", label: `${declined.name} said no`, tone: "bad" };
  if (p && p.changes > 0) return { key: "changes", group: "needs_you", label: p.changes === 1 ? "Asked for a change" : `Asked for ${p.changes} changes`, tone: "action" };
  const ours = c.parties.filter((x) => x.mine || (us && x.orgId === us));
  if (ours.length && ours.some((x) => !x.current) && others.every((x) => x.current)) return { key: "sign_ours", group: "needs_you", label: "Your signature is missing", tone: "action" };
  if (p?.openedAt) return { key: "opened", group: "waiting", label: `Opened ${ago(p.seenAt ?? p.openedAt, now, timeZone)}`, tone: "wait" };
  return { key: "waiting", group: "waiting", label: `Waiting for ${them}`, tone: "wait" };
}

/** The three dots on a row: Sent › Opened › Signed, each done or not. @param {{ status: string; progress?: { sentAt: string | null; openedAt: string | null } | null }} c */
export function trackOf(c) {
  const sent = c.status !== "draft";
  const signed = c.status === "active" || c.status === "ended";
  const opened = signed || !!c.progress?.openedAt;
  return [{ key: "sent", label: "Sent", done: sent }, { key: "opened", label: "Opened", done: opened }, { key: "signed", label: "Signed", done: signed }];
}

/** Agreements in their groups, the newest first in each; empty groups left out. @template {{ updatedAt: string }} T
 * @param {T[]} list @param {(c: T) => { group: string }} stage */
export function grouped(list, stage) {
  return GROUPS.map((g) => ({ ...g, items: list.filter((c) => stage(c).group === g.key).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) })).filter((g) => g.items.length);
}

/** "From quotation QT/26-27/0001" → "from quotation QT/26-27/0001" (the number keeps its capitals). @param {string} t */
const lowerFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1);

/** A line of the activity log in words. @param {{ kind: string; by?: string | null; via?: string; clause?: string | null; body?: string | null }} e */
export function eventWords(e) {
  const who = e.by || (e.via === "auto" ? "Vitals OS" : "Someone");
  switch (e.kind) {
    case "made": return `${who} made the agreement${e.body ? ` (${lowerFirst(e.body)})` : ""}`;
    case "prepared": return `Vitals OS made the agreement by itself${e.body ? ` (${lowerFirst(e.body)})` : ""}`;
    case "sent": return `${who} sent it to sign${e.body ? `. ${e.body}` : ""}`;
    case "opened": return `${who} opened the link`;
    case "viewed": return `${who} looked at it again`;
    case "signed": return e.body || `${who} signed`;
    case "declined": return `${who} said no${e.body ? `: "${e.body}"` : ""}`;
    case "commented": return `${who} wrote${e.clause ? ` on "${e.clause}"` : ""}: "${e.body ?? ""}"`;
    case "change_asked": return `${who} asked for a change${e.clause ? ` in "${e.clause}"` : ""}: "${e.body ?? ""}"`;
    case "new_draft": return `${who} made a new draft`;
    case "link_stopped": return `${who} stopped the signing link`;
    case "draft_proposed": return `${who} proposed a new draft${e.body ? ` (${e.body})` : ""}`;
    default: return `${who}: ${e.kind}`;
  }
}

/** A draft's name: the first ones are "Draft 1", "Draft 2"…; the one everyone signed is "Final". @param {number} version @param {{ version: number; status: string }} c */
export const draftName = (version, c) => (version === c.version && (c.status === "active" || c.status === "ended") ? `Final (draft ${version})` : `Draft ${version}`);

/** Days left on a link, in words: "Works until 21 Nov", "Ends today", "Expired". @param {string | null} iso @param {number} now @param {string} [timeZone] */
export function linkWords(iso, now, timeZone = FALLBACK_ZONE) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (t < now) return "The link has expired";
  if (t - now < 86400000) return "The link ends today";
  return `The link works until ${day(iso, timeZone)}`;
}

/** WhatsApp's own share link with the message (it opens WhatsApp on this phone or computer; Vitals OS sends nothing).
 * @param {string} message @param {string | null} [phone] digits only, with the country code */
export function whatsappHref(message, phone = null) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return `https://wa.me/${digits.length >= 10 ? (digits.length === 10 ? `91${digits}` : digits) : ""}?text=${encodeURIComponent(message)}`;
}

/** The message that goes with the link, ready to paste. @param {{ them: string; us: string; title: string; url: string; until: string }} m */
export const linkMessage = (m) => `Hello ${m.them}, here is our agreement "${m.title}" from ${m.us}. Please read it and sign on your phone: ${m.url} (${m.until.charAt(0).toLowerCase()}${m.until.slice(1)}). No account needed. Thank you!`;


// ------------------------------------------------------------------------------------------------ CONTRACTS-3
const PAYS = ["client", "employer"], PAID = ["provider", "employee"];
const SCHEDULE_WORDS = { monthly: "Every month", quarterly: "Every 3 months", milestones: "In parts", on_delivery: "On delivery", one_off: "Once" };
const UNIT_WHEN = { month: "Every month", hour: "Per hour", deliverable: "On delivery", one_off: "", percent: "As a share" };
const GETS = { services: "The work in this agreement", retainer: "Work every month", employment: "Their work", revenue_share: "A share of the revenue", equity: "A share in the company" };
const shortDay = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * Who pays whom (CONTRACTS-3, read-only): the side that pays and the side that is paid, the total, the parts with when
 * and where each one is, how much is paid, the next part due, and the quotation or invoice it comes from. The money
 * comes from the bills and payments recorded under the agreement; else its price lines (the quotation's items); the
 * total and due date from the document it was made from.
 * @param {{ kind: string; schedule: string; currency: string; parties: { key: string; role: string; name: string }[];
 *   rates: { label: string; amountMinor: number; unit: string }[];
 *   transactions: { payer: string; payee: string; label: string; amountMinor: number; status: string; dueOn: string | null; paidOn: string | null }[] }} c
 * @param {{ total?: number | null; dueDate?: string | null; documentNumber?: string | null; documentType?: string | null; documentId?: string | null } | null} source total in paise
 * @param {string} today YYYY-MM-DD in the company's zone
 */
export function moneyFlow(c, source, today) {
  const live = c.transactions.filter((t) => t.status !== "void");
  const byKey = (k) => c.parties.find((p) => p.key === k) ?? null;
  let payer = live[0] ? byKey(live[0].payer) : c.parties.find((p) => PAYS.includes(p.role)) ?? null;
  let payee = live[0] ? byKey(live[0].payee) : c.parties.find((p) => PAID.includes(p.role) && p !== payer) ?? null;
  if (!payer || !payee || payer === payee) { payer = c.parties[1] ?? null; payee = c.parties[0] ?? null; }
  const txns = live.filter((t) => payer && payee && t.payer === payer.key && t.payee === payee.key);
  /** @type {{ label: string; amountMinor: number; when: string; state: "paid" | "due" | "late" | "billed" | "later" }[]} */
  let parts;
  if (txns.length) {
    parts = txns.map((t) => ({ label: t.label, amountMinor: t.amountMinor,
      state: t.status === "paid" ? "paid" : !t.dueOn ? "later" : t.dueOn < today ? "late" : "due",
      when: t.status === "paid" ? (t.paidOn ? `Paid ${shortDay(t.paidOn)}` : "Paid") : t.dueOn ? `${t.dueOn < today ? "Was due" : "Due"} ${shortDay(t.dueOn)}` : "Not due yet" }));
  } else {
    parts = c.rates.filter((r) => r.unit !== "percent" && r.amountMinor > 0).map((r) => ({ label: r.label, amountMinor: r.amountMinor, state: "later",
      when: UNIT_WHEN[r.unit] ?? "" }));
  }
  if (!txns.length && parts.length === 1 && !parts[0].when) parts[0] = { ...parts[0], when: "The full amount" };
  const monthly = !txns.length && c.rates.length > 0 && c.rates.every((r) => r.unit === "month");
  const sum = parts.reduce((s, x) => s + x.amountMinor, 0);
  const totalMinor = !txns.length && source?.total ? Math.round(Number(source.total)) : sum;
  const paidMinor = parts.filter((x) => x.state === "paid").reduce((s, x) => s + x.amountMinor, 0);
  const open = txns.filter((t) => t.status === "billed").sort((a, b) => String(a.dueOn ?? "9999").localeCompare(String(b.dueOn ?? "9999")))[0];
  const next = open ? { amountMinor: open.amountMinor, when: open.dueOn ? `${open.dueOn < today ? "was due" : "due"} on ${shortDay(open.dueOn)}` : "billed", late: !!open.dueOn && open.dueOn < today, full: false }
    : !txns.length && source?.dueDate && totalMinor ? { amountMinor: totalMinor, when: `due on ${shortDay(source.dueDate)}`, late: source.dueDate < today, full: true } : null;
  const docWord = { quotation: "quotation", proforma: "proforma", invoice: "invoice" }[source?.documentType ?? ""] ?? "document";
  return {
    payer, payee, currency: c.currency, totalMinor, per: monthly ? "month" : null, parts, paidMinor,
    paidPct: totalMinor > 0 ? Math.min(100, Math.round((paidMinor / totalMinor) * 100)) : 0,
    next, schedule: SCHEDULE_WORDS[c.schedule] ?? "",
    gets: (c.kind === "services" || c.kind === "retainer") && c.rates.length ? c.rates.slice(0, 2).map((r) => r.label).join(", ") + (c.rates.length > 2 ? ` and ${c.rates.length - 2} more` : "")
      : GETS[c.kind] ?? "What this agreement says",
    document: source?.documentNumber ? { label: `${docWord} ${source.documentNumber}`, id: source.documentId ?? null } : null,
  };
}

/** A clause's words of a comparison as plain text, for screen readers ("added: …, taken out: …").
 * @param {{ kind: string; text: string }[]} words */
export const changeWords = (words) => words.filter((w) => w.kind !== "same" && w.text.trim()).map((w) => `${w.kind === "added" ? "added" : "taken out"}: ${w.text.trim()}`).join("; ");

/** AGREEMENTS rounds 3–4 (owner, 14–15 Nov 2026: "quote → accepted → agreement → invoice"; "show me step by step how
 *  things work"): the contract flow's eight steps, the one that waits, who acts next, one sentence and one next action, for
 *  the page it is shown on ("quote", "invoice" or "agreement": the agreement's own page has Send to sign and Sign itself,
 *  so it offers no "Open the agreement"). The chain is GET /api/v0/agreements/chain; `step` 8 means all done.
 *  LAND-CAPTAIN-11 (15 Nov 2026, the judge's round on rounds 3–4): a step is named for what it is, not as if already
 *  done ("Agreement", not "Agreement sent"); once the client signed, the side still to sign is yours ("Next: You"); a
 *  draft invoice says so, and its page's own Issue stays the main button (the card's Start onboarding is an ordinary one:
 *  `quiet`); while the onboarding's tasks run the flow is on "Onboarding", and "Live" is ticked only when all are done.
 * @param {{ quote: { number: string | null; docType: string; status: string; client: string | null } | null;
 *   agreement: { id: string; status: string; seenAt?: string | null; asks?: number; waitingFor?: string[] } | null;
 *   invoice: { id: string; number: string | null; status: string } | null;
 *   onboarding?: { projectId: string; tasks: number; done: number } | null;
 *   step: number; can: { agreement: boolean; invoice: boolean; onboarding?: boolean } }} chain
 * @param {"quote" | "invoice" | "agreement"} page */
export function chainStep(chain, page) {
  const q = chain.quote, a = chain.agreement, inv = chain.invoice, ob = chain.onboarding ?? null;
  const doc = q?.docType === "proforma" ? "proforma" : "quotation";
  const steps = ["Lead", q?.docType === "proforma" ? "Proforma" : "Quote", "Agreement", "Client signs", "Both sign", "Invoice", "Onboarding", "Live"];
  const num = q?.number ? `${doc} ${q.number}` : `the ${doc}`;
  const client = q?.client || "The client", them = q?.client || "the client";
  const invName = inv?.number ? `Invoice ${inv.number}` : "The invoice";
  const draftInvoice = !!inv && inv.status === "draft";
  // The API's step 7 ("Live" waits while the onboarding's tasks run) is shown as "Onboarding".
  let current = Math.min(8, Math.max(0, chain.step));
  if (current === 7) current = 6;
  let quiet = false;
  /** @typedef {{ kind: "make-agreement" | "open-agreement" | "make-invoice" | "open-invoice" | "start-onboarding" | "open-onboarding"; label: string }} ChainAction */
  /** @type {ChainAction | null} */
  let action = null;
  let text = "", who = /** @type {string | null} */ (null);
  const openAgreement = () => { if (page !== "agreement" && a) action = { kind: "open-agreement", label: "Open the agreement" }; };
  if (current <= 1) { who = client; text = `${client} accepts ${num}. Then the agreement is made from it.`; }
  else if (current === 2 && (!a || a.status === "cancelled")) {
    text = a ? `The agreement was stopped. Make a new one from ${num}.` : `${client} accepted ${num}. Make the agreement: it fills itself from the quotation and your template.`;
    if (chain.can.agreement) { who = "You"; action = { kind: "make-agreement", label: a ? "Make a new agreement" : "Make the agreement" }; }
    else { who = "Admins, leadership, Finance or the seller"; }
  } else if (current === 2) { who = "You"; text = "The agreement is a draft. Check the words and the detailed sheet, then send it to sign."; openAgreement(); }
  else if (current === 3) {
    const asks = a?.asks ?? 0;
    if (asks) { who = "You"; text = `${client} asked for ${asks === 1 ? "a change" : `${asks} changes`}. Answer, and they sign the new draft.`; }
    else { who = client; text = a?.seenAt ? `${client} opened it. Waiting for them to sign or comment.` : `Sent. Waiting for ${them} to open it, comment or sign.`; }
    openAgreement();
  } else if (current === 4) {
    // The client has signed (the API's step 4), so whoever is still to sign is on your side.
    const wait = (a?.waitingFor ?? []).join(", ");
    who = "You"; text = `${client} signed. ${wait ? `Now you sign for ${wait}.` : "Now your side signs."}`; openAgreement();
  } else if (current === 5) {
    who = "Finance";
    text = `Everyone signed. Make the first monthly invoice from ${num}: its lines and GST carry over.`;
    if (chain.can.invoice) action = { kind: "make-invoice", label: "Make the invoice" };
  } else if (current === 6 && ob) {
    who = "The team"; text = `Onboarding: ${ob.done} of ${ob.tasks} tasks done. ${client} is live when all are done.`;
    action = { kind: "open-onboarding", label: "Open the project" };
  } else if (current === 6) {
    const first = page === "invoice" ? (draftInvoice ? "This invoice is a draft: check it below and issue it. " : "This invoice is issued. ")
      : `${invName} is ${draftInvoice ? "made as a draft" : "issued"}. `;
    if (chain.can.onboarding) {
      who = "You"; text = `${first}Start the onboarding now (a project with its tasks from ${num}), or it starts when the invoice is paid.`;
      action = { kind: "start-onboarding", label: "Start onboarding" };
      quiet = page === "invoice" && draftInvoice;  // the draft's own Issue is the page's main button
    }
    else if (q?.status === "converted") { who = "Billing"; text = `${first}The onboarding project starts when the invoice is paid.`; }
    else { who = "Leadership or Finance"; text = `${first}Leadership or Finance start the onboarding.`; }
    if (!action && page !== "invoice" && inv) action = { kind: "open-invoice", label: draftInvoice ? "Check the invoice" : "Open the invoice" };
  } else text = `${client} is live. Every step is done.`;
  return { steps, current, text, who, next: current < 8 ? steps[current] : null, then: current < 7 ? steps[current + 1] : null,
    percent: Math.round((current / 8) * 100), action: /** @type {ChainAction | null} */ (action), quiet };
}

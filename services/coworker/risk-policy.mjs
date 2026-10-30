// AI-AUTONOMY (owner, 27 Oct 2026): an AI employee does its work on its own; it asks a person first only for what is
// genuinely risky, as its risk policy says (agent_member.risk_policy, read by Pulse as agent_policy_of and handed over in
// each run's context):
//   internal  colleagues' chats and direct messages            default "send"
//   clients   messages to clients (only once the organisation allows it)   default "ask"
//   money     prices, discounts, refunds, payments, invoices    default "ask"
//   delete    deleting data                                     always "ask" (Pulse refuses an AI delete anyway)
//   legalHr   legal and HR decisions                            default "ask"
//   costLimit an amount above this many rupees always asks      default 25,000
// A message's risks come from the model's own "risk" list and from plain patterns here (a backstop: a model that forgot
// to flag a refund still asks). Leadership and its approver, writing to it one to one, get their answer directly: the
// reader is the person who would approve it.

export const DEFAULT_POLICY = Object.freeze({ internal: "send", clients: "ask", money: "ask", delete: "ask", legalHr: "ask", costLimit: 25000 });
export const RISKS = ["client", "money", "delete", "legal_hr", "cost"];
const KEY = { client: "clients", money: "money", delete: "delete", legal_hr: "legalHr" };
export const RISK_WORDS = { client: "a message to a client", money: "a money commitment", delete: "deleting data", legal_hr: "a legal or HR decision", cost: "an amount above its cost limit" };

const AMOUNT = /(?:₹|\brs\.?|\binr\b|\brupees?\b)\s*(\d[\d,]*(?:\.\d+)?)\s*(?:(k|lakhs|lakh|lacs|lac|l|crores|crore|cr)\b)?|\b(\d[\d,]*(?:\.\d+)?)\s*(?:(k|lakhs|lakh|lacs|lac|crores|crore|cr)\b)?\s*(?:₹|\brs\b|\binr\b|\brupees?\b)/gi;
const SCALE = { k: 1e3, l: 1e5, lac: 1e5, lacs: 1e5, lakh: 1e5, lakhs: 1e5, cr: 1e7, crore: 1e7, crores: 1e7 };
// Money: a commitment, not a mention ("the invoice is with finance" is fine; "we will refund you" is not).
const MONEY = /\b(?:(?:i|we)(?:'ll| will| can| shall)?\s+(?:refund|waive|pay|reimburse|transfer|discount|credit|charge|invoice)|(?:give|offer|approve|apply|confirm)\s+(?:you\s+|them\s+)?(?:a\s+|an\s+|the\s+)?(?:\d+\s*%\s*)?(?:discount|refund|waiver|credit|payment|price|rate)|(?:refund|discount|waiver)\s+(?:is|has been)\s+(?:approved|done|processed)|payment\s+(?:is|has been)\s+(?:approved|released|sent)|(?:final|new|revised)\s+(?:price|quote|quotation|rate)\s+(?:is|will be))\b/i;
const DELETE = /\b(?:(?:i|we)(?:'ll| will| have| 've)?\s+(?:delete|deleted|remove|removed|erase|erased|wipe|wiped|purge|purged)\s+(?:the\s+|your\s+|all\s+|their\s+)?(?:data|records?|files?|account|history|messages?|everything|entries))\b/i;
const LEGAL_HR = /\b(?:(?:terminat(?:e|ed|ion)|dismiss(?:ed|al)?|fir(?:e|ed|ing))\s+(?:you|him|her|them|the\s+employee)|(?:issue|send|give|sign)\s+(?:the\s+|a\s+|an\s+|him\s+|her\s+|them\s+)?(?:warning|show[- ]cause|termination)\s+(?:letter|notice)|(?:salary|pay|ctc)\s+(?:hike|cut|revision|increase|decrease)|(?:legal\s+(?:notice|action)|lawsuit|sue\b|breach\s+of\s+contract|non[- ]compete|nda\s+(?:breach|violation))|(?:we|i)\s+(?:will|'ll)\s+(?:hire|promote|demote|suspend))\b/i;

/** Rupee amounts written in a text (₹45,000 · Rs 2 lakh · 30k INR), as numbers. */
export function amounts(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(AMOUNT)) {
    const n = Number(String(m[1] ?? m[3] ?? "").replace(/,/g, "")), s = SCALE[String(m[2] ?? m[4] ?? "").toLowerCase()] ?? 1;
    if (Number.isFinite(n) && n > 0) out.push(n * s);
  }
  return out;
}

/** The risks a message carries: the model's own list (only known names) and what the patterns find. */
export function risksOf(text, declared = [], { clientFacing = false, costLimit = DEFAULT_POLICY.costLimit } = {}) {
  const r = new Set((Array.isArray(declared) ? declared : declared ? [declared] : []).map((x) => String(x).toLowerCase().replace(/[^a-z_]/g, "").replace(/^legalhr$|^legal$|^hr$/, "legal_hr").replace(/^clients$/, "client"))
    .filter((x) => RISKS.includes(x)));
  const t = String(text ?? "");
  if (clientFacing) r.add("client");
  if (MONEY.test(t)) r.add("money");
  if (DELETE.test(t)) r.add("delete");
  if (LEGAL_HR.test(t)) r.add("legal_hr");
  // Above the cost limit: an amount over it in a money commitment or a message to a client (an internal mention of a
  // budget is not a commitment).
  if ((r.has("money") || r.has("client")) && Number.isFinite(Number(costLimit)) && amounts(t).some((n) => n > Number(costLimit))) r.add("cost");
  return [...r];
}

/** The policy in force: the defaults, then what Pulse handed over (the organisation's client switch included). */
export function policyOf(p) {
  const x = { ...DEFAULT_POLICY, ...(p && typeof p === "object" ? p : {}) };
  x.delete = "ask";
  if (p && p.clientsAllowed === false) x.clients = "ask";
  return x;
}

/** Send or ask first, and why. `to`: who reads it — "leader" (leadership or its approver, one to one), "colleague", or
 *  "client" (a conversation with anyone not on the staff). */
export function decide(policy, risks, { to = "colleague" } = {}) {
  const p = policyOf(policy), hold = [];
  if (to === "leader") return { send: true, risks, hold };
  if (to === "colleague" && p.internal === "ask") hold.push("internal");
  for (const r of risks) {
    if (r === "cost") { hold.push("cost"); continue; }
    if (r === "client" && to !== "client") continue;
    if (p[KEY[r]] !== "send") hold.push(r);
  }
  return { send: hold.length === 0, risks, hold: [...new Set(hold)] };
}

/** The one line its approver reads on the card: why it asks first. */
export function holdWhy(hold) {
  const w = hold.map((h) => h === "internal" ? "it is set to ask first with colleagues" : RISK_WORDS[h]).filter(Boolean);
  return w.length ? `Asks first: ${w.join(", ")}.` : "";
}

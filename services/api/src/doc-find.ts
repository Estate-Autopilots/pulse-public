// DOCS-HUB (owner, 21 Nov 2026: "I tried to find these documents in Vitals OS ... I can't find specific documents"):
// one search over every billing document and what is inside it, for the Documents screen and for the AI employees
// (find_documents). Billing → Documents used to load the newest 500 and search those in the browser by number, client,
// phone and project only: an older document, an amount, a GSTIN or an item was never found.
//
// parseDocQuery reads plain words the way people ask ("last month's invoices for Willow Lane over 1 lakh", "unpaid bills
// Majestic", "quotes not sent yet", "QT/0019") into filters: kinds, states, a date range, an amount range, and the
// words left over, which must all be found somewhere in the document (number, client, contact, phone, e-mail, GSTIN,
// project, PO, site, salesperson, notes, or a line's item and details). Case, spaces and punctuation never matter
// (pulse.search_score, the same forgiving match as Billing's other searches); when nothing matches, the closest client,
// project or item name is offered as a "closer match" (pg_trgm word_similarity), never silently.
// Visibility is the database's: erp_document's policies (a sales-only seat sees its own deals; archived quotations are
// hidden from every read) apply to this search as to every list.
import type { PoolClient } from 'pg';
import { ORG_TZ } from './org-time.js';

export const DOC_KINDS = ['quotation', 'proforma', 'invoice', 'credit_note'] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const FIND_STATES = ['draft', 'waiting', 'not_sent', 'sent', 'accepted', 'declined', 'expired', 'pending', 'unpaid', 'part_paid', 'paid', 'overdue', 'cancelled'] as const;
export type FindState = (typeof FIND_STATES)[number];
export type DocQuery = {
  kinds: DocKind[]; states: FindState[];
  /** Issue date range, YYYY-MM-DD, both ends included. */
  from: string | null; to: string | null;
  /** Amount range in paise; `near` = the total or the taxable value (before GST) is about this. */
  min: number | null; max: number | null; near: boolean;
  /** The words left over: all must be found in the document. */
  text: string;
  /** What was understood, in plain words, one per filter ("Invoices", "Last month: 1–31 Oct 2026", "Over ₹1,00,000"). */
  understood: string[];
};

const KIND_WORDS: [DocKind, RegExp, string][] = [
  ['credit_note', /\bcredit[\s-]*notes?\b|क्रेडिट\s*नोट/giu, 'Credit notes'],
  ['proforma', /\bpro[\s-]?forma(?:s|\s+invoices?)?\b|\bp\.?i\.?s?\b(?=\s|$)|प्रोफार्मा|प्रोफॉर्मा/giu, 'Proformas'],
  ['invoice', /\b(?:tax\s+)?invoices?\b|\binvs?\b|\bbills?\b|इनवॉइस|इनवॉयस|इन्वॉइस|बिल/giu, 'Invoices'],
  ['quotation', /\bquot\w*|\bqtns?\b|\bestimates?\b|कोटेशन|कोटेसन|क्वोटेशन/giu, 'Quotations'],
];
const STATE_WORDS: [FindState, RegExp, string][] = [
  ['waiting', /\b(?:waiting|pending|awaiting)\s+(?:for\s+)?(?:my\s+|an?\s+)?approvals?\b|\bto\s+approve\b|\bneeds?\s+approval\b/giu, 'Waiting for approval'],
  ['not_sent', /\bnot\s+(?:yet\s+)?sent(?:\s+yet)?\b|\bunsent\b|\bnever\s+sent\b/giu, 'Not sent yet'],
  ['part_paid', /\bpart(?:ly|ially)?[\s-]*paid\b|\bpartial(?:ly)?(?:\s+paid)?\b/giu, 'Part-paid'],
  ['overdue', /\bover[\s-]?due\b|\blate\b/giu, 'Overdue'],
  ['unpaid', /\bun[\s-]?paid\b|\bnot\s+(?:yet\s+)?paid(?:\s+yet)?\b|\boutstanding\b|\bto\s+collect\b|\bbalance\s+due\b/giu, 'Unpaid'],
  ['paid', /\bpaid\b/giu, 'Paid'],
  ['draft', /\bdrafts?\b/giu, 'Drafts'],
  ['accepted', /\baccepted\b|\bwon\b|\bcustomer\s+said\s+yes\b/giu, 'Accepted'],
  ['declined', /\bdeclined\b|\blost\b|\brejected\b/giu, 'Declined'],
  ['expired', /\bexpired\b/giu, 'Expired'],
  ['cancelled', /\bcancel+ed\b|\bvoid(?:ed)?\b/giu, 'Cancelled'],
  ['sent', /\bsent\b/giu, 'Sent'],
  ['pending', /\bpending\b/giu, 'Pending'],
];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const ymd = (s: string) => s.split('-').map(Number) as [number, number, number];
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const shift = (s: string, days: number) => { const [y, m, d] = ymd(s); return iso(y, m, d + days); };
const say = (s: string) => { const [y, m, d] = ymd(s); return `${d} ${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${y}`; };
const range = (a: string, b: string) => {
  if (a === b) return say(a);
  const [ya, ma] = ymd(a), [yb, mb] = ymd(b);
  return ya === yb && ma === mb ? `${ymd(a)[2]}–${say(b)}` : `${say(a)} – ${say(b)}`;
};

/** A rupee amount written as people write it: "1 lakh", "2.5L", "₹1,18,000", "50k", "1 crore", "Rs 4500". In paise. */
const AMT = String.raw`(?:₹|rs\.?|inr|rupees?)?\s*(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|l\b|crores?|cr\b|k\b|thousand)?(?:\s*(?:rupees?|rs\.?)(?=\s|$))?`;
function paise(num: string, unit: string | undefined): number | null {
  const n = Number(num.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const u = (unit ?? '').toLowerCase();
  const times = /^(lakh|lac|l)/.test(u) ? 1e5 : /^(crore|cr)/.test(u) ? 1e7 : /^(k|thousand)/.test(u) ? 1e3 : 1;
  return Math.round(n * times * 100);
}
const inr = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
/** An amount said back the way it was typed: "1 lakh" → ₹1 lakh, "2.5 cr" → ₹2.5 crore, "₹1,18,000" → ₹1,18,000. */
const sayAmount = (p: number, unit: string | undefined) => /^(lakh|lac|l)/i.test(unit ?? '') ? `₹${Number((p / 1e7).toFixed(2))} lakh`
  : /^(crore|cr)/i.test(unit ?? '') ? `₹${Number((p / 1e9).toFixed(2))} crore` : inr(p);

const STOP = new Set(['find', 'show', 'me', 'get', 'give', 'list', 'fetch', 'open', 'pull', 'search', 'look', 'up', 'for', 'of', 'the', 'a', 'an',
  'all', 'any', 'my', 'our', 'their', 'to', 'with', 'by', 'in', 'on', 'at', 'and', 'or', 'which', 'what', 'that', 'this', 'these', 'those', 'are', 'is',
  'was', 'were', 'be', 'made', 'raised', 'created', 'generated', 'please', 'pls', 'plz', 'kindly', 'document', 'documents', 'doc', 'docs', 'copy',
  'copies', 'pdf', 'pdfs', 'file', 'files', 'one', 'ones', 'client', 'clients', 'customer', 'customers', 'company', 'can', 'you', 'i', 'we', 'need',
  'want', 'send', 'from', 'having', 'has', 'have', 'where', 'it', 'them', 'there', 'about', 'than', 'more', 'less', 'over', 'under', 'above', 'below',
  'between', 'amount', 'amounts', 'worth', 'value', 'total', 'yet', 'still', 'dated', 'date', 'issued', 'last', 'latest', 'newest', 'recent', 'most', 'वाले', 'वाली', 'का', 'की', 'के', 'सारे', 'सभी', 'दिखाओ', 'भेजो']);

/** Plain words → filters. `today` is the company's date (YYYY-MM-DD). */
export function parseDocQuery(input: string, today: string): DocQuery {
  let s = ` ${String(input ?? '').toLowerCase().replace(/[’']s\b/g, '').replace(/[“”"]/g, ' ')} `;
  const understood: string[] = [];
  // A document number (QT/26-27/0019, INV-2026-0012, PI#12) is kept whole, away from the kind, amount and date words.
  const keep: string[] = [];
  s = s.replace(/\S+/gu, (w) => /[-/#]/.test(w) && /\p{L}/u.test(w) && /\d/.test(w) ? (keep.push(w), ` \uE000${String.fromCharCode(0xE100 + keep.length - 1)}\uE000 `) : w);
  // fn returns false to leave the words where they are (not what it looked for after all).
  const eat = (re: RegExp, fn: (...m: string[]) => void | false) => { s = s.replace(re, (...m: string[]) => fn(...m) === false ? m[0] : ' '); };

  const kinds: DocKind[] = [];
  for (const [k, re, label] of KIND_WORDS) eat(re, () => { if (!kinds.includes(k)) { kinds.push(k); understood.push(label); } });
  const states: FindState[] = [];
  for (const [k, re, label] of STATE_WORDS) eat(re, () => { if (!states.includes(k)) { states.push(k); understood.push(label); } });

  // Amounts: between/range first, then over/under/around, then an amount written with ₹, Rs or a unit (lakh, k, crore).
  let min: number | null = null, max: number | null = null, near = false, about: number | null = null;
  let minUnit: string | undefined, maxUnit: string | undefined;
  eat(new RegExp(String.raw`\bbetween\s+${AMT}\s+(?:and|to|-)\s+${AMT}`, 'giu'), (_m, a, ua, b, ub) => { min = paise(a, ua ?? ub); max = paise(b, ub); minUnit = ua ?? ub; maxUnit = ub; });
  eat(new RegExp(String.raw`(?:₹|rs\.?\s*)?(\d[\d,]*(?:\.\d+)?)\s*(?:-|–|to)\s*${AMT}`, 'giu'), (m, a, b, ub) => {
    if (!ub && !/₹|rs/i.test(m)) return false; min = paise(a, ub); max = paise(b, ub); minUnit = maxUnit = ub; });
  eat(new RegExp(String.raw`(?:\bover|\babove|\bmore\s+than|\bgreater\s+than|\bat\s+least|\bmin(?:imum)?|>=?|\bupwards\s+of)\s*${AMT}`, 'giu'), (_m, a, u) => { min = paise(a, u); minUnit = u; });
  eat(new RegExp(String.raw`(?:\bunder|\bbelow|\bless\s+than|\bup\s*to|\bat\s+most|\bmax(?:imum)?|\bwithin|<=?)\s*${AMT}`, 'giu'), (_m, a, u) => { max = paise(a, u); maxUnit = u; });
  eat(new RegExp(String.raw`(?:\baround|\babout|\bapprox(?:imately|\.)?|~|\broughly)\s*${AMT}`, 'giu'), (_m, a, u) => { const p = paise(a, u); if (p !== null) { min = Math.round(p * 0.9); max = Math.round(p * 1.1); near = true; about = p; minUnit = u; } });
  eat(new RegExp(String.raw`(?:₹|\brs\.?|\binr)\s*(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|l\b|crores?|cr\b|k\b|thousand)?|\b(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr\b|k\b|thousand)\b`, 'giu'),
    (_m, a, u, b, ub) => { const p = paise(a ?? b, u ?? ub); if (p === null || min !== null || max !== null) return false; min = Math.round(p * 0.99); max = Math.round(p * 1.01); near = true; about = p; minUnit = u ?? ub; });
  const money = about !== null ? `About ${sayAmount(about, minUnit)}` : min !== null && max !== null ? `${sayAmount(min, minUnit)} to ${sayAmount(max, maxUnit)}`
    : min !== null ? `Over ${sayAmount(min, minUnit)}` : max !== null ? `Under ${sayAmount(max, maxUnit)}` : null;

  // Dates (the issue date): words first, then a month, a day, a year.
  let from: string | null = null, to: string | null = null;
  const [ty, tm] = ymd(today);
  const set = (a: string, b: string, label: string) => { if (from === null) { from = a; to = b; understood.push(`${label}: ${range(a, b)}`); } };
  const monday = (d: string) => { const [y, m, dd] = ymd(d); const wd = (new Date(Date.UTC(y, m - 1, dd)).getUTCDay() + 6) % 7; return shift(d, -wd); };
  const fyStart = tm >= 4 ? ty : ty - 1;
  eat(/\btoday\b/giu, () => set(today, today, 'Today'));
  eat(/\byesterday\b/giu, () => set(shift(today, -1), shift(today, -1), 'Yesterday'));
  eat(/\bthis\s+week\b/giu, () => set(monday(today), today, 'This week'));
  eat(/\b(?:last|previous|past)\s+week\b/giu, () => set(shift(monday(today), -7), shift(monday(today), -1), 'Last week'));
  eat(/\b(?:this|current)\s+month\b/giu, () => set(iso(ty, tm, 1), today, 'This month'));
  eat(/\b(?:last|previous|past)\s+month\b|पिछले\s+महीने|पिछला\s+महीना/giu, () => { const y = tm === 1 ? ty - 1 : ty, m = tm === 1 ? 12 : tm - 1; set(iso(y, m, 1), iso(y, m, lastDay(y, m)), 'Last month'); });
  eat(/\b(?:this|current)\s+(?:fy|financial\s+year)\b/giu, () => set(iso(fyStart, 4, 1), today, `FY ${fyStart}-${String(fyStart + 1).slice(2)}`));
  eat(/\b(?:last|previous)\s+(?:fy|financial\s+year)\b/giu, () => set(iso(fyStart - 1, 4, 1), iso(fyStart, 3, 31), `FY ${fyStart - 1}-${String(fyStart).slice(2)}`));
  eat(/\bfy\s*'?(\d{2}|\d{4})\s*[-–/]\s*'?(\d{2}|\d{4})\b/giu, (_m, a) => { const y = a.length === 2 ? 2000 + Number(a) : Number(a); set(iso(y, 4, 1), iso(y + 1, 3, 31), `FY ${y}-${String(y + 1).slice(2)}`); });
  eat(/\b(?:this|current)\s+year\b/giu, () => set(iso(ty, 1, 1), today, 'This year'));
  eat(/\b(?:last|previous)\s+year\b/giu, () => set(iso(ty - 1, 1, 1), iso(ty - 1, 12, 31), 'Last year'));
  eat(/\b(?:last|past|previous)\s+(\d{1,3})\s+(days?|weeks?|months?)\b/giu, (_m, n, unit) => {
    const k = Number(n), u = unit.toLowerCase();
    const start = u.startsWith('day') ? shift(today, -(k - 1)) : u.startsWith('week') ? shift(today, -(7 * k - 1)) : (() => { const t = new Date(Date.UTC(ty, tm - 1 - k, ymd(today)[2] + 1)); return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); })();
    set(start, today, `Last ${k} ${u.replace(/s$/, '')}${k === 1 ? '' : 's'}`);
  });
  eat(/\b(\d{4})-(\d{2})-(\d{2})\b/gu, (_m, y, m, d) => set(iso(+y, +m, +d), iso(+y, +m, +d), 'On'));
  eat(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/gu, (_m, d, m, y) => { const yy = y.length === 2 ? 2000 + Number(y) : Number(y); if (+m >= 1 && +m <= 12) set(iso(yy, +m, +d), iso(yy, +m, +d), 'On'); });
  eat(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+${MONTH}\.?(?:\s*,?\s*(\d{4}))?\b`, 'giu'), (_m, d, mon, y) => {
    const m = MONTHS.indexOf(mon.slice(0, 3)) + 1, yy = y ? Number(y) : (m > tm || (m === tm && Number(d) > ymd(today)[2]) ? ty - 1 : ty);
    set(iso(yy, m, +d), iso(yy, m, +d), 'On'); });
  // A month alone ("October", "oct 2025", "in march"); "may" only with a year or after in/of/during/since.
  eat(new RegExp(String.raw`(?:\b(in|of|during|for|since)\s+)?\b${MONTH}\b\.?(?:\s*,?\s*(\d{4}|'\d{2})\b)?`, 'giu'), (m, pre, mon, y) => {
    if (mon === 'may' && !pre && !y) return false;
    const mm = MONTHS.indexOf(mon.slice(0, 3)) + 1, yy = y ? (y.startsWith("'") ? 2000 + Number(y.slice(1)) : Number(y)) : (mm > tm ? ty - 1 : ty);
    if (pre === 'since') set(iso(yy, mm, 1), today, 'Since');
    else set(iso(yy, mm, 1), iso(yy, mm, lastDay(yy, mm)), mon.length > 3 ? `${mon[0].toUpperCase()}${mon.slice(1)}` : MONTHS[mm - 1][0].toUpperCase() + MONTHS[mm - 1].slice(1));
    void m;
    return undefined;
  });
  eat(/\b(?:in|of|during)\s+(20\d{2})\b/giu, (_m, y) => set(iso(+y, 1, 1), iso(+y, 12, 31), y));

  if (money) understood.push(money);
  // What is left: the words to find (a number such as QT/26-27/0019 or 1471 stays whole).
  s = s.replace(/\uE000(.)\uE000/gu, (_m, ch: string) => keep[ch.charCodeAt(0) - 0xE100] ?? ' ');
  const text = s.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}#]+|[^\p{L}\p{N}]+$/gu, '')).filter((w) => w && !STOP.has(w)).join(' ').trim();
  if (text) understood.push(`Matching “${text}”`);
  return { kinds, states, from, to, min, max, near, text, understood };
}

/** Where a document stands, in one plain word, for every list and for the AI (generated, sent, paid, pending …); the
 *  screen's words (apps/web/app/lib/billing-words.mjs), and "Not sent yet" for one approved and never sent (owner, 20 Nov). */
export type DocState = { key: FindState | 'issued'; label: string; tone: 'neutral' | 'accent' | 'warning' | 'success' | 'danger' };
export function docState(d: { docType: string; status: string; sentAt?: string | null; dueDate?: string | null; validUntil?: string | null; total?: number; paid?: number; credited?: number; approvalTo?: string | null }, today: string): DocState {
  const st = d.status, open = ['issued', 'sent', 'part_paid'].includes(st);
  if (st === 'cancelled') return { key: 'cancelled', label: 'Cancelled', tone: 'neutral' };
  if (st === 'draft') return d.approvalTo ? { key: 'waiting', label: 'Waiting for approval', tone: 'warning' } : { key: 'draft', label: 'Draft', tone: 'neutral' };
  if (d.docType === 'credit_note') return { key: 'issued', label: 'Issued', tone: 'neutral' };
  if (d.docType === 'quotation') {
    if (st === 'accepted' || st === 'converted') return { key: 'accepted', label: st === 'converted' ? 'Accepted · billed' : 'Accepted', tone: 'success' };
    if (st === 'declined') return { key: 'declined', label: 'Declined', tone: 'danger' };
    if (d.validUntil && d.validUntil < today) return { key: 'expired', label: 'Expired', tone: 'warning' };
    return st === 'issued' && !d.sentAt ? { key: 'not_sent', label: 'Not sent yet', tone: 'warning' } : { key: 'sent', label: 'With the customer', tone: 'accent' };
  }
  if (st === 'paid') return { key: 'paid', label: 'Paid', tone: 'success' };
  if (d.docType === 'invoice' && open && d.dueDate && d.dueDate < today) return { key: 'overdue', label: 'Overdue', tone: 'danger' };
  if (st === 'part_paid') return { key: 'part_paid', label: 'Part-paid', tone: 'warning' };
  if (st === 'issued' && !d.sentAt) return { key: 'not_sent', label: 'Not sent yet', tone: 'warning' };
  if (st === 'converted') return { key: 'accepted', label: 'Billed', tone: 'success' };
  return { key: 'unpaid', label: 'Awaiting payment', tone: 'accent' };
}

/** Each state as SQL on erp_document d, with the company's date as td. */
const STATE_SQL: Record<FindState, string> = {
  draft: `d.status='draft'`,
  waiting: `(d.status='draft' and d.approval_to is not null)`,
  not_sent: `(d.status='issued' and d.sent_at is null and d.doc_type<>'credit_note')`,
  sent: `(d.sent_at is not null and d.status not in ('draft','cancelled'))`,
  accepted: `d.status in ('accepted','converted')`,
  declined: `d.status='declined'`,
  expired: `(d.doc_type='quotation' and d.status in ('issued','sent') and d.valid_until<td)`,
  pending: `((d.doc_type in ('invoice','proforma') and d.status in ('issued','sent','part_paid')) or (d.doc_type='quotation' and d.status in ('issued','sent')))`,
  unpaid: `(d.doc_type in ('invoice','proforma') and d.status in ('issued','sent','part_paid'))`,
  part_paid: `d.status='part_paid'`,
  paid: `d.status='paid'`,
  overdue: `(d.doc_type='invoice' and d.status in ('issued','sent','part_paid') and d.due_date<td)`,
  cancelled: `d.status='cancelled'`,
};

export type Found = Record<string, unknown> & { why: string | null; whyText: string | null; score: number };
/** The documents that match, best first (with words) or newest first. `cols` are the screen's columns on alias d
 *  (erp.ts DOC_COLS). `closer`: nothing matched every word, so these are the closest names instead. */
export async function findBillingDocs(c: PoolClient, q: DocQuery, opts: { cols: string; limit?: number; clientId?: string | null }): Promise<{ docs: Found[]; closer: boolean }> {
  const args: unknown[] = [];
  const arg = (v: unknown) => { args.push(v); return `$${args.length}`; };
  const where: string[] = [];
  if (q.kinds.length) where.push(`d.doc_type = any(${arg(q.kinds)}::text[])`);
  if (opts.clientId) where.push(`d.client_id = ${arg(opts.clientId)}::uuid`);
  if (q.from) where.push(`coalesce(d.issue_date, d.created_at::date) >= ${arg(q.from)}::date`);
  if (q.to) where.push(`coalesce(d.issue_date, d.created_at::date) <= ${arg(q.to)}::date`);
  const amt = (col: string) => [q.min !== null ? `${col} >= ${arg(q.min)}` : '', q.max !== null ? `${col} <= ${arg(q.max)}` : ''].filter(Boolean).join(' and ');
  if (q.min !== null || q.max !== null) where.push(q.near ? `((${amt('d.total')}) or (${amt('d.taxable')}))` : amt('d.total'));
  if (q.states.length) where.push(`(${q.states.map((k) => STATE_SQL[k]).join(' or ')})`);
  const limit = Math.min(Math.max(Number(opts.limit ?? 50), 1), 200);
  const filters = where.length ? where.join(' and ') : 'true';
  const td = `(now() at time zone ${ORG_TZ})::date`;
  const from = `pulse.erp_document d left join pulse.project pr on pr.id=d.project_id left join pulse.client cl on cl.id=d.client_id
    left join pulse.person sp on sp.id=d.salesperson_id cross join (select ${td} td) t`;
  const fields = {
    number: `array[d.number, case when d.revision>0 then d.number||' r'||(d.revision+1) end]`,
    client: `array[d.buyer->>'name', cl.display_name, cl.company_name, d.buyer->>'contactName']`,
    contact: `array[d.buyer->>'phone', right(regexp_replace(coalesce(d.buyer->>'phone',''),'\\D','','g'),10), d.buyer->>'email', d.buyer->>'gstin']`,
    project: `array[d.reference->>'project', d.reference->>'po', pr.title, pr.name, d.site_location]`,
    item: `array[(select string_agg(concat_ws(' ', l.description, l.details, l.sac), ' ') from pulse.erp_line l where l.document_id=d.id)]`,
    note: `array[d.notes, sp.display_name]`,
    // QUOTE-FIXES (Mac test 21 Nov: "11,210", "9500" found nothing): the total and the value before GST, in rupees, whole
    // and with paise. search_norm drops the commas, so "11,210", "11210" and "₹11,210.00" all read as these.
    amount: `array[round(d.total/100.0)::bigint::text, to_char(d.total/100.0,'FM999999999990.00'), round(d.taxable/100.0)::bigint::text, to_char(d.taxable/100.0,'FM999999999990.00')]`,
  };
  if (!q.text) {
    const docs = (await c.query(`select ${opts.cols},coalesce(pr.title,pr.name) project,null why,null "whyText",0 score from ${from} where ${filters}
      order by coalesce(d.issue_date, d.created_at::date) desc, d.created_at desc limit ${limit}`, args)).rows as Found[];
    return { docs, closer: false };
  }
  const t = arg(q.text);
  const sc = (f: string) => `pulse.search_score(${t}, ${f})`;
  const all = `${fields.number}||${fields.client}||${fields.contact}||${fields.project}||${fields.item}||${fields.note}`;
  // Only a query that is one number (commas, ₹ and paise allowed) is looked for as an amount.
  const amountScore = /^[₹\s]*\d[\d,]*(?:\.\d{1,2})?$/u.test(q.text) ? sc(fields.amount) : '0';
  // Every word somewhere (search_score over all fields), then where it was found, best place first. An amount counts only
  // whole (the total or the value before GST is the number asked, or starts with it), never as part of other words.
  const docs = (await c.query(`select x.*, case when x.s_number>0 then 'number' when x.s_amount>=85 then 'amount' when x.s_client>0 then 'client' when x.s_contact>0 then 'contact'
        when x.s_project>0 then 'project' when x.s_item>0 then 'item' when x.s_note>0 then 'note' else 'words' end why,
      case when x.s_number=0 and x.s_client=0 and x.s_contact=0 and x.s_project=0 and x.s_item>0 then
        (select l.description from pulse.erp_line l where l.document_id=x.id and pulse.search_score(${t}, array[l.description, l.details, l.sac])>0 order by l.position limit 1) end "whyText",
      greatest(x.s_number, x.s_client, x.s_contact, x.s_project, x.s_item*0.8, x.s_note*0.7, x.s_all*0.6, case when x.s_amount>=85 then x.s_amount else 0 end) score
    from (select ${opts.cols},coalesce(pr.title,pr.name) project, ${sc(fields.number)} s_number, ${sc(fields.client)} s_client, ${sc(fields.contact)} s_contact,
        ${sc(fields.project)} s_project, ${sc(fields.item)} s_item, ${sc(fields.note)} s_note, ${sc(all)} s_all, ${amountScore} s_amount
      from ${from} where ${filters} and (${sc(all)} > 0 or ${amountScore} >= 85)) x
    order by score desc, x."issueDate" desc nulls last, x."createdAt" desc limit ${limit}`, args)).rows as Found[];
  if (docs.length) return { docs: docs.map(strip), closer: false };
  // Nothing has every word: the closest client, project or item name (a typo, a half-remembered name), said as such.
  const near = (await c.query(`select x.* from (select ${opts.cols},coalesce(pr.title,pr.name) project,'closer' why,
        coalesce(nullif(d.buyer->>'name',''), cl.display_name) "whyText",
        greatest(public.word_similarity(lower(${t}), lower(coalesce(d.buyer->>'name','')||' '||coalesce(cl.display_name,'')||' '||coalesce(cl.company_name,''))),
          public.word_similarity(lower(${t}), lower(coalesce(pr.title,pr.name,'')||' '||coalesce(d.reference->>'project',''))),
          public.word_similarity(lower(${t}), lower(coalesce((select string_agg(l.description, ' ') from pulse.erp_line l where l.document_id=d.id),''))) * 0.9) score
      from ${from} where ${filters}) x where x.score >= 0.4 order by x.score desc, x."issueDate" desc nulls last limit ${Math.min(limit, 20)}`, args)).rows as Found[];
  return { docs: near.map(strip), closer: near.length > 0 };
}
/** The working scores stay in the database's answer only. */
function strip(r: Found): Found {
  const out: Record<string, unknown> = { ...r };
  for (const k of ['s_number', 's_client', 's_contact', 's_project', 's_item', 's_note', 's_all', 's_amount']) delete out[k];
  return { ...out, score: Number(r.score ?? 0) } as Found;
}

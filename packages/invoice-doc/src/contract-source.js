// CONTRACTS-PRO (owner, 15 Nov 2026): "contracts must render as a typeset legal document", not as raw Markdown.
// The words of a contract are one text, the "source", kept in pulse.contract.body (so drafts, the signed hash and the
// redline cover everything that is signed):
//
//   <!-- pulse:contract {"type":"service","date":"2026-11-15","place":"Pune","parties":[...],"deal":{"fee":"₹40,000"}} -->
//   ## Background
//   - The Provider builds software ...
//   ## Services
//   The Provider shall provide the Services set out in Schedule 1.
//   ## Schedule 1: The detailed sheet
//   | Item | Detail |
//
// The first line (an HTML comment, invisible to any Markdown reader) carries the contract's type, its parties (legal
// name, type, address, registration, signatory, the defined name such as "the Company") and the deal's fields. The rest
// is light Markdown. Numbers are never typed: "## Payment" becomes clause 3, its paragraphs 3.1, 3.2, its bullets
// (a), (b), (i) — so clauses renumber themselves when one moves. "Background" is lettered (A), (B); "Schedule …" parts
// start their own page. An older contract (no first line; "1. Scope of work" headings) reads the same way.
//
// Fields are {{deal.fee}}, {{client.name}}, {{party1.address}} (dotted, so pulse.contract_fill's {{lower_snake}}
// quotation blanks keep their own meaning). A field with no value stays visible as a gap, and Send refuses it.

const HEAD_RE = /^<!--\s*pulse:contract\s+([\s\S]*?)\s*-->\s*\n?/;

/** Party types, with how the parties block describes each. */
export const PARTY_TYPES = Object.freeze([
  { key: 'private_limited', label: 'Private limited company', reg: 'CIN' },
  { key: 'proposed_company', label: 'Company to be incorporated', reg: '' },
  { key: 'public_limited', label: 'Public limited company', reg: 'CIN' },
  { key: 'llp', label: 'Limited liability partnership (LLP)', reg: 'LLPIN' },
  { key: 'partnership', label: 'Partnership firm', reg: 'Registration no.' },
  { key: 'proprietorship', label: 'Sole proprietorship', reg: 'GSTIN' },
  { key: 'individual', label: 'Individual', reg: 'PAN' },
  { key: 'other', label: 'Other organisation', reg: 'Registration no.' },
]);
const PARTY_TYPE = new Map(PARTY_TYPES.map((t) => [t.key, t]));

/** Contract types: each has its own parties, fields and starting clauses. `kind` is the money shape kept in pulse.contract.kind. */
export const CONTRACT_TYPES = Object.freeze([
  { key: 'service', label: 'Service agreement (MSA and schedule)', short: 'Service agreement', kind: 'retainer', title: 'Master Service Agreement',
    parties: [{ role: 'provider', defined: 'Provider', type: 'private_limited' }, { role: 'client', defined: 'Client', type: 'private_limited' }],
    fields: ['fee', 'gst', 'billing', 'start', 'review', 'notice', 'term', 'city'] },
  { key: 'founders', label: "Founders' agreement or pre-incorporation agreement", short: "Founders' agreement", kind: 'equity', title: 'Pre-incorporation and Founders’ Agreement',
    parties: [{ role: 'partner', defined: 'Company', type: 'proposed_company' }, { role: 'partner', defined: 'First Founder', type: 'individual' }, { role: 'partner', defined: 'Second Founder', type: 'individual' }],
    fields: ['start', 'city', 'shares', 'advance'] },
  { key: 'offer', label: 'Offer or appointment letter', short: 'Appointment letter', kind: 'employment', title: 'Letter of Appointment',
    parties: [{ role: 'employer', defined: 'Company', type: 'private_limited' }, { role: 'employee', defined: 'Employee', type: 'individual' }],
    fields: ['position', 'salary', 'start', 'probation', 'notice', 'city'] },
  { key: 'nda', label: 'Non-disclosure agreement (NDA)', short: 'NDA', kind: 'services', title: 'Mutual Non-Disclosure Agreement',
    parties: [{ role: 'partner', defined: 'First Party', type: 'private_limited' }, { role: 'partner', defined: 'Second Party', type: 'private_limited' }],
    fields: ['purpose', 'term', 'city'] },
  { key: 'vendor', label: 'Vendor agreement', short: 'Vendor agreement', kind: 'services', title: 'Vendor Agreement',
    parties: [{ role: 'client', defined: 'Company', type: 'private_limited' }, { role: 'provider', defined: 'Vendor', type: 'proprietorship' }],
    fields: ['fee', 'gst', 'billing', 'start', 'notice', 'city'] },
  { key: 'policy', label: 'Policy acceptance', short: 'Policy acceptance', kind: 'employment', title: 'Policy Acceptance',
    parties: [{ role: 'employer', defined: 'Company', type: 'private_limited' }, { role: 'employee', defined: 'Employee', type: 'individual' }],
    fields: ['policy', 'start'] },
  { key: 'loan', label: 'Loan or advance acknowledgement', short: 'Advance acknowledgement', kind: 'equity', title: 'Acknowledgement of Advance',
    parties: [{ role: 'partner', defined: 'Lender', type: 'individual' }, { role: 'partner', defined: 'Borrower', type: 'proposed_company' }],
    fields: ['amount', 'received', 'repay', 'city'] },
]);
const TYPE = new Map(CONTRACT_TYPES.map((t) => [t.key, t]));
/** A contract type by key; an unknown or missing one is the service agreement. @param {unknown} key */
export const contractType = (key) => TYPE.get(String(key)) ?? TYPE.get('service');

/** The deal's fields: label, and the hint the editor shows. */
export const DEAL_FIELDS = Object.freeze({
  fee: { label: 'Fee', hint: '₹40,000 a month' }, gst: { label: 'GST', hint: 'plus GST at 18%' }, billing: { label: 'Billing', hint: 'invoiced monthly in advance, due in 15 days' },
  start: { label: 'Start date', hint: '1 November 2026' }, review: { label: 'Review date', hint: '21 November 2026' }, notice: { label: 'Notice period', hint: '30 days' },
  term: { label: 'Term', hint: '12 months' }, city: { label: 'Courts of', hint: 'Pune' }, shares: { label: 'Shareholding', hint: '50:50' },
  advance: { label: 'Founder advances', hint: '₹20,000 from the Second Founder' }, position: { label: 'Position', hint: 'Senior Designer' },
  salary: { label: 'Salary', hint: '₹6,00,000 a year (cost to company)' }, probation: { label: 'Probation', hint: '3 months' },
  purpose: { label: 'Purpose', hint: 'to discuss a possible project' }, policy: { label: 'Policy', hint: 'Leave policy, version 2' },
  amount: { label: 'Amount', hint: '₹20,000' }, received: { label: 'Received on', hint: '10 November 2026' }, repay: { label: 'Repayment', hint: 'within 6 months, or converted into shares' },
});
/** A field's label ("Fee"). @param {string} key */
export const dealLabel = (key) => DEAL_FIELDS[key]?.label ?? String(key).replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
const PARTY_PROPS = { name: 'name', address: 'address', signatory: 'signatory', title: 'signatory title', reg: 'registration no.', gstin: 'GSTIN', email: 'e-mail' };

/** Split the source into its first line (the contract's facts) and the words. @param {string} body */
export function readSource(body) {
  const s = String(body ?? '').replace(/\r\n?/g, '\n');
  const m = HEAD_RE.exec(s);
  if (!m) return { meta: null, text: s };
  let meta = null;
  try { const v = JSON.parse(m[1]); meta = v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { meta = null; }
  return { meta: meta ? tidyMeta(meta) : null, text: s.slice(m[0].length) };
}
/** The source back from its facts and words. @param {object | null} meta @param {string} text */
export function writeSource(meta, text) {
  const t = String(text ?? '').replace(/\r\n?/g, '\n').replace(/^\n+/, '');
  if (!meta) return t;
  // "-->" can never appear inside the JSON (it would end the comment): escape ">" as >.
  return `<!-- pulse:contract ${JSON.stringify(tidyMeta(meta)).replace(/>/g, '\\u003e')} -->\n${t}`;
}

const str = (v, max = 400) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max) : '');
/** The facts, cleaned: unknown keys dropped, strings capped. @param {any} m */
export function tidyMeta(m) {
  const parties = (Array.isArray(m?.parties) ? m.parties : []).slice(0, 12).map((p) => ({
    ...(str(p?.key, 60) ? { key: str(p.key, 60) } : {}),
    name: str(p?.name, 160), type: PARTY_TYPE.has(p?.type) ? p.type : 'other', defined: str(p?.defined, 40),
    ...(str(p?.role, 20) ? { role: str(p.role, 20) } : {}),
    ...(str(p?.address, 300) ? { address: str(p.address, 300) } : {}), ...(str(p?.reg, 40) ? { reg: str(p.reg, 40) } : {}),
    ...(str(p?.gstin, 20) ? { gstin: str(p.gstin, 20) } : {}), ...(str(p?.email, 254) ? { email: str(p.email, 254) } : {}),
    ...(str(p?.signatory, 120) ? { signatory: str(p.signatory, 120) } : {}), ...(str(p?.title, 80) ? { title: str(p.title, 80) } : {}),
    ...(str(p?.note, 300) ? { note: str(p.note, 300) } : {}),
    ...(Number.isInteger(p?.order) && p.order >= 1 && p.order <= 12 ? { order: p.order } : {}),
  })).filter((p) => p.name || p.defined);
  const deal = {};
  for (const [k, v] of Object.entries(m?.deal && typeof m.deal === 'object' ? m.deal : {}).slice(0, 40)) if (/^[a-z][a-z0-9_]{0,30}$/.test(k) && str(v, 400)) deal[k] = str(v, 400);
  return { v: 1, type: TYPE.has(m?.type) ? m.type : 'service', ...(str(m?.date, 40) ? { date: str(m.date, 40) } : {}), ...(str(m?.place, 80) ? { place: str(m.place, 80) } : {}),
    ...(m?.ordered === true ? { ordered: true } : {}), parties, deal };
}

/** "the Company" → "Company"; the slug a field uses ({{company.name}}). @param {string} d */
const definedWord = (d) => String(d ?? '').replace(/^the\s+/i, '').replace(/["“”]/g, '').trim();
const slugOf = (d) => definedWord(d).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Every field a contract offers, with its value: deal fields, then each party's ({{client.name}}, {{party2.name}}). */
export function contractFields(meta, text = null) {
  const m = meta ?? { parties: [], deal: {}, type: 'service' };
  const t = contractType(m.type);
  /** @type {{ key: string; label: string; value: string; group: string }[]} */
  const out = [];
  for (const k of [...new Set([...t.fields, ...Object.keys(m.deal ?? {})])]) out.push({ key: `deal.${k}`, label: dealLabel(k), value: m.deal?.[k] ?? '', group: 'The deal' });
  (m.parties ?? []).forEach((p, i) => {
    const word = definedWord(p.defined) || `Party ${i + 1}`;
    for (const [prop, label] of Object.entries(PARTY_PROPS)) {
      const value = prop === 'name' ? p.name : prop === 'signatory' ? p.signatory : prop === 'title' ? p.title : p[prop];
      out.push({ key: `${slugOf(word) || `party${i + 1}`}.${prop}`, label: `${word}: ${label}`, value: value ?? '', group: word });
    }
  });
  // CONTRACTS-PRO: a clause's number as a field ({{ref.fees_and_payment}} → "3"), so a cross-reference follows renumbering.
  if (text != null) for (const [key, r] of clauseRefs(text)) out.push({ key, label: `Clause no.: ${r.title}`, value: r.number, group: 'Clause numbers' });
  return out;
}
/** Field key → value, with each party also reachable as party1.name etc. */
function fieldValues(meta, refs = null) {
  const v = new Map();
  for (const f of contractFields(meta)) v.set(f.key, f.value);
  for (const [k, r] of refs ?? []) v.set(k, r.number);
  (meta?.parties ?? []).forEach((p, i) => { for (const prop of Object.keys(PARTY_PROPS)) v.set(`party${i + 1}.${prop}`, v.get(`${slugOf(definedWord(p.defined) || `Party ${i + 1}`)}.${prop}`) ?? ''); });
  return v;
}
const FIELD_RE = /\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\s*\}\}/g;
/** The dotted fields a text uses that have no value yet (Send refuses them). @param {string} body */
export function emptyFields(body) {
  const { meta, text } = readSource(body);
  const v = fieldValues(meta, clauseRefs(text)), out = [];
  for (const m of text.matchAll(FIELD_RE)) if (!v.get(m[1]) && !out.includes(m[1])) out.push(m[1]);
  return out;
}
/** A dotted field's name on screen: "Fee", "Client: name". @param {string} key @param {object | null} meta */
export function fieldLabel(key, meta) {
  const f = contractFields(meta).find((x) => x.key === key);
  if (f) return f.label;
  const [a, b] = key.split('.');
  if (a === 'ref') return `Clause no.: ${b.replace(/_/g, ' ')}`;
  return a === 'deal' ? dealLabel(b) : `${a.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}: ${PARTY_PROPS[b] ?? b}`;
}

// ------------------------------------------------------------------------------------------------ the words
const PLAIN_HEAD = /^\s*(\d{1,2})[.)]\s+(.{1,100})$/;
const SUB_HEAD = /^\s*(\d{1,2})\.(\d{1,2})\.?\s+(.{1,100})$/;
const isTitleish = (t) => t.length <= 80 && !/[.;:,]$/.test(t) && !/[:₹]/.test(t);
/** "6. Payment", "Clause 6 – Payment", "6 Payment" → "Payment". @param {string} t */
export const stripNumber = (t) => String(t ?? '').replace(/^\s*(?:clause|article|section)?\s*\d{1,2}(?:\.\d{1,2})*[.):]?\s*[-–—:]?\s*/i, '').replace(/\s+#+\s*$/, '').trim();
const RECITALS = /^(background|recitals|whereas)$/i;
const SCHEDULE = /^(schedule|annexure|annex|appendix)\b\s*([0-9A-Za-z]{0,3})\s*[:.\-–—]?\s*(.*)$/i;
const SIGNATURES = /^(signatures?|execution|in witness whereof|signed by the parties)$/i;

/**
 * The words as blocks, numbered. Each block: { kind, ... }:
 *  heading { level: 1|2, number, title, part: 'clause'|'recitals'|'schedule'|'signatures' }
 *  para { number|null, runs } · item { number, depth, runs } · table { rows: string[][] } · note { runs } · rule
 * `title` is a first "# " line (the document's own name).
 * @param {string} text the words without the first line
 */
export function parseContract(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  /** @type {any[]} */
  const raw = [];
  let title = '', para = [], fence = false;
  const flush = () => { if (para.length) { raw.push({ kind: 'para', text: para.join(' ').replace(/\s+/g, ' ').trim() }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { flush(); fence = !fence; continue; }
    if (fence) { para.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    let m;
    if ((m = /^#\s+(.+)$/.exec(line)) && !title && !raw.length) { flush(); title = m[1].trim(); continue; }
    if ((m = /^(#{1,2})\s+(.+)$/.exec(line))) { flush(); raw.push({ kind: 'h', level: 1, title: stripNumber(m[2]) || m[2].trim() }); continue; }
    if ((m = /^#{3,6}\s+(.+)$/.exec(line))) { flush(); raw.push({ kind: 'h', level: 2, title: stripNumber(m[1]) || m[1].trim() }); continue; }
    if ((m = SUB_HEAD.exec(line)) && isTitleish(m[3].trim())) { flush(); raw.push({ kind: 'h', level: 2, title: m[3].trim() }); continue; }
    if ((m = SUB_HEAD.exec(line))) { flush(); raw.push({ kind: 'para', text: m[3].trim(), sub: true }); continue; }
    if ((m = PLAIN_HEAD.exec(line)) && isTitleish(m[2].trim())) { flush(); raw.push({ kind: 'h', level: 1, title: m[2].trim() }); continue; }
    if ((m = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.exec(line))) { flush(); raw.push({ kind: 'rule' }); continue; }
    if ((m = /^\s*\|(.+)\|\s*$/.exec(line))) {
      flush();
      const cells = m[1].split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      const last = raw[raw.length - 1];
      if (last?.kind === 'table') last.rows.push(cells); else raw.push({ kind: 'table', rows: [cells] });
      continue;
    }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) { flush(); const last = raw[raw.length - 1]; if (last?.kind === 'note') last.text += ` ${m[1]}`; else raw.push({ kind: 'note', text: m[1] }); continue; }
    if ((m = /^(\s*)(?:[-*•]|\(?[a-z]\)|\(?[ivx]{1,4}\)|\d{1,2}[.)])\s+(.+)$/.exec(line))) {
      flush();
      const indent = m[1].replace(/\t/g, '  ').length;
      raw.push({ kind: 'item', depth: indent >= 2 ? 2 : 1, text: m[2].trim() });
      continue;
    }
    // A wrapped line of a list item continues it.
    const last = raw[raw.length - 1];
    if (!para.length && last?.kind === 'item' && /^\s{2,}\S/.test(line)) { last.text += ` ${line.trim()}`; continue; }
    para.push(line.trim());
  }
  flush();
  return { title, blocks: numberBlocks(raw) };
}

function numberBlocks(raw) {
  const out = [];
  let clause = 0, schedule = 0, part = 'opening', sub = 0, item1 = 0, item2 = 0, recital = 0;
  // Within a clause, number its paragraphs (3.1, 3.2) only when it has more than one paragraph or sub-heading.
  const counts = [];
  {
    let cur = null;
    for (const b of raw) {
      if (b.kind === 'h' && b.level === 1) { cur = { paras: 0, subs: 0 }; counts.push(cur); b._c = cur; continue; }
      if (!cur) continue;
      if (b.kind === 'h') cur.subs++; else if (b.kind === 'para') cur.paras++;
    }
  }
  let numberParas = false, inSubHead = false;
  for (const b of raw) {
    if (b.kind === 'h' && b.level === 1) {
      const sm = SCHEDULE.exec(b.title);
      item1 = 0; item2 = 0; sub = 0; inSubHead = false;
      if (RECITALS.test(b.title)) { part = 'recitals'; out.push({ kind: 'heading', level: 1, number: null, title: 'Background', part }); continue; }
      if (SIGNATURES.test(b.title)) { part = 'signatures'; out.push({ kind: 'heading', level: 1, number: null, title: b.title, part }); continue; }
      if (sm) {
        part = 'schedule'; schedule++;
        out.push({ kind: 'heading', level: 1, number: `Schedule ${schedule}`, title: sm[3]?.trim() || '', part });
        continue;
      }
      part = 'clause'; clause++;
      numberParas = (b._c?.paras ?? 0) + (b._c?.subs ?? 0) > 1;
      out.push({ kind: 'heading', level: 1, number: String(clause), title: b.title, part });
      continue;
    }
    if (b.kind === 'h') {
      item1 = 0; item2 = 0; inSubHead = true;
      if (part === 'clause') { sub++; out.push({ kind: 'heading', level: 2, number: `${clause}.${sub}`, title: b.title, part }); }
      else out.push({ kind: 'heading', level: 2, number: null, title: b.title, part });
      continue;
    }
    if (b.kind === 'item') {
      if (part === 'recitals' && b.depth === 1) { recital++; out.push({ kind: 'para', number: `(${letter(recital).toUpperCase()})`, runs: runsOf(b.text), hang: true }); continue; }
      if (b.depth === 1) { item1++; item2 = 0; out.push({ kind: 'item', depth: 1, number: `(${letter(item1)})`, runs: runsOf(b.text) }); }
      else { item2++; out.push({ kind: 'item', depth: 2, number: `(${roman(item2)})`, runs: runsOf(b.text) }); }
      continue;
    }
    if (b.kind === 'para') {
      item1 = 0; item2 = 0;
      if (part === 'recitals') { recital++; out.push({ kind: 'para', number: `(${letter(recital).toUpperCase()})`, runs: runsOf(b.text), hang: true }); continue; }
      if (part === 'clause' && numberParas && !inSubHead) { sub++; out.push({ kind: 'para', number: `${clause}.${sub}`, runs: runsOf(b.text), hang: true }); continue; }
      out.push({ kind: 'para', number: null, runs: runsOf(b.text) });
      continue;
    }
    if (b.kind === 'note') { out.push({ kind: 'note', runs: runsOf(b.text.trim()) }); continue; }
    if (b.kind === 'table') { out.push({ kind: 'table', rows: b.rows.map((r) => r.map((c) => runsOf(c))) }); continue; }
    if (b.kind === 'rule') out.push({ kind: 'rule' });
  }
  return out;
}
const letter = (n) => { let s = ''; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(97 + ((x - 1) % 26)) + s; return s; };
const roman = (n) => { const r = [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]; let s = ''; for (const [v, t] of r) while (n >= v) { s += t; n -= v; } return s; };

/**
 * Inline words as runs: { text, bold?, field? }. **bold** and __bold__ are bold; *x* and _x_ read as plain (the
 * document has no italic face); a defined term is bold where it is defined ("Services" means …, (the "Company"));
 * {{x.y}} is a field (filled later). Markdown escapes (\*) are kept as the character.
 * @param {string} s
 */
export function runsOf(s) {
  const out = [];
  const push = (text, bold = false, field = null) => { if (!text) return; const last = out[out.length - 1]; if (last && !field && !last.field && last.bold === bold) last.text += text; else out.push(field ? { text, field } : bold ? { text, bold } : { text }); };
  const src = String(s ?? '').replace(/\\([*_`#|\\])/g, '\u0000$1');
  const re = /(\*\*|__)(.+?)\1|(\{\{\s*[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\s*\}\})|`([^`]+)`|(?<![\w*\u0000])[*_]([^*_\n\u0000]+)[*_](?![\w*])/g;
  let at = 0;
  for (const m of src.matchAll(re)) {
    if (m.index > at) definedRuns(src.slice(at, m.index), push);
    if (m[2] != null) push(unesc(m[2]).replace(/\*\*|__/g, ''), true);
    else if (m[3]) push(m[3], false, m[3].replace(/[{}\s]/g, ''));
    else if (m[4] != null) push(unesc(m[4]));
    else if (m[5] != null) definedRuns(m[5], push);
    at = m.index + m[0].length;
  }
  if (at < src.length) definedRuns(src.slice(at), push);
  return out.map((r) => ({ ...r, text: unesc(r.text) }));
}
const unesc = (s) => s.replace(/\u0000/g, '');
// "Services" means … · (the "Company") · (together, the "Founders") · hereinafter "the Client"
const DEFINED = /(["“])([A-Z][A-Za-z0-9’' &-]{0,40})(["”])(?=\s+(?:means|shall mean|has the meaning|includes)\b|\s*\))/g;
function definedRuns(s, push) {
  let at = 0;
  for (const m of s.matchAll(DEFINED)) {
    if (m.index > at) push(s.slice(at, m.index));
    push(`“${m[2]}”`, true);
    at = m.index + m[0].length;
  }
  if (at < s.length) push(s.slice(at));
}

/** "Fees and payment" → "fees_and_payment": the key a cross-reference uses. @param {string} t */
export const refKey = (t) => `ref.${String(t ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'n$1').slice(0, 60) || 'clause'}`;
/** Each numbered heading's current number by its key: clauses ("3"), sub-clauses ("3.2"), schedules ("Schedule 1"). @param {string} text */
export function clauseRefs(text) {
  const out = new Map();
  for (const b of parseContract(text).blocks) if (b.kind === 'heading' && b.number && b.title && !out.has(refKey(b.title))) out.set(refKey(b.title), { number: b.number, title: b.title });
  return out;
}
/** Fill the fields of runs: a known value replaces the field; an empty one becomes a visible gap "[Fee]". */
export function fillRuns(runs, meta, refs = null) {
  const v = fieldValues(meta, refs);
  return runs.map((r) => (r.field ? (v.get(r.field) ? { text: v.get(r.field), filled: true } : { text: `[${fieldLabel(r.field, meta)}]`, gap: true }) : r));
}

// ------------------------------------------------------------------------------------------------ the parties block
const upper = (s) => String(s ?? '').toUpperCase();
/**
 * How the parties block describes one party (the words after its name), Indian drafting:
 * "a private limited company incorporated under the Companies Act, 2013 (CIN …), having its registered office at …".
 * @param {{ type?: string; address?: string; reg?: string; gstin?: string; note?: string }} p
 */
export function partyDescription(p) {
  const reg = p.reg ? ` (${PARTY_TYPE.get(p.type ?? '')?.reg || 'Registration no.'} ${p.reg})` : '';
  const at = p.address ? `, having its registered office at ${p.address}` : '';
  switch (p.type) {
    case 'private_limited': return `a private limited company incorporated under the Companies Act, 2013${reg}${at}`;
    case 'public_limited': return `a public limited company incorporated under the Companies Act, 2013${reg}${at}`;
    case 'proposed_company': return `a private limited company proposed to be incorporated under the Companies Act, 2013${p.note ? ` (${p.note})` : ''}, acting through its promoters until it is incorporated`;
    case 'llp': return `a limited liability partnership registered under the Limited Liability Partnership Act, 2008${reg}${at}`;
    case 'partnership': return `a partnership firm registered under the Indian Partnership Act, 1932${reg}${p.address ? `, having its principal place of business at ${p.address}` : ''}`;
    case 'proprietorship': return `a sole proprietorship${p.gstin ? ` (GSTIN ${p.gstin})` : reg}${p.address ? `, having its principal place of business at ${p.address}` : ''}`;
    case 'individual': return `an individual${p.reg ? ` holding PAN ${p.reg}` : ''}${p.address ? `, residing at ${p.address}` : ''}${p.note ? `, ${p.note}` : ''}`;
    default: return `${p.note || 'an organisation'}${reg}${p.address ? `, of ${p.address}` : ''}`;
  }
}
/** One party in the block as runs: NAME (bold caps), its description, its defined name in bold. */
export function partyRuns(p) {
  const word = definedWord(p.defined);
  const runs = [{ text: upper(p.name || `[${word || 'Party'}: name]`), bold: true }, { text: `, ${partyDescription(p)}` }];
  if (p.type !== 'individual' && p.type !== 'proposed_company') runs.push({ text: ', which expression includes its successors and permitted assigns' });
  if (word) runs.push({ text: ' (the ' }, { text: `“${word}”`, bold: true }, { text: ')' });
  runs.push({ text: ';' });
  return runs;
}

/**
 * The document's parties, from the facts (legal details) and the signing rows (who signs, signed or not): the facts
 * win for words; the rows say who signed. A row with no facts still shows, by its name.
 * @param {any} meta @param {any[]} rows pulse.contract_party rows as the API reads them
 */
export function documentParties(meta, rows = []) {
  const facts = meta?.parties ?? [];
  const used = new Set();
  const byKey = (p) => rows.findIndex((r, i) => !used.has(i) && p.key && r.key === p.key);
  const byName = (p) => rows.findIndex((r, i) => !used.has(i) && norm(r.name) && (norm(r.name) === norm(p.name) || norm(r.signer) === norm(p.signatory)));
  const out = facts.map((p) => {
    let i = byKey(p); if (i < 0) i = byName(p);
    if (i >= 0) used.add(i);
    return { ...p, row: i >= 0 ? rows[i] : null };
  });
  rows.forEach((r, i) => { if (!used.has(i)) out.push({ name: r.name, type: r.kind === 'person' ? 'individual' : 'other', defined: '', role: r.role, row: r }); });
  return out;
}
const norm = (s) => String(s ?? '').toLowerCase().replace(/private limited|pvt\.? ltd\.?|limited|llp|[^a-z0-9]/g, '');

/** Starting words for a new contract of a type (light Markdown, fields in place). @param {string} type */
export function starterText(type) {
  return STARTERS[contractType(type).key] ?? STARTERS.service;
}
/** A new contract's source: the type's parties and fields, ready to fill. @param {string} type @param {Partial<any>} over */
export function starterSource(type, over = {}) {
  const t = contractType(type);
  const meta = tidyMeta({ type: t.key, date: over.date ?? '', place: over.place ?? '', parties: over.parties ?? t.parties.map((p) => ({ name: '', type: p.type, defined: p.defined, role: p.role })),
    deal: over.deal ?? {} });
  return writeSource(meta, starterText(t.key));
}

// The clause library: standard clauses to insert, each written to stand on its own.
export const CLAUSE_LIBRARY = Object.freeze([
  { key: 'confidentiality', title: 'Confidentiality', text: 'Each Party shall keep confidential all information of the other Party that is marked confidential or that a reasonable person would treat as confidential, and shall use it only to perform this Agreement.\n\nThis clause does not apply to information that is public through no fault of the receiving Party, or that the law or a court requires to be disclosed.\n\nThis clause survives the end of this Agreement for three years.' },
  { key: 'data', title: 'Data protection', text: 'All data that the Client or its users put into the Services remains the property of the Client.\n\nThe Provider shall process personal data only on the Client’s instructions and in line with the Daruhis Personal Data Protection Act, 2023, and shall keep it secure.\n\nOn the end of this Agreement the Provider shall return the Client’s data in a usable format, and then delete it within 30 days, unless the law requires it to be kept.' },
  { key: 'ip', title: 'Intellectual property', text: 'Each Party keeps the intellectual property it owned before this Agreement.\n\nThe Provider grants the Client a non-exclusive licence to use the Services and their output for the Client’s own business during this Agreement.' },
  { key: 'fees', title: 'Fees and payment', text: 'The Client shall pay the Provider {{deal.fee}}, {{deal.gst}}.\n\nThe Provider shall raise its invoice {{deal.billing}}.\n\nLate payments carry simple interest at 12% a year from the due date until paid.' },
  { key: 'term', title: 'Term and termination', text: 'This Agreement starts on {{deal.start}} and continues until either Party ends it.\n\nEither Party may end this Agreement by giving {{deal.notice}} written notice to the other.\n\nEither Party may end this Agreement at once by written notice if the other Party commits a material breach and does not remedy it within 15 days of being asked to.' },
  { key: 'liability', title: 'Limitation of liability', text: 'Neither Party is liable for any indirect or consequential loss, or for loss of profit.\n\nEach Party’s total liability under this Agreement in any twelve months is limited to the fees paid or payable in those twelve months, except for fraud, wilful misconduct or breach of confidentiality.' },
  { key: 'indemnity', title: 'Indemnity', text: 'Each Party shall indemnify the other against any third-party claim arising from its breach of this Agreement, its negligence or its wilful misconduct.' },
  { key: 'nonsolicit', title: 'Non-solicitation', text: 'During this Agreement and for twelve months after it ends, neither Party shall directly solicit any employee of the other Party who worked on this Agreement, without the other Party’s written consent.' },
  { key: 'force', title: 'Force majeure', text: 'Neither Party is liable for a delay or failure caused by events beyond its reasonable control, such as natural disasters, war, epidemic or government action, provided it tells the other Party promptly and resumes as soon as it can.' },
  { key: 'notices', title: 'Notices', text: 'Notices under this Agreement shall be in writing and sent by e-mail or by post to the addresses given in this Agreement, or to another address a Party gives in writing.' },
  { key: 'assignment', title: 'Assignment', text: 'Neither Party may assign this Agreement without the other Party’s written consent, which shall not be unreasonably withheld.' },
  { key: 'law', title: 'Governing law and disputes', text: 'This Agreement is governed by the laws of India.\n\nThe Parties shall first try to settle any dispute by talking in good faith for 30 days.\n\nSubject to that, the courts at {{deal.city}} have exclusive jurisdiction.' },
  { key: 'arbitration', title: 'Arbitration', text: 'Any dispute not settled within 30 days shall be referred to a sole arbitrator appointed by both Parties, under the Arbitration and Conciliation Act, 1996.\n\nThe seat of arbitration is {{deal.city}} and the language is English.' },
  { key: 'entire', title: 'Entire agreement', text: 'This Agreement, with its schedules, is the entire agreement between the Parties about its subject, and replaces any earlier understanding.\n\nA change to this Agreement is valid only in writing and signed by both Parties.' },
  { key: 'esign', title: 'Counterparts and electronic signature', text: 'This Agreement may be signed electronically and in counterparts. An electronic signature and an electronic record of this Agreement are valid under the Information Technology Act, 2000.' },
  { key: 'stamp', title: 'Stamp duty', text: 'The {{deal.stamp}} shall pay the stamp duty payable on this Agreement under the applicable Stamp Act.' },
]);

const STARTERS = {
  service: `## Background
- The Provider builds and runs software and related services.
- The Client wishes to use the Provider’s services on the terms of this Agreement.

## Definitions
In this Agreement:
- "Services" means the services described in Schedule 1;
- "Fee" means the fee set out in Schedule 1;
- "Effective Date" means {{deal.start}}.

## Services
The Provider shall provide the Services with reasonable skill and care, and in line with Schedule 1.

The Client shall give the Provider the information, access and decisions it reasonably needs to provide the Services.

## Fees and payment
The Client shall pay the Fee of {{deal.fee}}, {{deal.gst}}.

The Provider shall raise its invoice {{deal.billing}}.

## Term, review and termination
This Agreement starts on the Effective Date and continues until either Party ends it.

The Parties shall review the Services and the Fee on {{deal.review}}.

Either Party may end this Agreement by giving {{deal.notice}} written notice to the other.

## Data and confidentiality
All data that the Client or its users put into the Services remains the property of the Client.

Each Party shall keep the other Party’s confidential information confidential, and use it only to perform this Agreement.

## Governing law
This Agreement is governed by the laws of India, and the courts at {{deal.city}} have exclusive jurisdiction.

## Schedule 1: The detailed sheet
| Item | Detail |
| --- | --- |
| Services | |
| Users | |
| Support | |
| Fee | {{deal.fee}}, {{deal.gst}} |
| Start date | {{deal.start}} |
| Review date | {{deal.review}} |
| What the Client provides | |
`,
  founders: `## Background
- The Founders are setting up the Company and have carried on its business together before its incorporation.
- The Founders wish to record how that business, its assets and the money spent and received before incorporation pass to the Company, and how they will work together.

## Transfer to the Company
On its incorporation, the Company shall take over the business carried on by the Founders, including its software, intellectual property, domain names, brand and customer contracts.

## Money before incorporation
Money spent and received by the Founders for the business before incorporation is listed in the money register kept by the Founders.

Founder advances of {{deal.advance}} shall be converted into shares of the Company or repaid within six months of incorporation, as the Founders agree.

## Shareholding and roles
The Founders shall hold the shares of the Company {{deal.shares}}.

## Ratification
The Founders shall cause the Company, at its first board meeting, to adopt and ratify this Agreement under sections 15(h) and 19(e) of the Specific Relief Act, 1963.

## Governing law
This Agreement is governed by the laws of India, and the courts at {{deal.city}} have exclusive jurisdiction.
`,
  offer: `## Appointment
The Company appoints the Employee as {{deal.position}} from {{deal.start}}.

## Pay
The Employee’s pay is {{deal.salary}}, paid monthly after the deductions the law requires.

## Probation and notice
The first {{deal.probation}} are a probation period.

After confirmation, either party may end the employment with {{deal.notice}} written notice.

## Conduct and policies
The Employee shall follow the Company’s policies as published from time to time.

## Confidentiality
The Employee shall keep the Company’s confidential information confidential during and after the employment.
`,
  nda: `## Purpose
The Parties wish to share confidential information {{deal.purpose}} (the "Purpose").

## Confidential information
"Confidential Information" means any information one Party shares with the other for the Purpose that is marked confidential or that a reasonable person would treat as confidential.

## Obligations
Each Party shall use the other Party’s Confidential Information only for the Purpose, and shall not share it except with its people who need to know it.

## Term
These obligations last for {{deal.term}} from the date of this Agreement.

## Governing law
This Agreement is governed by the laws of India, and the courts at {{deal.city}} have exclusive jurisdiction.
`,
  vendor: `## Supply
The Vendor shall supply the goods or services described in Schedule 1.

## Price and payment
The Company shall pay {{deal.fee}}, {{deal.gst}}, against the Vendor’s valid invoice, {{deal.billing}}.

## Quality
The Vendor warrants that its goods and services meet the description in Schedule 1 and the law.

## Termination
Either Party may end this Agreement by giving {{deal.notice}} written notice.

## Governing law
This Agreement is governed by the laws of India, and the courts at {{deal.city}} have exclusive jurisdiction.

## Schedule 1: What is supplied
| Item | Detail |
| --- | --- |
| Goods or services | |
| Price | {{deal.fee}} |
`,
  policy: `## Acceptance
The Employee confirms that they have read and understood {{deal.policy}}, and accepts it from {{deal.start}}.

## Changes
The Company may update the policy; the Employee will be asked to accept each new version.
`,
  loan: `## Acknowledgement
The Borrower acknowledges that it received {{deal.amount}} from the Lender on {{deal.received}} as an advance for its business.

## Nature of the advance
The advance is not income of the Borrower. It shall be {{deal.repay}}.

## No interest
No interest is payable on the advance unless the Parties agree otherwise in writing.

## Governing law
This acknowledgement is governed by the laws of India, and the courts at {{deal.city}} have exclusive jurisdiction.
`,
};

// ------------------------------------------------------------------------------------------------ the layers
// POLISH-1115 (owner, 14 Nov 2026): "Who pays whom is not the only thing in a contract; there are a lot of layers."
// A contract read as its layers: who it is between, the money, what each side does, ideas and data, how long it lasts
// and how it ends, the limits when something goes wrong, the law and disputes, and the schedules. Each clause goes to
// the first layer its title matches (in this order); a clause that matches none is a general term. Each layer carries
// the deal's facts that belong to it ("Fee: ₹40,000 a month"), so the page and the cover can show the shape at a glance.
const LAYER_DEFS = Object.freeze([
  { key: 'money', label: 'Money', hint: 'What is paid, by whom and when', re: /\b(fee|fees|pay|payment|payments|price|pricing|consideration|remuneration|salary|compensation|invoic|charges?|costs?|expenses|advance|advances|money|stamp duty|tax|gst|loan|repay|interest)/i,
    fields: ['fee', 'gst', 'billing', 'salary', 'amount', 'advance', 'received', 'repay'] },
  { key: 'term', label: 'How long it lasts', hint: 'When it starts, how it is reviewed and how it ends', re: /\b(term|termination|terminate|duration|notice period|ending|exit|renewal|review|commencement|probation|resignation)\b/i,
    fields: ['start', 'term', 'review', 'notice', 'probation'] },
  { key: 'ip', label: 'Ideas and data', hint: 'Who owns the work, the data and the secrets', re: /\b(intellectual|property|ip\b|ownership|licen[cs]e|copyright|confidential|confidentiality|non-?disclosure|data|privacy|personal data|transfer to the company|assets)/i,
    fields: ['purpose'] },
  { key: 'risk', label: 'Limits and risk', hint: 'What happens if something goes wrong', re: /\b(liabilit|indemn|warrant|force majeure|insurance|limitation|non-?solicit|non-?compete|restrict|quality|breach)/i, fields: [] },
  { key: 'law', label: 'Law and disputes', hint: 'Which law applies and where disputes go', re: /\b(governing law|law|laws|jurisdiction|dispute|disputes|arbitration|courts?)\b/i, fields: ['city'] },
  { key: 'duties', label: 'What each side does', hint: 'The work, the duties and the roles', re: /\b(?:services?|scope|obligations?|duties|deliverables?|supply|appointment|roles?|work|support|conduct|policies|policy|acceptance|purpose|shareholding|founders?)\b|\b(?:responsibilit|acknowledg)/i,
    fields: ['position', 'shares', 'policy'] },
]);
const LAYER_ORDER = ['parties', 'money', 'duties', 'ip', 'term', 'risk', 'law', 'general', 'schedules'];
const LAYER_META = { parties: { label: 'Parties', hint: 'Who it is between, and their legal details' }, general: { label: 'General terms', hint: 'Notices, changes and how the agreement is read' },
  schedules: { label: 'Schedules', hint: 'The detail sheets at the end' } };

/**
 * The contract as its layers, in reading order of importance. Each layer: { key, label, hint, clauses: [{ number,
 * title }], facts: [{ label, value }], parties? }. Empty layers are left out; the parties layer comes first when the
 * facts name them. @param {string} body the source (facts line and words)
 */
export function contractLayers(body) {
  const { meta, text } = readSource(body);
  const { blocks } = parseContract(text);
  /** @type {Map<string, { key: string; label: string; hint: string; clauses: { number: string; title: string }[]; facts: { label: string; value: string }[]; parties?: { name: string; defined: string; type: string; signatory: string }[] }>} */
  const by = new Map();
  const layer = (key) => {
    if (!by.has(key)) {
      const d = LAYER_DEFS.find((x) => x.key === key) ?? { label: LAYER_META[key]?.label ?? key, hint: LAYER_META[key]?.hint ?? '' };
      by.set(key, { key, label: d.label, hint: d.hint, clauses: [], facts: [] });
    }
    return by.get(key);
  };
  const parties = (meta?.parties ?? []).filter((p) => p.name || p.defined);
  if (parties.length) layer('parties').parties = parties.map((p) => ({ name: p.name, defined: definedWord(p.defined), type: PARTY_TYPE.get(p.type)?.label ?? '', signatory: p.signatory ?? '' }));
  for (const b of blocks) {
    if (b.kind !== 'heading' || b.level !== 1) continue;
    if (b.part === 'recitals') { if (parties.length) layer('parties').clauses.push({ number: '', title: 'Background' }); continue; }
    if (b.part === 'schedule') { layer('schedules').clauses.push({ number: b.number, title: b.title }); continue; }
    if (b.part !== 'clause') continue;
    const t = String(b.title ?? '');
    if (/^(definitions?|interpretation)\b/i.test(t)) { layer('general').clauses.push({ number: b.number, title: t }); continue; }
    const hit = LAYER_DEFS.find((d) => d.re.test(t));
    layer(hit?.key ?? 'general').clauses.push({ number: b.number, title: t });
  }
  for (const d of LAYER_DEFS) {
    for (const f of d.fields) {
      const v = meta?.deal?.[f];
      if (v) layer(d.key).facts.push({ label: dealLabel(f), value: v });
    }
  }
  if (meta?.date || meta?.place) {
    const made = [meta.date ? `Made on ${meta.date}` : '', meta.place ? `at ${meta.place}` : ''].filter(Boolean).join(' ');
    if (by.has('parties')) by.get('parties').facts.push({ label: 'Signed', value: made });
  }
  const terms = definedTerms(text);
  if (terms.length) layer('general').terms = terms;
  return LAYER_ORDER.filter((k) => by.has(k)).map((k) => by.get(k)).filter((l) => l.clauses.length || l.facts.length || l.parties?.length || l.terms?.length);
}
/** The terms the words define ("Services" means …, (the "Purpose")), in order, each once. @param {string} text */
export function definedTerms(text) {
  const out = [];
  const re = /["“]([A-Z][A-Za-z0-9’' -]{1,38})["”]\s+(?:means|shall mean|has the meaning|refers to)|\((?:the|each|together the)\s+["“]([A-Z][A-Za-z0-9’' -]{1,38})["”]\)/g;
  for (const m of String(text ?? '').matchAll(re)) { const t = (m[1] ?? m[2]).trim(); if (!out.includes(t)) out.push(t); }
  return out.slice(0, 24);
}

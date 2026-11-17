// CONTRACTS-2 (owner, 8 Nov 2026): the words of an agreement, shared by the API (its signed PDF and the clauses clients
// push back on), the contracts screens and the client's signing page, so all of them split and compare the same way.
// Plain text: a line "1. Scope of work" (or "## Scope of work") starts a clause; the lines after it are its words.
// {{blank}} is filled from the quotation or invoice (pulse.contract_doc_values, migration 1850).

/** The blanks a template may use, in the order the editor offers them, with their names on screen. */
export const AGREEMENT_BLANKS = Object.freeze([
  { key: 'client_name', label: 'Client name', group: 'Client' },
  { key: 'client_contact', label: 'Client contact person', group: 'Client' },
  { key: 'client_gstin', label: 'Client GSTIN', group: 'Client' },
  { key: 'client_address', label: 'Client address', group: 'Client' },
  { key: 'client_email', label: 'Client e-mail', group: 'Client' },
  { key: 'client_phone', label: 'Client phone', group: 'Client' },
  { key: 'project', label: 'Project', group: 'Work' },
  { key: 'site', label: 'Site or location', group: 'Work' },
  { key: 'items', label: 'Items and prices', group: 'Work' },
  { key: 'total', label: 'Total amount', group: 'Money' },
  { key: 'total_words', label: 'Total in words', group: 'Money' },
  { key: 'document_number', label: 'Quotation or invoice number', group: 'Money' },
  { key: 'document_date', label: 'Quotation or invoice date', group: 'Money' },
  { key: 'valid_until', label: 'Valid until', group: 'Money' },
  { key: 'due_date', label: 'Payment due date', group: 'Money' },
  { key: 'our_name', label: 'Our company name', group: 'Us' },
  { key: 'our_legal_name', label: 'Our legal name', group: 'Us' },
  { key: 'our_gstin', label: 'Our GSTIN', group: 'Us' },
  { key: 'our_address', label: 'Our address', group: 'Us' },
  { key: 'today', label: "Today's date", group: 'Us' },
]);
// Blanks a person types in (no document fills them), named for the "Fill these first" line.
/** The blanks a person fills in (no document fills them): the detailed sheet of a Master Service Agreement and its terms. */
export const SHEET_BLANKS = Object.freeze([
  { key: 'ai_employees', label: 'AI employees', hint: 'e.g. Billing assistant' },
  { key: 'users', label: 'People who use it', hint: 'e.g. Up to 25' },
  { key: 'support_hours', label: 'Support hours', hint: 'e.g. Mon–Sat, 10 am–7 pm' },
  { key: 'start_date', label: 'Start date', hint: 'e.g. 1 December 2026' },
  { key: 'review_date', label: 'Review date', hint: 'e.g. 1 March 2027' },
  { key: 'client_provides', label: 'What you provide', hint: 'e.g. A point person' },
  { key: 'notice_days', label: 'Days of notice', hint: 'e.g. 30' },
  { key: 'court_city', label: 'City of the courts', hint: 'Your office’s city' },
]);
const LABEL = new Map([...AGREEMENT_BLANKS.map((b) => [b.key, b.label]), ...SHEET_BLANKS.map((b) => [b.key, b.label])]);
/** A blank's name on screen ("Client name"); an unknown one is shown as it is written. @param {string} key */
export const blankLabel = (key) => LABEL.get(key) ?? key.replace(/_/g, ' ');

/** The blanks a text uses, once each, in order. @param {string} body @returns {string[]} */
export function blanksIn(body) {
  const seen = [];
  for (const m of String(body ?? '').matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

/** Fill the blanks; a blank with no value stays visible ({{client_gstin}}), so nobody signs a gap by mistake.
 *  The same rule as pulse.contract_fill. @param {string} body @param {Record<string, string>} values */
export function fillAgreement(body, values = {}) {
  return String(body ?? '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, k) => (values[k] != null && values[k] !== '' ? String(values[k]) : `{{${k}}}`));
}

const HEAD = /^\s*(?:#{1,3}\s+(.{1,140})|(\d{1,2})[.)]\s+(.{1,140}))\s*$/;
/**
 * The clauses of an agreement: [{ key, number, title, text }]. Words before the first heading are the opening
 * (number null, title ''). A heading line is "3. Payment terms", "3) Payment terms" or "## Payment terms"; a long
 * numbered line (a sentence, not a heading) or a priced line ("1. Design: ₹85,000") stays in the text.
 * @param {string} body
 */
export function agreementClauses(body) {
  const out = [];
  let cur = { key: 'opening', number: null, title: '', lines: [] };
  // CONTRACTS-PRO: a contract's first line (its facts, an HTML comment) is not words to show or compare.
  for (const raw of String(body ?? '').replace(/\r\n?/g, '\n').replace(/^<!--\s*pulse:contract[\s\S]*?-->\s*\n?/, '').split('\n')) {
    const m = HEAD.exec(raw);
    const title = m ? (m[1] ?? m[3]).trim() : '';
    // A heading is short and never a line of the items ("1. Design: ₹85,000") or a sentence ("…, ending with a stop.").
    if (m && title.length <= 80 && !/[.;:]$/.test(title) && !/[:₹]/.test(title)) {
      if (cur.lines.join('').trim() || cur.title) out.push(cur);
      const number = m[2] ? Number(m[2]) : null;
      cur = { key: `c${out.length + 1}-${slug(title)}`, number, title, lines: [] };
    } else cur.lines.push(raw);
  }
  if (cur.lines.join('').trim() || cur.title) out.push(cur);
  return out.map((c) => ({ key: c.key, number: c.number, title: c.title, text: c.lines.join('\n').replace(/^\n+|\s+$/g, '') }));
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** A clause's name as people say it: "3. Payment terms", or "Opening". @param {{ number: number | null; title: string }} c */
export const clauseName = (c) => (c.title ? `${c.number != null ? `${c.number}. ` : ''}${c.title}` : 'Opening');

const CLOSING = /^what happens next$/i;
/**
 * AGREEMENTS (owner, 13 Nov 2026, T1.2.1: "progressively they are clicking on terms, agreeing on that"): the key terms of
 * a published policy, the steps of its acceptance view. The API checks the terms a person ticked against these and the
 * screens show the same ones, so both split one way. A "## " line starts a term ("## 1. Who approves pay"); "###" and
 * deeper stay inside their term; a first "# " line is the document's own title. A policy with no "## " lines uses the
 * agreement headings above ("3. Notice"). Words before the first term are the introduction; a part called "What happens
 * next" is the closing (read, not ticked). A policy with no headings at all is one term, the whole text.
 * @param {string} body
 * @returns {{ intro: string; terms: { key: string; number: number | null; title: string; text: string }[]; closing: { title: string; text: string } | null }}
 */
export function policyTerms(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && /^#\s+\S/.test(lines[first])) lines.splice(0, first + 1);
  let fence = false;
  const heads = new Set();
  lines.forEach((l, i) => { if (/^\s*(```|~~~)/.test(l)) fence = !fence; else if (!fence && /^##\s+\S/.test(l)) heads.add(i); });
  /** @type {{ title: string; text: string }[]} */
  let parts;
  if (heads.size) {
    /** @type {{ title: string; lines: string[] }[]} */
    const out = [{ title: '', lines: [] }];
    lines.forEach((l, i) => { if (heads.has(i)) out.push({ title: l.replace(/^##\s+/, '').replace(/\s+#+\s*$/, '').trim(), lines: [] }); else out[out.length - 1].lines.push(l); });
    parts = out.map((p) => ({ title: p.title, text: p.lines.join('\n') }));
  } else {
    parts = agreementClauses(lines.join('\n')).map((c) => ({ title: c.number != null ? `${c.number}. ${c.title}` : c.title, text: c.text }));
    if (!parts.length || parts[0].title) parts.unshift({ title: '', text: '' });
  }
  const tidy = (/** @type {string} */ s) => s.replace(/^\n+|\s+$/g, '');
  let intro = tidy(parts[0].text);
  /** @type {{ title: string; text: string } | null} */
  let closing = null;
  const terms = [];
  for (const p of parts.slice(1)) {
    const m = /^(\d{1,2})[.)]\s+(.+)$/.exec(p.title);
    const number = m ? Number(m[1]) : null, title = (m ? m[2] : p.title).trim(), text = tidy(p.text);
    if (CLOSING.test(title)) { closing = { title, text }; continue; }
    if (!title && !text) continue;
    terms.push({ key: `t${terms.length + 1}-${slug(title) || 'term'}`, number, title, text });
  }
  if (!terms.length && intro) { terms.push({ key: 't1-policy', number: null, title: '', text: intro }); intro = ''; }
  return { intro, terms, closing };
}

/**
 * What changed between two drafts, line by line (longest common subsequence): [{ kind: 'same'|'added'|'removed', text }].
 * Small on purpose: agreements are a few hundred lines at most. @param {string} before @param {string} after
 */
export function diffLines(before, after) {
  const a = String(before ?? '').replace(/\r\n?/g, '\n').split('\n'), b = String(after ?? '').replace(/\r\n?/g, '\n').split('\n');
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return [...a.map((text) => ({ kind: 'removed', text })), ...b.map((text) => ({ kind: 'added', text }))];
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ kind: 'removed', text: a[i++] });
    else out.push({ kind: 'added', text: b[j++] });
  }
  while (i < n) out.push({ kind: 'removed', text: a[i++] });
  while (j < m) out.push({ kind: 'added', text: b[j++] });
  return out;
}

/** Which clauses changed between two drafts, by name: { changed, added, removed }. @param {string} before @param {string} after */
export function clauseChanges(before, after) {
  const a = agreementClauses(before), b = agreementClauses(after);
  const byTitle = (list) => new Map(list.map((c) => [c.title.toLowerCase(), c]));
  const A = byTitle(a), B = byTitle(b);
  return {
    changed: b.filter((c) => A.has(c.title.toLowerCase()) && A.get(c.title.toLowerCase()).text !== c.text).map(clauseName),
    added: b.filter((c) => !A.has(c.title.toLowerCase())).map(clauseName),
    removed: a.filter((c) => !B.has(c.title.toLowerCase())).map(clauseName),
  };
}

/** Join neighbours of one kind. @param {{ kind: string; text: string }[]} parts */
const joinParts = (parts) => parts.reduce((out, x) => {
  const last = out[out.length - 1];
  if (last && last.kind === x.kind) last.text += x.text; else if (x.text) out.push({ kind: x.kind, text: x.text });
  return out;
}, /** @type {{ kind: string; text: string }[]} */ ([]));

/**
 * CONTRACTS-3: what changed between two drafts, word by word (longest common subsequence over words and the spaces
 * between them): [{ kind: 'same'|'added'|'removed', text }]. A change of spaces only reads as no change. A very long
 * pair falls back to "all removed, all added" rather than a slow answer. @param {string} before @param {string} after
 */
export function diffWords(before, after) {
  const split = (s) => String(s ?? '').replace(/\r\n?/g, '\n').match(/\s+|[^\s]+/g) ?? [];
  const a = split(before), b = split(after);
  const n = a.length, m = b.length;
  if (n * m > 2_500_000) return joinParts([{ kind: 'removed', text: a.join('') }, { kind: 'added', text: b.join('') }]);
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ kind: 'removed', text: a[i++] });
    else out.push({ kind: 'added', text: b[j++] });
  }
  while (i < n) out.push({ kind: 'removed', text: a[i++] });
  while (j < m) out.push({ kind: 'added', text: b[j++] });
  // Readable changes: a short unchanged bit (spaces, or a little word like "in" or "the") between two changes is part of
  // the change, so a rewritten phrase reads as one taken-out part and one added part, not as fragments.
  const parts = joinParts(out);
  const weak = (x, k) => x.kind === 'same' && k > 0 && k < parts.length - 1 && parts[k - 1].kind !== 'same' && parts[k + 1].kind !== 'same'
    && !x.text.includes('\n') && x.text.trim().length <= 3;
  const marked = parts.map((x, k) => (weak(x, k) ? { kind: 'both', text: x.text } : x));
  const grouped = [];
  for (let k = 0; k < marked.length;) {
    if (marked[k].kind === 'same') { grouped.push(marked[k++]); continue; }
    let removed = '', added = '';
    while (k < marked.length && marked[k].kind !== 'same') {
      const x = marked[k++];
      if (x.kind !== 'added') removed += x.text;
      if (x.kind !== 'removed') added += x.text;
    }
    // A change of spaces only is no change: the new draft's spaces stay.
    if (!removed.trim() && !added.trim()) grouped.push({ kind: 'same', text: added });
    else if (!removed.trim() || !added.trim()) grouped.push({ kind: 'removed', text: removed }, { kind: 'added', text: added });
    else {
      // The same spaces at both ends of a change stay unmarked (so the old and the new text still read back exactly).
      const ends = (t) => [/^\s*/.exec(t)[0], /\s*$/.exec(t)[0]];
      const [rl, rt] = ends(removed), [al, at] = ends(added);
      const lead = rl === al ? al : '', tail = rt === at ? at : '';
      grouped.push({ kind: 'same', text: lead }, { kind: 'removed', text: removed.slice(lead.length, removed.length - tail.length) },
        { kind: 'added', text: added.slice(lead.length, added.length - tail.length) }, { kind: 'same', text: tail });
    }
  }
  return joinParts(grouped);
}

/**
 * CONTRACTS-3: two drafts compared clause by clause (matched by heading), in the newer draft's order, with a removed
 * clause where it used to be: [{ key, name, status: 'same'|'changed'|'added'|'removed', words: [{ kind, text }] }].
 * @param {string} before @param {string} after
 */
export function compareClauses(before, after) {
  const a = agreementClauses(before), b = agreementClauses(after);
  const id = (c) => c.title.toLowerCase();
  const A = new Map(a.map((c) => [id(c), c])), B = new Set(b.map(id));
  // Each removed clause goes after the last clause before it that is still there (null: at the top).
  const gone = new Map();
  let prev = null;
  for (const c of a) { if (B.has(id(c))) prev = id(c); else gone.set(prev, [...(gone.get(prev) ?? []), c]); }
  const removed = (c) => ({ key: `removed-${c.key}`, name: clauseName(c), status: 'removed', words: joinParts([{ kind: 'removed', text: c.text }]) });
  const out = (gone.get(null) ?? []).map(removed);
  for (const c of b) {
    const old = A.get(id(c));
    if (!old) out.push({ key: c.key, name: clauseName(c), status: 'added', words: joinParts([{ kind: 'added', text: c.text }]) });
    else {
      const words = old.text === c.text ? joinParts([{ kind: 'same', text: c.text }]) : diffWords(old.text, c.text);
      out.push({ key: c.key, name: clauseName(c), status: words.some((w) => w.kind !== 'same') ? 'changed' : 'same', words });
    }
    out.push(...(gone.get(id(c)) ?? []).map(removed));
  }
  return out;
}

/** A simple standard agreement in plain words, for a company that has none yet (Contracts → Templates). */
// Only blanks every issued quotation fills (a project, a site or a GSTIN is often missing; add them in your own template).
export const STARTER_AGREEMENT = `This agreement is between {{our_name}} ("we") and {{client_name}} ("you"), of {{client_address}}.
It is based on our {{document_number}} dated {{document_date}}.

1. The work
We will do this work:
{{items}}

2. Price and payment
The total price is {{total}}, including GST where it applies.
You pay as set out in the quotation or invoice. If a payment is late, we may pause the work until it is paid.

3. Dates
We start the work once this agreement is signed and the first payment is received. We will tell you early if a date has to move.

4. Changes to the work
If you want to change the work, tell us in writing. We will tell you the new price and dates before we make the change.

5. Your part
You give us the information, approvals and site access we need, on time.

6. Ending this agreement
Either side may end this agreement in writing. You pay for the work done until then.

7. Disputes
We will first try to settle any disagreement by talking. If we cannot, the courts where we are based decide.

Signed on {{today}}.`;

/** AGREEMENTS rounds 3–4 (owner, 14–15 Nov 2026): a Master Service Agreement in plain words, for a monthly service
 *  (software, a platform, AI employees, support), made from the accepted quotation. "In short" comes first, in plain words;
 *  the numbered parts are what count; the Schedule at the end is the detailed sheet for this client. The blanks no
 *  quotation fills (users, support hours, dates, notice, the court's city …) stay visible until someone fills them in
 *  ("Fill the detailed sheet" on the draft), so nobody sends a gap. */
export const STARTER_SERVICE_AGREEMENT = `Master Service Agreement between {{our_legal_name}} ("we"), of {{our_address}}, and {{client_name}} ("you"), of {{client_address}}.

## In short
• Every month we give you the services in the Schedule at the end.
• You pay the monthly fee in the Schedule ({{total}}), on one invoice at the start of each month.
• Your data stays yours, and each side keeps the other's business private.
• Either side can end it with {{notice_days}} days' notice in writing.
• It starts on {{start_date}}. We review it together on {{review_date}}.
These lines only sum it up. The numbered parts below are what count.

1. The services
We give you the services listed in the Schedule, every month. We keep them running, fix faults and make the updates we agree with you.

2. Fee and GST
The monthly fee is in the Schedule, as in our {{document_number}} dated {{document_date}}, which you accepted. GST is charged at the rate the law sets, as that document shows.
If the GST rate changes, the GST on the next invoice changes with it.

3. Monthly invoice and payment
We send you one invoice at the start of each month. You pay it within 15 days of the invoice date.
If a payment is more than 30 days late, we may pause the services after telling you in writing.

4. What you provide
You give us what the Schedule lists under "What you provide", on time. If something is late, the dates that depend on it move too.

5. Your data
Your data stays your property. We use it only to give you the services.
When this agreement ends, we give you a copy of your data in a common format and then delete it from our systems, unless the law says we must keep it.

6. Confidentiality
Each side keeps the other side's business information private and uses it only for this agreement.
This continues for 2 years after the agreement ends.

7. What each side owns
We own our software and platform. You own your data and anything we make only for you and you have paid for.

8. Changes and reviews
We review the services and the fee together on the review date. A change to the Schedule is agreed in writing, and it makes a new version of this agreement that both sides accept again.

9. Ending this agreement
Either side may end this agreement by giving {{notice_days}} days' notice in writing. You pay for the services until the notice ends.

10. Law and courts
The laws of India apply. If we cannot settle a disagreement by talking, the courts at {{court_city}} decide.

## Schedule (the detailed sheet)
For {{client_name}}, from {{document_number}}.
What is switched on, and the fee:
{{items}}
• AI employees: {{ai_employees}}
• People who use it: {{users}}
• Support hours: {{support_hours}}
• Monthly fee: {{total}}
• Start date: {{start_date}}
• Review date: {{review_date}}
• What you provide: {{client_provides}}

Signed on {{today}}.`;

/** The starting words a company can pick for a new template (Agreements → Templates). */
export const STARTER_TEMPLATES = Object.freeze([
  { key: 'standard', name: 'Standard agreement', body: STARTER_AGREEMENT },
  { key: 'msa', name: 'Master Service Agreement', body: STARTER_SERVICE_AGREEMENT },
]);

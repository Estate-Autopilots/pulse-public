/** FIN-ENTRY: entries typed in Pulse (pure parts: the one-line quick add, validation and how entries join the totals). */
export type EntryKind = 'expense' | 'income' | 'bill' | 'refund' | 'transfer';
export type Direction = 'in' | 'out' | 'neutral';
export type Entry = {
 id: string; kind: EntryKind; direction: Direction; date: string; amountMinor: number; gstMinor: number; currency: string;
 category: string | null; accountFrom: string | null; accountTo: string | null; clientId: string | null; clientName?: string | null;
 projectId: string | null; projectName?: string | null; vendor: string | null; note: string | null; billStatus: 'unpaid' | 'paid' | null;
 dueDate: string | null; status: 'approved' | 'pending' | 'rejected'; source: string; deleted: boolean;
};
export const KINDS: EntryKind[] = ['expense', 'income', 'bill', 'refund', 'transfer'];
export const KIND_WORDS: Record<EntryKind, string> = { expense: 'Expense', income: 'Payment received', bill: 'Bill', refund: 'Refund', transfer: 'Transfer' };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const iso = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null; };
const addDays = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

/** Rupees as typed ("5,000", "1.5k", "2 lakh", "₹12,500.50") → paise, or null. */
export function rupees(text: string): number | null {
 const m = /^(\d[\d,]*(?:\.\d{1,2})?)\s*(k|thousand|l|lakh|lakhs|lac|lacs|cr|crore)?$/i.exec(text.trim().replace(/^(₹|rs\.?|inr)\s*/i, ''));
 if (!m) return null;
 const n = Number(m[1].replace(/,/g, '')), unit = (m[2] ?? '').toLowerCase();
 const mult = unit === 'k' || unit === 'thousand' ? 1e3 : /^l/.test(unit) ? 1e5 : /^cr/.test(unit) ? 1e7 : 1;
 const minor = Math.round(n * mult * 100);
 return Number.isSafeInteger(minor) && minor > 0 && minor <= 9e12 ? minor : null;
}

/** A date as people write it, never in the future by more than a week: "14 Apr", "Apr 14", "14/04", "14-04-2026",
 *  "2026-04-14", "today", "yesterday". A day without a year is the latest one not after today. */
export function parseDay(text: string, today: string): string | null {
 const t = text.trim().toLowerCase(), y = Number(today.slice(0, 4));
 if (t === 'today') return today;
 if (t === 'yesterday') return addDays(today, -1);
 let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
 if (m) return iso(+m[1], +m[2], +m[3]);
 const pick = (mon: number, d: number, year?: number) => {
  if (year !== undefined) return iso(year < 100 ? 2000 + year : year, mon, d);
  const same = iso(y, mon, d);
  return same && same <= addDays(today, 7) ? same : iso(y - 1, mon, d);
 };
 m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]*([a-z]{3,9})\.?,?(?:[\s-]+(\d{2,4}))?$/.exec(t);
 if (m && MONTHS.includes(m[2].slice(0, 3))) return pick(MONTHS.indexOf(m[2].slice(0, 3)) + 1, +m[1], m[3] ? +m[3] : undefined);
 m = /^([a-z]{3,9})\.?[\s-]*(\d{1,2})(?:st|nd|rd|th)?,?(?:[\s-]+(\d{2,4}))?$/.exec(t);
 if (m && MONTHS.includes(m[1].slice(0, 3))) return pick(MONTHS.indexOf(m[1].slice(0, 3)) + 1, +m[2], m[3] ? +m[3] : undefined);
 m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/.exec(t); // Indian order: day / month
 if (m) return pick(+m[2], +m[1], m[3] ? +m[3] : undefined);
 return null;
}

/** Words that name a category, checked against the company's own list (first matching category on the list wins). */
const HINTS: [RegExp, RegExp][] = [
 [/\b(facebook|fb|meta|instagram|google ads|ads?|adwords|campaign|boost|ads manager)\b|\bfunds? add/i, /^ad|marketing/i],
 [/\b(rent|lease|office|coworking|maintenance)\b/i, /rent|office/i],
 [/\b(salary|salaries|payroll|stipend|wages)\b/i, /salar|payroll/i],
 [/\b(uber|ola|rapido|cab|taxi|flight|train|hotel|travel|petrol|fuel|toll|parking)\b/i, /travel/i],
 [/\b(lunch|dinner|food|snacks|tea|coffee|swiggy|zomato|stationery|supplies)\b/i, /food|suppl/i],
 [/\b(electricity|internet|wifi|broadband|jio|airtel|phone bill|mobile bill|water)\b/i, /utilit/i],
 [/\b(zoom|notion|slack|canva|adobe|figma|google workspace|gsuite|software|subscription|saas|openai|chatgpt|claude|hosting|domain|aws|server)\b/i, /software|tool|subscri/i],
 [/\b(ca|accountant|lawyer|legal|consultant|audit|professional)\b/i, /professional|fees/i],
 [/\b(laptop|camera|phone|monitor|equipment|mic|tripod|light)\b/i, /equip/i],
 [/\b(gst|tds|tax|challan)\b/i, /tax/i],
 [/\b(bank charge|charges|fee|interest)\b/i, /bank/i],
];
export function guessCategory(text: string, categories: string[], kind: EntryKind): string | null {
 if (kind === 'income') return categories.find((c) => /client|income|revenue/i.test(c)) ?? null;
 if (kind === 'transfer') return null;
 for (const [words, cat] of HINTS) if (words.test(text)) { const c = categories.find((x) => cat.test(x)); if (c) return c; }
 return null;
}

const near = (word: string, names: string[]) => {
 const w = word.toLowerCase().trim();
 if (!w) return null;
 return names.find((n) => n.toLowerCase() === w) ?? names.find((n) => n.toLowerCase().startsWith(w + ' ') || n.toLowerCase().split(/[\s/()-]+/)[0] === w.split(/\s+/)[0]) ?? null;
};

export type Quick = {
 kind: EntryKind; direction: Direction; amountMinor: number | null; gstMinor: number; date: string | null; dueDate: string | null; category: string | null;
 accountFrom: string | null; accountTo: string | null; vendor: string | null; clientId: string | null; clientName: string | null; note: string | null;
 understood: string[]; missing: string[];
};

/** One line → the entry form: "₹5,000 Facebook ads 14 Apr from HDFC", "received 1.2 lakh from Acme into ICICI today",
 *  "bill 18,000 + 18% GST rent due 5 Nov", "refund 2,000 from Zoom", "transfer 50k from HDFC to ICICI". */
export function parseQuick(line: string, today: string, ctx: { categories: string[]; accounts: string[]; clients?: { id: string; name: string }[] }): Quick {
 let text = ` ${line.replace(/\s+/g, ' ').trim()} `;
 const understood: string[] = [], take = (re: RegExp) => { const m = re.exec(text); if (m) text = text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length); return m; };
 // The kind, from the words used (a leading slash command names it outright).
 let kind: EntryKind = 'expense', direction: Direction = 'out';
 const cmd = take(/^\s*\/(expense|income|bill|refund|transfer|paid|received)\b/i)?.[1].toLowerCase();
 if (cmd === 'income' || cmd === 'received') kind = 'income';
 else if (cmd && cmd !== 'expense' && cmd !== 'paid') kind = cmd as EntryKind;
 if (!cmd || cmd === 'expense') {
  if (take(/\b(received|got|collected|income|payment received|credited|paid us)\b/i)) kind = 'income';
  else if (take(/\brefund(?:ed)?\b/i)) kind = 'refund';
  else if (take(/\b(transfer(?:red)?|moved|move)\b/i)) kind = 'transfer';
  else if (take(/\b(bill|invoice from)\b/i)) kind = 'bill';
  else take(/\b(spent|paid|expense|bought|for)\b/i);
 }
 if (kind === 'refund') { direction = /\b(to|gave|paid back|returned to)\b/i.test(text) && !/\bfrom\b/i.test(text) ? 'out' : 'in'; }
 else direction = kind === 'income' ? 'in' : kind === 'transfer' ? 'neutral' : 'out';
 // GST: "+18% GST" adds it, "incl 18% GST" is inside the amount, "GST 900" is the figure.
 const gstAdd = take(/\+\s*(\d{1,2}(?:\.\d+)?)\s*%\s*gst\b/i), gstIn = gstAdd ? null : take(/\b(?:incl\.?|including|inc\.?)\s*(\d{1,2}(?:\.\d+)?)\s*%\s*gst\b|\b(\d{1,2}(?:\.\d+)?)\s*%\s*gst\b/i);
 const gstFig = gstAdd || gstIn ? null : take(/\bgst\s*(?:of\s*)?(₹|rs\.?\s*)?(\d[\d,]*(?:\.\d{1,2})?)\b/i);
 // The amount: the first figure with ₹ / Rs / k / lakh, else the first bare number that is not a day.
 const amt = take(/(?:₹|\brs\.?|\binr)\s*\d[\d,]*(?:\.\d{1,2})?(?:\s*(?:k|thousand|lakhs?|lacs?|l|cr|crore)\b)?/i)
  ?? take(/\b\d[\d,]*(?:\.\d{1,2})?\s*(?:k|thousand|lakhs?|lacs?|l|cr|crore)\b/i)
  ?? take(/\b\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?\b|\b\d{3,}(?:\.\d{1,2})?\b/);
 let amountMinor = amt ? rupees(amt[0]) : null, gstMinor = 0;
 if (amountMinor) understood.push('amount');
 if (amountMinor && gstAdd) { const r = Number(gstAdd[1]); gstMinor = Math.round(amountMinor * r / 100); amountMinor += gstMinor; understood.push('GST'); }
 else if (amountMinor && gstIn) { const r = Number(gstIn[1] ?? gstIn[2]); gstMinor = Math.round(amountMinor * r / (100 + r)); understood.push('GST'); }
 else if (gstFig) { gstMinor = rupees(gstFig[2]) ?? 0; if (gstMinor) understood.push('GST'); }
 if (amountMinor && gstMinor > amountMinor) gstMinor = 0;
 // The due date of a bill, then the date itself.
 // Dates: the longest run of up to three words at any place that reads as a day ("due" before it makes it the due date).
 const findDay = (): { run: string; due: boolean } | null => {
  const words = text.trim().split(' ');
  for (let i = 0; i < words.length; i++) for (let k = 3; k >= 1; k--) {
   if (i + k > words.length) continue;
   const run = words.slice(i, i + k).join(' ').replace(/[,.]$/, '');
   if (!parseDay(run, today) || (k === 1 && !/\d|today|yesterday/i.test(run)) || /^\d{3,}$/.test(run)) continue;
   let from = i; if (from > 0 && /^(on|dated)$/i.test(words[from - 1])) from--;
   const due = from > 0 && /^due$/i.test(words[from - 1]); if (due) from--;
   text = ` ${[...words.slice(0, from), ...words.slice(i + k)].join(' ')} `;
   return { run, due };
  }
  return null;
 };
 let date: string | null = null, dueDate: string | null = null;
 for (let n = 0; n < 2; n++) {
  const f = findDay(); if (!f) break;
  if (f.due && !dueDate) dueDate = parseDay(f.run, addDays(today, 300)); else if (!date) date = parseDay(f.run, today);
 }
 if (date) understood.push('date');
 // Accounts: "from HDFC" (paid from), "into / to ICICI" (paid into); for income "from X" is the payer.
 let accountFrom: string | null = null, accountTo: string | null = null, payer: string | null = null;
 const accountRe = (w: string) => new RegExp(String.raw`\b${w}\s+(?:my\s+|our\s+|the\s+)?([a-z0-9&.]+(?:\s+(?:bank|current|savings|card|account|a\/c|upi|wallet|cc))?)`, 'i');
 const fromM = accountRe('(?:from|via|by|using|through)').exec(text);
 if (fromM) { const acc = near(fromM[1], ctx.accounts) ?? (/\b(bank|card|upi|cash|account|a\/c|wallet|cc)\b/i.test(fromM[1]) || /^(hdfc|icici|sbi|axis|kotak|yes|idfc|rbl|indusind|paytm|gpay|phonepe|cash|upi|card)$/i.test(fromM[1].split(' ')[0]) ? fromM[1] : null);
  if (acc) { accountFrom = acc; text = text.replace(fromM[0], ' '); } }
 const toM = accountRe('(?:into|to|in)').exec(text);
 if (toM) { const acc = near(toM[1], ctx.accounts) ?? (/^(hdfc|icici|sbi|axis|kotak|yes|idfc|rbl|indusind|paytm|cash|upi)$/i.test(toM[1].split(' ')[0]) ? toM[1] : null);
  if (acc) { accountTo = acc; text = text.replace(toM[0], ' '); } }
 if (kind === 'income' && accountFrom && !accountTo) { accountTo = null; }
 const payerM = /\bfrom\s+(.+?)(?=\s+(?:for|into|to|on|via)\b|\s*$)/i.exec(text);
 if (payerM && (kind === 'income' || kind === 'refund' || kind === 'bill')) { payer = payerM[1].trim(); text = text.replace(payerM[0], ' '); }
 if (accountFrom || accountTo) understood.push('account');
 // A client: a payer or a word that matches a client name.
 let clientId: string | null = null, clientName: string | null = null;
 const clients = ctx.clients ?? [];
 const findClient = (s: string) => { const w = s.toLowerCase(); return clients.find((c) => c.name.toLowerCase() === w) ?? clients.find((c) => w.length >= 4 && c.name.toLowerCase().includes(w)) ?? clients.find((c) => c.name.length >= 4 && w.includes(c.name.toLowerCase())) ?? null; };
 const forM = /\bfor\s+(.+?)(?=\s+(?:from|into|to|on|via)\b|\s*$)/i.exec(text);
 const hit = (payer && findClient(payer)) || (forM && findClient(forM[1].trim())) || null;
 if (hit) { clientId = hit.id; clientName = hit.name; understood.push('client'); if (forM && !payer && findClient(forM[1].trim())) text = text.replace(forM[0], ' '); }
 const rest = text.replace(/\b(on|at|of|the|a|an|for)\b\s*$/i, '').replace(/^\s*\b(on|at|of|the|a|an|for)\b/i, '').replace(/\s+/g, ' ').replace(/^[\s,.-]+|[\s,.-]+$/g, '');
 const vendor = kind === 'transfer' ? null : (payer && !hit ? payer : rest || null);
 const category = guessCategory(`${line}`, ctx.categories, kind);
 if (category) understood.push('category');
 const missing = amountMinor ? [] : ['amount']; // no date typed means today
 return { kind, direction, amountMinor, gstMinor, date: date ?? today, dueDate: kind === 'bill' ? dueDate : null, category, accountFrom, accountTo, vendor: vendor ? vendor.slice(0, 120) : null, clientId, clientName, note: null, understood, missing };
}

/** Checked entry fields from a form body; throws with the words a person reads. */
export function cleanEntry(b: Record<string, unknown>, today: string) {
 const text = (x: unknown, max: number) => { const s = String(x ?? '').trim().slice(0, max); return s || null; };
 const kind = String(b.kind ?? '') as EntryKind;
 if (!KINDS.includes(kind)) throw new Error('Choose what this is: expense, payment received, bill, refund or transfer');
 const amountMinor = typeof b.amountMinor === 'number' ? b.amountMinor : rupees(String(b.amount ?? ''));
 if (!amountMinor || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 9e12) throw new Error('Give the amount in rupees, like 5,000 or 1.5 lakh');
 const gst = b.gstMinor !== undefined && b.gstMinor !== null && b.gstMinor !== '' ? Number(b.gstMinor) : b.gst === undefined || b.gst === null || String(b.gst).trim() === '' ? 0 : rupees(String(b.gst));
 if (gst === null || !Number.isSafeInteger(gst) || gst < 0 || gst > amountMinor) throw new Error('GST must be a rupee figure no larger than the amount');
 const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date ?? '')) ? String(b.date) : parseDay(String(b.date ?? ''), today);
 if (!date || !iso(+date.slice(0, 4), +date.slice(5, 7), +date.slice(8, 10))) throw new Error('Choose the date');
 if (date > addDays(today, 31)) throw new Error('The date is more than a month ahead: an entry records money that moved');
 const direction: Direction = kind === 'refund' ? (b.direction === 'out' ? 'out' : 'in') : kind === 'income' ? 'in' : kind === 'transfer' ? 'neutral' : 'out';
 const accountFrom = text(b.accountFrom, 80), accountTo = text(b.accountTo, 80);
 if (kind === 'transfer' && (!accountFrom || !accountTo || accountFrom === accountTo)) throw new Error('A transfer needs two different accounts: from and into');
 const id = (x: unknown) => { const s = String(x ?? '').trim(); if (!s) return null; if (!/^[0-9a-f-]{36}$/.test(s)) throw new Error('Choose a client or project from the list'); return s; };
 const due = String(b.dueDate ?? '').trim();
 if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('Choose the due date');
 return {
  kind, direction, date, amountMinor, gstMinor: gst, category: text(b.category, 60), accountFrom, accountTo,
  clientId: id(b.clientId), projectId: id(b.projectId), vendor: text(b.vendor, 120), note: text(b.note, 1000),
  billStatus: kind === 'bill' ? (b.billStatus === 'paid' ? 'paid' : 'unpaid') : null, dueDate: kind === 'bill' && due ? due : null,
 };
}

type Months<T> = T & { month: string };
const rupee = (minor: number) => minor / 100;
const inrWords = (minor: number) => '₹' + Math.round(minor / 100).toLocaleString('en-IN');

/** The live model with approved hand entries added to its months and totals, each marked as entered in Pulse.
 *  Costs: expenses and bills (by their date) less refunds received. Money in: payments received less refunds paid.
 *  Transfers move money between the company's own accounts and change no total. */
export function withManual<M extends Record<string, unknown>>(model: M | null, entries: Entry[]): M | null {
 if (!model) return model;
 const live = entries.filter((e) => e.status === 'approved' && !e.deleted && e.currency === 'INR');
 const m = structuredClone(model) as Record<string, unknown> & { expenses?: { months?: Months<{ total: number; byCategory: Record<string, number>; basis: string | null; confidence: string | null; manual?: number }>[]; categories?: { category: string; total: number }[] };
  revenue?: { months?: Months<{ invoiced: number; invoicedGross: number; invoices: number; collected: number | null; collectedLines: number; collectedBasis: string | null; revenue: number | null; revenueBasis: string | null; confidence: string | null; manualCollected?: number }>[] };
  timeline?: { month: string; label: string; events: { kind: string; label: string; amount?: number | null; date?: string; confidence: string }[] }[] };
 const cost = new Map<string, Map<string, number>>(), cash = new Map<string, number>();
 for (const e of live) {
  const month = e.date.slice(0, 7), cat = e.category || (e.kind === 'income' ? 'Client payment' : 'Other');
  if (e.kind === 'expense' || e.kind === 'bill' || (e.kind === 'refund' && e.direction === 'in')) {
   const sign = e.kind === 'refund' ? -1 : 1, row = cost.get(month) ?? new Map<string, number>();
   row.set(cat, (row.get(cat) ?? 0) + sign * e.amountMinor); cost.set(month, row);
  } else if (e.kind === 'income' || (e.kind === 'refund' && e.direction === 'out')) cash.set(month, (cash.get(month) ?? 0) + (e.kind === 'refund' ? -1 : 1) * e.amountMinor);
 }
 if (cost.size) {
  const ex = (m.expenses ??= {}), months = (ex.months ??= []);
  for (const [month, cats] of cost) {
   let row = months.find((x) => x.month === month);
   if (!row) { row = { month, total: 0, byCategory: {}, basis: null, confidence: 'medium' }; months.push(row); }
   let added = 0;
   for (const [cat, minor] of cats) { row.byCategory[cat] = (Number(row.byCategory[cat]) || 0) + rupee(minor); added += minor; }
   row.total = (Number(row.total) || 0) + rupee(added); row.manual = (row.manual ?? 0) + rupee(added);
   row.basis = row.basis ? `${row.basis} + ${inrWords(added)} entered in Pulse` : `Entered in Pulse (${inrWords(added)})`;
  }
  months.sort((a, b) => a.month.localeCompare(b.month));
  const totals = new Map<string, number>();
  for (const c of ex.categories ?? []) totals.set(c.category, Number(c.total) || 0);
  for (const cats of cost.values()) for (const [cat, minor] of cats) totals.set(cat, (totals.get(cat) ?? 0) + rupee(minor));
  ex.categories = [...totals].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
 }
 if (cash.size) {
  const rv = (m.revenue ??= {}), months = (rv.months ??= []);
  for (const [month, minor] of cash) {
   let row = months.find((x) => x.month === month);
   if (!row) { row = { month, invoiced: 0, invoicedGross: 0, invoices: 0, collected: 0, collectedLines: 0, collectedBasis: null, revenue: null, revenueBasis: null, confidence: 'medium' }; months.push(row); }
   row.collected = (Number(row.collected) || 0) + rupee(minor); row.manualCollected = (row.manualCollected ?? 0) + rupee(minor);
   row.collectedBasis = row.collectedBasis ? `${row.collectedBasis} + ${inrWords(minor)} entered in Pulse` : `Entered in Pulse (${inrWords(minor)})`;
  }
  months.sort((a, b) => a.month.localeCompare(b.month));
 }
 if (Array.isArray(m.timeline)) for (const e of live) {
  const t = m.timeline.find((x) => x.month === e.date.slice(0, 7));
  if (t) t.events.push({ kind: 'manual', label: `${KIND_WORDS[e.kind]} · ${e.vendor || e.clientName || e.category || 'entered in Pulse'} (entered in Pulse)`, amount: rupee(e.amountMinor) * (e.direction === 'out' ? -1 : 1), date: e.date, confidence: 'medium' });
 }
 const sum = (f: (e: Entry) => boolean) => rupee(live.filter(f).reduce((n, e) => n + e.amountMinor, 0));
 m.manual = { count: live.length, pending: entries.filter((e) => e.status === 'pending' && !e.deleted).length, moneyIn: sum((e) => e.direction === 'in'), moneyOut: sum((e) => e.direction === 'out'),
  basis: 'Approved entries typed in Pulse (form, quick add, Chats or a confirmed WhatsApp screenshot), added to the imported figures for their month' };
 return m as M;
}

/** A WhatsApp payment screenshot as a suggested entry. */
export function suggestFromScreen(s: { amount: number | null; payee: string | null; sentAt: string | null; senderRole: string | null; messageText: string | null; groupTitle: string | null; clientHint: string | null; datesInText: string[] }, today: string, categories: string[]) {
 const words = `${s.payee ?? ''} ${s.messageText ?? ''}`;
 const ads = /facebook|meta|google|\bads?\b|fund|recharge|top.?up|\badd(ed)?\b/i.test(words);
 const kind: EntryKind = s.senderRole === 'client' && !ads ? 'income' : 'expense';
 const date = s.datesInText.map((d) => parseDay(d.replace(/,/g, ''), today)).find((d): d is string => !!d && (!s.sentAt || Math.abs(Date.parse(d) - Date.parse(s.sentAt.slice(0, 10))) <= 10 * 864e5)) ?? (s.sentAt ? s.sentAt.slice(0, 10) : today);
 const client = s.clientHint || (s.groupTitle ? s.groupTitle.split('|').map((x) => x.replace(/^\s*pod\s*-?\s*\d*\s*/i, '').trim()).filter(Boolean)[0] ?? null : null);
 return { kind, direction: (kind === 'income' ? 'in' : 'out') as Direction, date, amountMinor: s.amount ? Math.round(s.amount * 100) : null, category: guessCategory(ads ? 'ads' : words, categories, kind),
  vendor: kind === 'expense' ? (s.payee?.replace(/\s+/g, ' ').slice(0, 120) || (ads ? 'Ads top-up' : null)) : null, client, note: [s.groupTitle ? `WhatsApp: ${s.groupTitle}` : null, s.messageText].filter(Boolean).join(' · ').slice(0, 900) || null };
}

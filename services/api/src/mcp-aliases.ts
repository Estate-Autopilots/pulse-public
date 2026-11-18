// WL-QUOTE-LIVE (10 Nov 2026): an AI's tool call says what it means in the words models reach for. The suite (44
// salesperson conversations with the quotation agent, Hindi, Marathi, English) saw over half of its quotations refused
// for three names, and a refused AI rarely retries: lines with "quantity" or "catalogItemId"/"catalogueItemId", and a
// buyer with "city". Only the MCP tool path is forgiving, only for these unambiguous names, and only when the real
// field is not given too; the HTTP API v1 contract stays exact. Prices are never guessed (rupees or paise).
type Obj = Record<string, unknown>;
const LINE_TOOLS = new Set(['create_quotation', 'revise_quotation', 'create_invoice', 'create_quote_draft']);
const ITEM = ['catalogItemId', 'catalogueItemId', 'catalog_item_id', 'catalogue_item_id', 'item_id', 'productId', 'product_id'];
const ADDRESS = ['city', 'state', 'pincode', 'pinCode', 'postcode'];
const obj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);

function line(l: unknown): unknown {
  if (!obj(l)) return l;
  const o: Obj = { ...l };
  if (o.qty === undefined && o.quantity !== undefined) { o.qty = o.quantity; delete o.quantity; }
  for (const k of ITEM) if (o.itemId === undefined && typeof o[k] === 'string') { o.itemId = o[k]; delete o[k]; }
  return o;
}
function buyer(b: unknown): unknown {
  if (!obj(b)) return b;
  const o: Obj = { ...b }, extra = ADDRESS.filter((k) => typeof o[k] === 'string' && String(o[k]).trim());
  if (!extra.length) return o;
  const address = Array.isArray(o.address) ? [...o.address as unknown[]] : typeof o.address === 'string' && o.address.trim() ? [o.address] : [];
  for (const k of extra) { if (!address.some((a) => String(a).toLowerCase().includes(String(o[k]).toLowerCase()))) address.push(String(o[k]).trim()); delete o[k]; }
  o.address = address.slice(0, 6);
  return o;
}
const LANGS: [RegExp, string][] = [[/^(hindi|hin|हिंदी|हिन्दी)$/i, 'hi'], [/^(marathi|mar|मराठी)$/i, 'mr'], [/^(english|eng)$/i, 'en']];
/** A count or a rupee amount written as text ("2", "2,500", "₹4,000") as the number it says; anything else untouched. */
function numbers(it: unknown): unknown {
  if (!obj(it)) return it;
  const o: Obj = { ...it };
  for (const k of ['qty', 'priceRupees', 'discountPercent']) {
    const v = o[k];
    if (typeof v === 'string' && /^\s*(₹|rs\.?)?\s*\d[\d,]*(\.\d+)?\s*%?\s*$/i.test(v)) o[k] = Number(v.replace(/[^\d.]/g, ''));
  }
  return o;
}
// BHARATA-2: draft_quotation's items said in words: "quantity" is qty, and the words may come as name, item, text,
// description or product; the client as clientName, customer or name. Prices are never renamed.
const WORDS = ['name', 'item', 'text', 'description', 'product'];
function said(it: unknown): unknown {
  if (!obj(it)) return typeof it === 'string' ? { words: it } : it;
  const o: Obj = { ...it };
  if (o.qty === undefined && o.quantity !== undefined) { o.qty = o.quantity; delete o.quantity; }
  for (const k of WORDS) if (o.words === undefined && typeof o[k] === 'string') { o.words = o[k]; delete o[k]; }
  // The suite (18:17) saw items sent by catalogue code ({"code": "SV-DELIVERY"}): the code is the words (an exact
  // match on the server), or goes in front of them.
  for (const k of ['code', 'itemCode', 'sku']) {
    const c = o[k];
    if (typeof c === 'string' && c.trim()) { o.words = o.words === undefined ? c : `${c} ${String(o.words)}`; delete o[k]; }
  }
  return o;
}
// WL-DOCS (18 Nov 2026): list_tasks as models word it. Production (Willow Lane, 7 and 16 Nov) refused 11 calls with 400:
// a status Pulse does not have ("pending", "in_progress", "completed"), who "all", a limit sent as a number or above
// 100. The meaning is plain, so the MCP tool path reads it; anything it cannot read is left out (the default applies).
const TASK_STATUS: [RegExp, string][] = [[/^(open|pending|todo|to[-_ ]?do|in[-_ ]?progress|active|not[-_ ]?done|incomplete|waiting|blocked|overdue|due)$/i, 'open'],
  [/^(done|complete|completed|closed|finished|resolved)$/i, 'done'], [/^(all|any|every|both)$/i, 'all']];
const TASK_WHO: [RegExp, string][] = [[/^(me|mine|my|self|myself)$/i, 'me'], [/^(anyone|all|any|everyone|everybody|team|company|others)$/i, 'anyone']];
const pick = (v: unknown, table: [RegExp, string][]) => typeof v === 'string' ? table.find(([re]) => re.test(v.trim()))?.[1] : undefined;
function taskList(args: Obj): Obj {
  const out: Obj = { ...args };
  for (const k of Object.keys(out)) if (out[k] === null || out[k] === '') delete out[k];
  for (const [k, table] of [['status', TASK_STATUS], ['who', TASK_WHO]] as const) {
    if (out[k] === undefined) continue;
    const v = pick(out[k], table);
    if (v) out[k] = v; else delete out[k];
  }
  if (out.limit !== undefined) {
    const n = Math.floor(Number(out.limit));
    if (Number.isFinite(n) && n >= 1) out.limit = String(Math.min(n, 100)); else delete out.limit;
  }
  for (const k of ['assignee', 'assignee_id', 'personId']) if (out.assigneeId === undefined && typeof out[k] === 'string' && /^[0-9a-f-]{36}$/i.test(out[k] as string)) { out.assigneeId = out[k]; delete out[k]; }
  for (const k of ['project', 'project_id']) if (out.projectId === undefined && typeof out[k] === 'string' && /^[0-9a-f-]{36}$/i.test(out[k] as string)) { out.projectId = out[k]; delete out[k]; }
  for (const k of ['search', 'q', 'text', 'title']) if (out.query === undefined && typeof out[k] === 'string' && (out[k] as string).trim()) { out.query = out[k]; delete out[k]; }
  return out;
}
/** The tool call's arguments with those names mapped onto the real fields (a copy; anything else untouched). */
export function aiArgs(tool: string, args: Obj): Obj {
  if (tool === 'list_tasks' && obj(args)) return taskList(args);
  // WL-DOCS (live walk, 18 Nov 2026): asked to "show" a doc, the model sent create_doc {openBeside: true}: an answer
  // field, not an argument, so the call was refused and the doc cost two rounds. Opening is the runtime's step.
  if (tool === 'create_doc' && obj(args) && ['openBeside', 'open', 'openInSidePanel', 'show'].some((k) => k in args)) {
    const rest: Obj = { ...args };
    for (const k of ['openBeside', 'open', 'openInSidePanel', 'show']) delete rest[k];
    return rest;
  }
  // WL-DOCS: send_doc's reader is "to"; models send personId, person, recipient or toPersonId (an id only).
  if (tool === 'send_doc' && obj(args) && args.to === undefined) {
    const k = ['personId', 'person', 'recipient', 'recipientId', 'toPersonId', 'person_id'].find((x) => typeof args[x] === 'string' && /^[0-9a-f-]{36}$/i.test(args[x] as string));
    if (k) { const { [k]: to, ...rest } = args; return { ...rest, to }; }
  }
  if (tool === 'draft_quotation' && obj(args)) {
    const out: Obj = { ...args };
    for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
    if (Array.isArray(out.items)) out.items = out.items.map(said).map(numbers).map((it) => obj(it) ? Object.fromEntries(Object.entries(it).filter(([, v]) => v !== null)) : it);
    // The language by its name ("Hindi", "मराठी"); anything else is left out (Pulse reads it from the words).
    if (typeof out.lang === 'string' && !['en', 'hi', 'mr'].includes(out.lang)) {
      const l = LANGS.find(([re]) => re.test(String(out.lang)))?.[1];
      if (l) out.lang = l; else delete out.lang;
    }
    for (const k of ['newClient', 'confirmNewClient', 'sameAsLast', 'submit']) if (out[k] === 'true' || out[k] === 'false') out[k] = out[k] === 'true';
    for (const k of ['clientName', 'customer', 'customerName', 'name']) if (out.client === undefined && typeof out[k] === 'string') { out.client = out[k]; delete out[k]; }
    return out;
  }
  if (!LINE_TOOLS.has(tool) || !obj(args)) return args;
  const out: Obj = { ...args };
  if (Array.isArray(out.lines)) out.lines = out.lines.map(line);
  if (out.buyer !== undefined) out.buyer = buyer(out.buyer);
  return out;
}

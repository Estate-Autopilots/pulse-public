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
/** The tool call's arguments with those names mapped onto the real fields (a copy; anything else untouched). */
export function aiArgs(tool: string, args: Obj): Obj {
  if (!LINE_TOOLS.has(tool) || !obj(args)) return args;
  const out: Obj = { ...args };
  if (Array.isArray(out.lines)) out.lines = out.lines.map(line);
  if (out.buyer !== undefined) out.buyer = buyer(out.buyer);
  return out;
}

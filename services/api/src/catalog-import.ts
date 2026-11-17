// GROWTH-LOOP slice 5 (owner, 8 Nov 2026; Kazuk builds EA's catalogue himself): import a price list into Billing's
// catalogue from a Google Sheet, an Excel or CSV file, or a table pasted from a doc. The browser reads the file and
// matches its columns (apps/web/app/lib/catalog-import.mjs); this checks every row again, compares it with the
// catalogue (by name), and, unless it is a dry run, makes and changes the items in one batch that remembers each
// item's values before and after: GET it to show what changed, POST …/undo to put it back (1896).
// Who: leadership and the Finance role (Billing's full seat); a salesperson's seat does not import.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx, type Viewer } from './routes.js';

type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const GST_RATES = [0, 0.1, 0.25, 1.5, 3, 5, 6, 12, 18, 28, 40] as const;
export const MAX_ROWS = 2000;

// WL-ONBOARD-FIX (17 Nov 2026): Willow Lane's Sakobe keeps prices and stock (about 150 items, some out of stock). A
// "Stock" column sets what is on the shelf now: one counted adjustment per item (erp_stock_set, as the item page's "set
// the current stock"), stock tracking switched on for it, shown in the preview first and put back by Undo.
export type ImportRow = { name: string; unit: string; price: number; gstRate: number; sac: string | null; category: string | null; stock?: number | null };
export type Skipped = { row: number; name: string; why: string };

const text = (x: unknown) => (x === null || x === undefined ? '' : String(x)).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** "₹4,500", "4500.50", "Rs. 1,24,500/-" → paise; anything else (or negative) → null. */
export function paise(x: unknown): number | null {
  if (typeof x === 'number') return Number.isFinite(x) && x >= 0 && x <= 1e10 ? Math.round(x * 100) : null;
  const s = text(x).replace(/^(₹|rs\.?|inr)\s*/i, '').replace(/\/-$/, '').replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n <= 1e10 ? Math.round(n * 100) : null;
}

/** "18%", "18", "0.18" (a fraction), "GST 12" → one of India's GST rates; empty → 18; anything else → null. */
export function gstRate(x: unknown): number | null {
  const s = text(x).replace(/^gst\s*/i, '').replace(/%$/, '').trim();
  if (s === '') return 18;
  let n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n < 1 && !(GST_RATES as readonly number[]).includes(n)) n = Math.round(n * 10000) / 100;
  return (GST_RATES as readonly number[]).includes(n) ? n : null;
}

/** "12", "1,200", "12 nos", "0" → the count on hand; empty → undefined (stock untouched); anything else → null. */
export function stockQty(x: unknown): number | null | undefined {
  const s = text(x).replace(/[,\s]/g, '').replace(/(nos?|pcs|pieces|units?)$/i, '');
  if (s === '') return undefined;
  if (!/^\d+(\.\d{1,3})?$/.test(s)) return null;
  const n = Number(s);
  return n <= 1e9 ? n : null;
}

/** Every row checked: what will be imported, and what is skipped with a plain reason (rows count from 1). */
export function cleanRows(rows: unknown): { rows: ImportRow[]; skipped: Skipped[] } {
  if (!Array.isArray(rows)) return fail(400, 'Send the rows to import'); // return: rows is an array below (tsc)
  if (rows.length > MAX_ROWS) fail(400, 'Import up to 2,000 items at a time');
  const out: ImportRow[] = [], skipped: Skipped[] = [], seen = new Set<string>();
  (rows as Body[]).forEach((r, i) => {
    const row = i + 1, name = text(r?.name).slice(0, 160);
    if (!name) { skipped.push({ row, name: '', why: 'No name' }); return; }
    const price = paise(r?.rate);
    if (price === null) { skipped.push({ row, name, why: text(r?.rate) ? 'The rate is not a number' : 'No rate' }); return; }
    const gst = gstRate(r?.gst);
    if (gst === null) { skipped.push({ row, name, why: 'GST % is not 0, 5, 12, 18, 28 or another GST rate' }); return; }
    const sacRaw = text(r?.sac).replace(/\s/g, '');
    if (sacRaw && !/^\d{4,8}$/.test(sacRaw)) { skipped.push({ row, name, why: 'HSN/SAC is 4 to 8 digits' }); return; }
    const stock = stockQty(r?.stock);
    if (stock === null) { skipped.push({ row, name, why: 'Stock is not a count (0 or more)' }); return; }
    const key = name.toLowerCase();
    if (seen.has(key)) { skipped.push({ row, name, why: 'The same name is in the list twice' }); return; }
    seen.add(key);
    out.push({ name, unit: text(r?.unit).slice(0, 20) || 'nos', price, gstRate: gst, sac: sacRaw || null, category: text(r?.category).slice(0, 60) || null, ...(stock !== undefined ? { stock } : {}) });
  });
  return { rows: out, skipped };
}

/** A service unless the code is a goods HSN (SAC codes for services start with 99). */
export const kindOf = (sac: string | null) => (sac && !sac.startsWith('99') ? 'product' : 'service');

type Existing = { id: string; name: string; unit: string; price: string | number; gst_rate: string | number; sac: string | null; category: string | null;
  on_hand?: string | number | null; track_stock?: boolean; serialised?: boolean; kind?: string };
const shape = (e: Existing) => ({ name: e.name, unit: e.unit, price: Number(e.price), gstRate: Number(e.gst_rate), sac: e.sac, category: e.category,
  ...(e.on_hand !== undefined ? { stock: e.track_stock ? Number(e.on_hand ?? 0) : null } : {}) });
/** The catalogue fields only (an import's Undo restores these unless they were changed again since). */
const same = (a: ReturnType<typeof shape>, b: ImportRow) => a.name === b.name && a.unit === b.unit && a.price === b.price && a.gstRate === b.gstRate && a.sac === b.sac && a.category === b.category;
/** Whether a row's stock can be set on this item: counted (not by serial numbers) and not a package. */
const countable = (e: Existing | null, r: ImportRow) => r.stock !== undefined && r.stock !== null && !e?.serialised && e?.kind !== 'package';
/** The row asks for a stock the item does not have now. */
const stockChanges = (e: Existing | null, r: ImportRow) => countable(e, r) && (!e?.track_stock || Number(e?.on_hand ?? 0) !== r.stock);

async function fullSeat(c: PoolClient) {
  await c.query('select pulse.erp_require(true)');
  await c.query('select pulse.erp_bootstrap()');
  if ((await c.query<{ own: boolean }>('select pulse.erp_own_only() own')).rows[0].own) fail(403, 'Importing the price list is for leadership and the Finance role');
}

async function plan(c: PoolClient, rows: ImportRow[]) {
  const names = rows.map((r) => r.name.toLowerCase());
  const existing = (await c.query<Existing>(`select id, name, unit, price, gst_rate, sac, category, kind, track_stock, serialised, pulse.erp_on_hand(id) on_hand from pulse.erp_item
     where status <> 'archived' and lower(btrim(name)) = any($1) order by updated_at desc`, [names])).rows;
  const byName = new Map<string, Existing>();
  for (const e of existing) if (!byName.has(e.name.trim().toLowerCase())) byName.set(e.name.trim().toLowerCase(), e);
  return rows.map((r) => {
    const e = byName.get(r.name.toLowerCase());
    if (!e) return { action: 'created' as const, row: r, item: null };
    return { action: same(shape(e), r) && !stockChanges(e, r) ? 'unchanged' as const : 'updated' as const, row: r, item: e };
  });
}

async function importRows(c: PoolClient, v: Viewer, b: Body) {
  await fullSeat(c);
  const { rows, skipped } = cleanRows(b.rows);
  // A Stock column with inventory off changes nothing in stock: the rows import, and the plan says why stock did not.
  const stockOff = rows.some((r) => r.stock !== undefined) && (await c.query<{ on: boolean }>('select inventory_enabled "on" from pulse.erp_settings')).rows[0]?.on !== true;
  if (stockOff) for (const r of rows) delete r.stock;
  const steps = await plan(c, rows);
  const count = (a: string) => steps.filter((s) => s.action === a).length;
  // A serial-numbered item is counted by its serial numbers on its own page: its row imports, its stock is left alone.
  const stockLeft = steps.filter((s) => s.row.stock !== undefined && s.row.stock !== null && !countable(s.item, s.row)).map((s) => s.row.name).slice(0, 20);
  const summary = { created: count('created'), updated: count('updated'), unchanged: count('unchanged'), skipped, ...(stockLeft.length ? { stockLeft } : {}), ...(stockOff ? { stockOff } : {}) };
  const preview = steps.filter((s) => s.action !== 'unchanged').slice(0, 200).map((s) => ({ action: s.action, name: s.row.name, before: s.item ? shape(s.item) : null, after: s.row }));
  if (b.dryRun === true) return { dryRun: true, ...summary, changes: preview };
  if (!steps.some((s) => s.action !== 'unchanged')) fail(400, skipped.length ? 'Nothing to import: every row was skipped or is already in the catalogue' : 'Everything in this list is already in the catalogue');
  const approval = (await c.query<{ q: boolean }>('select quote_approval q from pulse.erp_settings')).rows[0]?.q === true;
  const fileName = text(b.fileName).slice(0, 200) || null;
  const batch = (await c.query<{ id: string }>(`insert into pulse.erp_import_batch(org_id, file_name, created_by, created_count, updated_count, unchanged_count, skipped_count)
     values (pulse.current_org(), $1, $2, $3, $4, $5, $6) returning id`, [fileName, v.person, summary.created, summary.updated, summary.unchanged, skipped.length])).rows[0].id;
  for (const s of steps) {
    if (s.action === 'unchanged') continue;
    const r = s.row;
    if (s.action === 'created') {
      const id = (await c.query<{ id: string }>(`insert into pulse.erp_item(org_id, kind, name, sac, unit, price, gst_rate, category, status, source, created_by, updated_by)
         values (pulse.current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) returning id`,
        [kindOf(r.sac), r.name, r.sac, r.unit, r.price, r.gstRate, r.category, approval ? 'draft' : 'active', JSON.stringify({ type: 'import', batch }), v.person])).rows[0].id;
      if (countable(null, r)) await setStock(c, id, r.stock!, fileName);
      await c.query(`insert into pulse.erp_import_change(org_id, batch_id, item_id, action, before, after) values (pulse.current_org(), $1, $2, 'created', null, $3)`, [batch, id, JSON.stringify(r)]);
    } else {
      await c.query(`update pulse.erp_item set name = $2, unit = $3, price = $4, gst_rate = $5, sac = $6, category = $7, updated_by = $8 where id = $1`,
        [s.item!.id, r.name, r.unit, r.price, r.gstRate, r.sac, r.category, v.person]);
      // Undo puts the count back as it was (and stock tracking off again when it was off).
      const before = { ...shape(s.item!), onHand: Number(s.item!.on_hand ?? 0), tracked: !!s.item!.track_stock };
      const after = countable(s.item, r) ? r : { ...r, stock: undefined };
      if (stockChanges(s.item, r)) await setStock(c, s.item!.id, r.stock!, fileName);
      await c.query(`insert into pulse.erp_import_change(org_id, batch_id, item_id, action, before, after) values (pulse.current_org(), $1, $2, 'updated', $3, $4)`,
        [batch, s.item!.id, JSON.stringify(before), JSON.stringify(after)]);
    }
  }
  return { batch, ...summary, changes: preview };
}

async function batchOf(c: PoolClient, id: string) {
  const b = (await c.query(`select b.id, b.file_name "fileName", b.created_at "createdAt", b.created_count "created", b.updated_count "updated",
      b.unchanged_count "unchanged", b.skipped_count "skipped", b.undone_at "undoneAt", p.display_name "by"
      from pulse.erp_import_batch b left join pulse.person p on p.id = b.created_by where b.id = $1`, [id])).rows[0];
  if (!b) fail(404, 'That import was not found');
  const changes = (await c.query(`select ch.action, ch.before, ch.after, ch.item_id "itemId", i.status from pulse.erp_import_change ch
      join pulse.erp_item i on i.id = ch.item_id where ch.batch_id = $1 order by ch.action, ch.after->>'name'`, [id])).rows;
  return { ...b, changes };
}

/** The count on the shelf now, as the item page sets it (stock tracking switched on first). */
async function setStock(c: PoolClient, item: string, qty: number, fileName: string | null) {
  await c.query('update pulse.erp_item set track_stock = true where id = $1 and not track_stock', [item]);
  await c.query('select pulse.erp_stock_set($1, $2, null, $3)', [item, qty, `Stock from the price list import${fileName ? ` (${fileName})` : ''}`.slice(0, 500)]);
}

/** Put a batch back: made items archived, changed items restored unless they were changed again since. */
async function undo(c: PoolClient, v: Viewer, id: string) {
  await fullSeat(c);
  const b = (await c.query<{ undone_at: string | null }>('select undone_at from pulse.erp_import_batch where id = $1 for update', [id])).rows[0];
  if (!b) fail(404, 'That import was not found');
  if (b.undone_at) fail(409, 'This import was already undone');
  let archived = 0, restored = 0;
  const left: string[] = [];
  const changes = (await c.query<{ item_id: string; action: string; before: (ImportRow & { onHand?: number; tracked?: boolean }) | null; after: ImportRow }>('select item_id, action, before, after from pulse.erp_import_change where batch_id = $1', [id])).rows;
  for (const ch of changes) {
    const now = (await c.query<Existing & { status: string }>('select id, name, unit, price, gst_rate, sac, category, status from pulse.erp_item where id = $1 for update', [ch.item_id])).rows[0];
    if (!now) continue;
    if (!same(shape(now), ch.after)) { left.push(now.name); continue; }
    if (ch.action === 'created') {
      if (now.status !== 'archived') { await c.query("update pulse.erp_item set status = 'archived', updated_by = $2 where id = $1", [ch.item_id, v.person]); archived++; }
    } else if (ch.before) {
      const p = ch.before;
      await c.query('update pulse.erp_item set name = $2, unit = $3, price = $4, gst_rate = $5, sac = $6, category = $7, updated_by = $8 where id = $1',
        [ch.item_id, p.name, p.unit, p.price, p.gstRate, p.sac, p.category, v.person]);
      // The count goes back only while it is still the imported one (a sale since then stays counted).
      if (typeof ch.after.stock === 'number' && typeof p.onHand === 'number') {
        const onHand = Number((await c.query<{ n: string }>('select pulse.erp_on_hand($1) n', [ch.item_id])).rows[0].n);
        if (onHand === ch.after.stock) {
          if (onHand !== p.onHand) await c.query('select pulse.erp_stock_set($1, $2, null, $3)', [ch.item_id, p.onHand, 'Price list import undone']);
          if (p.tracked === false) await c.query('update pulse.erp_item set track_stock = false, reorder_level = null where id = $1', [ch.item_id]);
        }
      }
      restored++;
    }
  }
  await c.query('update pulse.erp_import_batch set undone_at = now(), undone_by = $2 where id = $1', [id, v.person]);
  return { archived, restored, left };
}

/** A Google Sheets link → its CSV export address (a sheet shared "Anyone with the link"); anything else → null. */
export function sheetCsvUrl(x: unknown): string | null {
  const m = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,80})(?:\/[^?#]*)?(?:[?#].*?(?:gid=(\d{1,12})))?/.exec(text(x));
  return m ? `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${m[2] ? `&gid=${m[2]}` : ''}` : null;
}

export function registerCatalogImportRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const body = { type: 'object', maxProperties: 6 } as const;
  app.post<{ Body: Body }>('/api/v0/erp/catalog/import', { schema: { body }, bodyLimit: 4 * 1024 * 1024 }, (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Sign in with your own account to import');
    return importRows(c, v, req.body ?? {});
  }));
  app.get('/api/v0/erp/catalog/imports', (req) => tx(req, async (c) => {
    await fullSeat(c);
    return { imports: (await c.query(`select b.id, b.file_name "fileName", b.created_at "createdAt", b.created_count "created", b.updated_count "updated",
        b.unchanged_count "unchanged", b.skipped_count "skipped", b.undone_at "undoneAt", p.display_name "by"
        from pulse.erp_import_batch b left join pulse.person p on p.id = b.created_by order by b.created_at desc limit 10`)).rows };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/erp/catalog/imports/:id', (req) => tx(req, async (c) => {
    await fullSeat(c);
    return batchOf(c, UUID.test(req.params.id) ? req.params.id : fail(404, 'That import was not found'));
  }));
  app.post<{ Params: { id: string } }>('/api/v0/erp/catalog/imports/:id/undo', (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Sign in with your own account to undo an import');
    await fullSeat(c);
    return undo(c, v, UUID.test(req.params.id) ? req.params.id : fail(404, 'That import was not found'));
  }));
  // A Google Sheet shared "Anyone with the link": its first (or linked) tab as CSV, read on the server (Google only).
  app.post<{ Body: Body }>('/api/v0/erp/catalog/sheet', { schema: { body } }, (req) => tx(req, async (c) => {
    await fullSeat(c);
    const url = sheetCsvUrl(req.body?.url) ?? fail(400, 'Paste a Google Sheets link (docs.google.com/spreadsheets/…)');
    let r: Response;
    try { r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) }); } catch { return fail(502, 'Google Sheets did not answer. Try again, or download the sheet as CSV and upload it.'); }
    const type = r.headers.get('content-type') ?? '';
    if (!r.ok || !/text\/csv|text\/plain/.test(type)) fail(400, 'That sheet is not shared with "Anyone with the link". Share it that way, or download it as CSV and upload it.');
    const csv = await r.text();
    if (csv.length > 3 * 1024 * 1024) fail(400, 'That sheet is too big. Import up to 2,000 rows at a time.');
    return { csv };
  }));
}

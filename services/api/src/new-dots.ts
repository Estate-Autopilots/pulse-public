// NEW-DOTS (owner, 8 Nov 2026): red "new" dots on the pages a release changed, until the person has looked.
//   GET  /api/v0/whats-new/unseen    { on, count, items: [{ note, route, anchor, opened, text, headline, releasedAt }] }
//   POST /api/v0/whats-new/seen      { path } (a page they opened), { path, anchor } (NEW-DOTS-2: they reached the thing
//                                    that changed on it) or { all: true } (Mark all as seen) → the same, plus `cleared`:
//                                    what that visit or reach cleared (the page's "New: …" line)
//   POST /api/v0/whats-new/dots      { on } — the person's own switch (Settings → Notifications); default on
// The changed pages come from the release notes for the person's audiences (pulse.release_notes, whats-new.ts), only
// pages they can open (new-dots-access.ts: their role, seat, hidden screens and switched-off modules), from releases of
// the last 30 days. What they have seen is kept per person on the server (pulse.release_seen, 1897; per thing on a page
// since NEW-DOTS-2, 1898: its `anchor`), so it follows them to every device.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { roleScreens } from './flow/setup.js';
import { readModules } from './modules.js';
import { ANCHOR_RE, clearedBy, itemsOf, reachedBy, seenKey, thingCount, unseenOf, type DotItem, type PageAccess } from './new-dots-access.js';
import type { Tx, Viewer } from './routes.js';
import { viewerHiddenScreens } from './screens.js';
import { PRODUCT, viewerAudiences } from './whats-new.js';

const STAFF_SIDES = new Set(['staff', '', undefined]);

/** The facts the rail is built from (as /me gives the web), for deciding which pages this person can open. */
async function accessOf(c: PoolClient, v: Viewer): Promise<PageAccess> {
  const staff = STAFF_SIDES.has(v.side);
  const f = (await c.query<{ sales: boolean; platform: boolean; company: Record<string, unknown> | null; personal: boolean }>(`select
      exists(select 1 from pulse.role_assignment r where r.org_id = pulse.current_org() and r.person_id = $1 and r.role_key in ('sales', 'sales_head')
             and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')) sales,
      case when $2 then pulse.platform_admin() else false end platform,
      pulse.org_modules() company,
      coalesce((select o.kind = 'personal' from pulse.org o where o.id = pulse.current_org()), false) personal`, [v.person, v.role === 'admin'])).rows[0];
  const hidden = staff && v.role !== 'accountant' && v.person ? (await viewerHiddenScreens(c, v.role, (await roleScreens(c, v.person)).screens ?? [])).paths : [];
  return { role: v.role, side: v.side, lead: v.lead, salesSeat: !!f?.sales, platformAdmin: !!f?.platform, hidden,
    modulesOff: (await readModules(c, v.org)).off, company: f?.company ?? null, personal: !!f?.personal };
}

type State = { on: boolean; count: number; items: DotItem[] };

type Parts = { on: boolean; all: DotItem[]; seen: Set<string>; access: PageAccess };

/** What this person's state is made of: the changed pages of their releases, what they have seen, what they can open
 *  and their switch. */
async function partsOf(c: PoolClient, v: Viewer): Promise<Parts | null> {
  if (!v.person) return null;
  const audiences = await viewerAudiences(c, v);
  const notes = (await c.query<{ r: { id: number }[] }>('select pulse.release_notes($1, $2, 20) r', [PRODUCT, audiences])).rows[0]?.r ?? [];
  const all = itemsOf(notes);
  const seen = new Set(all.length ? (await c.query<{ note: string; route: string; anchor: string }>(
    'select note_id::text note, route, anchor from pulse.release_seen where person_id = $1 and note_id = any($2::bigint[])',
    [v.person, [...new Set(all.map((i) => i.note))]])).rows.map((r) => seenKey(r.note, r.route, r.anchor)) : []);
  const access = await accessOf(c, v);
  const on = (await c.query<{ on: boolean }>('select dots_on "on" from pulse.release_dots_pref where person_id = $1', [v.person])).rows[0]?.on ?? true;
  return { on, all, seen, access };
}
/** The state from its parts; `marked`: what was just recorded as seen (SPEED-5: the state after marking, without reading
 *  every part again; release_seen only ever gains these rows). */
function stateFrom(p: Parts | null, marked: readonly { note: number; route: string; anchor: string }[] = []): State {
  if (!p) return { on: false, count: 0, items: [] };
  const seen = marked.length ? new Set([...p.seen, ...marked.map((r) => seenKey(r.note, r.route, r.anchor))]) : p.seen;
  const items = unseenOf(p.all, seen, p.access);
  return { on: p.on, count: thingCount(items), items };
}
/** This person's unseen changed pages and their switch. */
async function stateOf(c: PoolClient, v: Viewer): Promise<State> { return stateFrom(await partsOf(c, v)); }

/** The rows a visit records: opening a page (`anchor` "") and, with `reached`, the thing itself (its page counts as opened). */
const seenRows = (items: readonly DotItem[], reached: boolean) => items.flatMap((i) => (reached && i.anchor ? [{ ...i, anchor: "" }, i] : [{ ...i, anchor: "" }]));
/** Records what they saw. */
async function markSeen(c: PoolClient, v: Viewer, items: readonly DotItem[], reached = false) {
  const rows = seenRows(items, reached);
  if (!rows.length || !v.person) return;
  await c.query(`insert into pulse.release_seen (org_id, person_id, note_id, route, anchor)
      select pulse.current_org(), $1, x.note, x.route, x.anchor from unnest($2::bigint[], $3::text[], $4::text[]) x(note, route, anchor)
      on conflict do nothing`, [v.person, rows.map((i) => i.note), rows.map((i) => i.route), rows.map((i) => i.anchor)]);
}

export function registerNewDotsRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/whats-new/unseen', (req) => tx(req, (c, v) => stateOf(c, v)));
  app.post<{ Body: { path?: string; anchor?: string; all?: boolean } }>('/api/v0/whats-new/seen', { schema: { body: { type: 'object', additionalProperties: false,
    properties: { path: { type: 'string', maxLength: 400 }, anchor: { type: 'string', pattern: ANCHOR_RE.source }, all: { type: 'boolean' } } } } }, (req) => tx(req, async (c, v) => {
    const parts = await partsOf(c, v), before = stateFrom(parts);
    const path = (req.body?.path ?? '').split(/[?#]/)[0].replace(/\/+$/, '');
    const anchor = req.body?.anchor ?? '';
    // Mark all: everything. A thing reached: that thing. A page opened: its changes (a thing on it is then `opened`,
    // and stays new until it is reached). A page they cannot open is in none of their items, so it clears nothing.
    const all = req.body?.all === true;
    const cleared = all ? before.items : !path ? [] : anchor ? reachedBy(before.items, path, anchor) : clearedBy(before.items, path).filter((i) => !i.opened);
    await markSeen(c, v, cleared, all || !!anchor);
    const after = cleared.length ? stateFrom(parts, seenRows(cleared, all || !!anchor)) : before;
    return { ...after, cleared };
  }));
  app.post<{ Body: { on: boolean } }>('/api/v0/whats-new/dots', { schema: { body: { type: 'object', additionalProperties: false, required: ['on'],
    properties: { on: { type: 'boolean' } } } } }, (req) => tx(req, async (c, v) => {
    if (v.person) await c.query(`insert into pulse.release_dots_pref (org_id, person_id, dots_on) values (pulse.current_org(), $1, $2)
        on conflict (org_id, person_id) do update set dots_on = excluded.dots_on, updated_at = clock_timestamp()`, [v.person, req.body.on]);
    return stateOf(c, v);
  }));
}

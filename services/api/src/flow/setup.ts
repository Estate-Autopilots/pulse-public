/** FLOW-E (owner, 21 Oct 2026): a company set up for its own industry, roles as data, and each person's home from
 *  every process. /v1/flow/packs (the industry packs), /v1/flow/setup (the company's pack, words and roles with their
 *  holders), /v1/flow/roles (any role name, what it sees, who holds it: a person holds any number of roles) and
 *  /v1/flow/home (the tiles of each of my roles and my steps from every process). Leadership and admins choose the
 *  pack, the words and the roles; HR may also name who holds a role. */
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx, type Viewer } from '../routes.js';
import { SCREENS } from '../screens.js';
import { canDesign, mySteps, UUID } from './store.js';
import { PACK, PACKS, packPayload, packSummary, wordsOf, WORD_KEYS, WORD_LABELS, type Tile } from './packs.js';
import type { FlowDef } from './types.js';

type Body = Record<string, unknown>;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = { type: 'object' } as const;
const str = (x: unknown, max = 200) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const id = (x: unknown, what = 'record') => (UUID.test(String(x)) ? String(x) : fail(400, `Choose a valid ${what}`));
const staff = async (c: PoolClient) => { if (!(await c.query('select pulse.flow_staff() ok')).rows[0].ok) fail(403, 'Flow is for the team'); };
const designer = (v: Viewer) => { if (!canDesign(v)) fail(403, 'Leadership and admins set up the company'); };

/** The screens a role can use, in the rail's words (Settings shows them as switches). */
export const SCREEN_LABELS: Record<string, string> = {
  dashboard: 'Dashboard', work: 'Work', chats: 'Chats', clients: 'Clients and projects', acquisition: 'Acquisition', contacts: 'Contacts', map: 'Map', sops: 'Processes',
  network: 'Network', team: 'Team', me: 'My desk', hr: 'HR desk', leadership: 'Leadership', finance: 'Finance', erp: 'Billing', review: 'Review data', audit: 'Audit',
};
// Built on first use: screens.ts imports this module back, so SCREENS is not initialised while this one loads.
let screenKeys: Set<string> | undefined;
const SCREEN_KEYS = () => (screenKeys ??= new Set<string>(SCREENS.map((s) => s.key)));
const TILE_OF = ['mine', 'role', 'runs'] as const;
export const slug = (x: string) => x.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'role';

function cleanTiles(raw: unknown): Tile[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 8).map((x) => (x ?? {}) as Body).map((x, i) => ({
    key: slug(str(x.key, 40) || str(x.label, 40) || `tile_${i + 1}`), label: str(x.label, 60) || 'My steps',
    of: (TILE_OF as readonly string[]).includes(String(x.of)) ? x.of as Tile['of'] : 'mine',
    ...(Array.isArray(x.modules) && x.modules.length ? { modules: x.modules.map((m) => str(m, 40)).filter(Boolean).slice(0, 12) } : {}),
    ...(x.late === true ? { late: true } : {}), ...(str(x.href, 200).startsWith('/') ? { href: str(x.href, 200) } : {}) }));
}
const cleanScreens = (raw: unknown) => (Array.isArray(raw) ? raw.map((x) => str(x, 40)).filter((x) => SCREEN_KEYS().has(x)) : []).slice(0, 40);

/** The company's words, pack and roles with who holds each. */
export async function companySetup(c: PoolClient, v: Viewer) {
  const pack = (await c.query('select pack_key,words,history,updated_at from pulse.org_pack where org_id=pulse.current_org()')).rows[0] as Row | undefined;
  const roles = (await c.query(`select r.id,r.key,r.name,r.note,r.screens,r.home,r.tiles,r.source,
      coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name,'since',h.since) order by p.display_name) from pulse.work_role_holder h join pulse.person p on p.id=h.person_id
        where h.role_id=r.id and p.status='active'),'[]') holders
    from pulse.work_role r where r.archived_at is null order by r.position,r.name`)).rows;
  const people = (await c.query(`select p.id,p.display_name name,pp.role title from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id
    where p.side='staff' and p.status='active' order by p.display_name limit 500`)).rows;
  const p = pack ? PACK.get(pack.pack_key) : undefined;
  return { pack: pack ? { key: pack.pack_key, name: p?.name ?? pack.pack_key, at: pack.updated_at, history: pack.history } : null,
    words: wordsOf(pack?.words), wordLabels: WORD_LABELS, wordKeys: WORD_KEYS,
    roles: roles.map((r) => ({ id: r.id, key: r.key, name: r.name, note: r.note, screens: r.screens, home: r.home, tiles: r.tiles, source: r.source, holders: r.holders })),
    people, screens: SCREENS.filter((s) => !('fixed' in s && s.fixed)).map((s) => ({ key: s.key, label: SCREEN_LABELS[s.key] ?? s.key })),
    canEdit: canDesign(v), canName: canDesign(v) || v.role === 'hr' };
}

/** The work roles a person holds (their keys and names). */
export async function rolesOf(c: PoolClient, person: string | null | undefined) {
  if (!person) return [];
  return (await c.query(`select r.id,r.key,r.name,r.screens,r.home,r.tiles from pulse.work_role_holder h join pulse.work_role r on r.id=h.role_id
    where h.person_id=$1 and r.archived_at is null order by r.position,r.name`, [person])).rows as { id: string; key: string; name: string; screens: string[]; home: string | null; tiles: Tile[] }[];
}

/** My home: each of my roles with its tiles counted, and my steps from every process. */
export async function homeFor(c: PoolClient, v: Viewer) {
  const mine = await rolesOf(c, v.person);
  const t = (await c.query('select pulse.flow_today()::text d')).rows[0].d as string;
  const open = (await c.query(`select s.id,s.title,s.module,s.state,s.due_on::text due,s.person_id,s.step_key,r.id run_id,r.name run,
      (select x->'who'->>'role' from jsonb_array_elements(r.definition->'steps') x where x->>'id'=s.step_key) role_key,r.definition->'roles' roles
    from pulse.flow_run_step s join pulse.flow_run r on r.id=s.run_id
    where r.status='running' and r.mode='live' and s.state in ('open','in_progress','in_review','confirmed') order by s.due_on nulls last,s.position limit 2000`)).rows;
  const running = (await c.query(`select count(*)::int n from pulse.flow_run where status='running' and mode='live'`)).rows[0].n as number;
  const roleOf = (s: Row) => { const k = s.role_key as string | null; const label = ((s.roles ?? []) as { key: string; label: string }[]).find((r) => r.key === k)?.label ?? null; return { k, label }; };
  const item = (s: Row) => ({ id: s.id, title: s.title, run: s.run, due: s.due, late: !!s.due && s.due < t, href: `/steps/${s.id}` });
  const isRole = (s: Row, r: { key: string; name: string }) => { const x = roleOf(s); return x.k === r.key || (!!x.label && x.label.toLowerCase() === r.name.toLowerCase()); };
  // A step of mine counts under the role it came as; one that came as none of my roles counts under my first role.
  const asRole = (s: Row, r: (typeof mine)[number]) => isRole(s, r) || (r === mine[0] && !mine.some((m) => isRole(s, m)));
  const tiles = (r: (typeof mine)[number]) => (r.tiles ?? []).map((tile) => {
    if (tile.of === 'runs') return { ...tile, count: running, items: [], href: tile.href ?? '/runs' };
    const list = open.filter((s) => (tile.of === 'mine' ? s.person_id === v.person && asRole(s, r) : isRole(s, r))
      && (!tile.modules?.length || tile.modules.includes(s.module)) && (!tile.late || (!!s.due && s.due < t)));
    return { ...tile, count: list.length, items: list.slice(0, 3).map(item), href: tile.href ?? (tile.of === 'mine' ? '/me/steps' : '/runs') };
  });
  // My steps from every process, each with the role it came to me as (a person can hold several).
  const steps = await mySteps(c, v);
  return { roles: mine.map((r) => ({ key: r.key, name: r.name, tiles: tiles(r) })), steps: steps.steps, upcoming: steps.upcoming.length, asked: steps.asked.length };
}

/** For /me: the screens the viewer's work roles use (they show on the rail even when the access role hides them),
 *  and the home a role picks. */
export async function roleScreens(c: PoolClient, person: string | null | undefined) {
  const r = await rolesOf(c, person);
  return { screens: [...new Set(r.flatMap((x) => x.screens ?? []))], home: r.find((x) => x.home)?.home ?? null, roles: r.map((x) => x.name) };
}

export function registerFlowSetupRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/v1/flow/packs', (req) => tx(req, async (c) => { await staff(c); return { packs: PACKS.map(packSummary) }; }));
  app.get('/v1/flow/setup', (req) => tx(req, async (c, v) => { await staff(c); return companySetup(c, v); }));
  // Apply a pack: words, roles, record types, company blocks and its starter processes (as drafts) join the company's.
  app.post<{ Body: Body }>('/v1/flow/setup/pack', { schema: { body } }, (req) => tx(req, async (c, v) => {
    designer(v); const p = PACK.get(str(req.body.pack, 40)) ?? fail(400, 'Choose an industry pack');
    const added = (await c.query('select pulse.org_pack_apply($1,$2) r', [JSON.stringify(packPayload(p)), req.body.replaceWords === true])).rows[0].r;
    return { added, setup: await companySetup(c, v) };
  }));
  app.post<{ Body: Body }>('/v1/flow/setup/words', { schema: { body } }, (req) => tx(req, async (c, v) => {
    designer(v); const raw = (req.body.words && typeof req.body.words === 'object' ? req.body.words : {}) as Body;
    const cur = (await c.query('select pack_key,words from pulse.org_pack where org_id=pulse.current_org() for update')).rows[0];
    const next = wordsOf({ ...wordsOf(cur?.words), ...Object.fromEntries(WORD_KEYS.filter((k) => typeof raw[k] === 'string').map((k) => [k, str(raw[k], 40)])) });
    await c.query(`insert into pulse.org_pack(org_id,pack_key,words,updated_by) values(pulse.current_org(),'neutral',$1,$2)
      on conflict(org_id) do update set words=excluded.words,updated_by=excluded.updated_by,updated_at=now()`, [JSON.stringify(next), v.person]);
    return companySetup(c, v);
  }));
  // A role: any name; what it sees (the screens it uses, its home and tiles). The same key again changes it.
  app.post<{ Body: Body }>('/v1/flow/roles', { schema: { body } }, (req) => tx(req, async (c, v) => {
    designer(v); const b = req.body; const name = str(b.name, 80) || fail(400, 'Name the role');
    const key = slug(str(b.key, 40) || name);
    const n = (await c.query('select coalesce(max(position),0)+10 n from pulse.work_role where archived_at is null')).rows[0].n;
    await c.query(`insert into pulse.work_role(org_id,key,name,note,screens,home,tiles,position,created_by,updated_by) values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$8)
      on conflict(org_id,key) where archived_at is null do update set name=excluded.name,note=excluded.note,screens=excluded.screens,home=excluded.home,tiles=excluded.tiles,updated_by=excluded.updated_by,updated_at=now()`,
    [key, name, str(b.note, 300) || null, b.screens === undefined ? ['work', 'sops'] : cleanScreens(b.screens), b.home === 'sales' || b.home === 'dashboard' ? b.home : null,
      JSON.stringify(b.tiles === undefined ? [{ key: 'mine', label: 'My steps', of: 'mine', href: '/me/steps' }] : cleanTiles(b.tiles)), n, v.person]);
    return companySetup(c, v);
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/roles/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    designer(v); const rid = id(req.params.id, 'role'); const b = req.body;
    if (!(await c.query('select 1 from pulse.work_role where id=$1 and archived_at is null', [rid])).rowCount) fail(404, 'Role not found');
    if (b.archive === true) { await c.query('update pulse.work_role set archived_at=now(),updated_by=$2,updated_at=now() where id=$1', [rid, v.person]); return companySetup(c, v); }
    await c.query(`update pulse.work_role set name=coalesce(nullif($2,''),name),note=case when $3::boolean then nullif($4,'') else note end,screens=coalesce($5,screens),
      home=case when $6::boolean then $7 else home end,tiles=coalesce($8::jsonb,tiles),updated_by=$9,updated_at=now() where id=$1`,
    [rid, str(b.name, 80), b.note !== undefined, str(b.note, 300), b.screens === undefined ? null : cleanScreens(b.screens), b.home !== undefined,
      b.home === 'sales' || b.home === 'dashboard' ? b.home : null, b.tiles === undefined ? null : JSON.stringify(cleanTiles(b.tiles)), v.person]);
    return companySetup(c, v);
  }));
  // Who holds a role (a person holds any number of roles).
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/roles/:id/holders', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!canDesign(v) && v.role !== 'hr') fail(403, 'Leadership, admins and HR name who holds a role');
    const rid = id(req.params.id, 'role'); const pid = id(req.body.personId, 'person');
    if (!(await c.query('select 1 from pulse.work_role where id=$1 and archived_at is null', [rid])).rowCount) fail(404, 'Role not found');
    if (req.body.remove === true) await c.query('delete from pulse.work_role_holder where role_id=$1 and person_id=$2', [rid, pid]);
    else {
      if (!(await c.query(`select 1 from pulse.person where id=$1 and side='staff' and status='active'`, [pid])).rowCount) fail(400, 'Choose someone in the team');
      await c.query('insert into pulse.work_role_holder(org_id,role_id,person_id,created_by) values(pulse.current_org(),$1,$2,$3) on conflict do nothing', [rid, pid, v.person]);
    }
    return companySetup(c, v);
  }));
  app.get('/v1/flow/home', (req) => tx(req, async (c, v) => { await staff(c); return homeFor(c, v); }));
}

/** The words a process's runs use: its own, else the company's. */
export const runWords = (def: Pick<FlowDef, 'terms'>, w: { run: string; runs: string }) => ({ run: def.terms?.run || w.run, runs: def.terms?.runs || w.runs });

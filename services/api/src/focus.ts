// FOCUS (owner, 7 Nov 2026; Focus OS Phase 1): the owner's private capacity board and the allocator's daily plan
// (module `focus`, his own workspace only), and the funding list (module `funding`, the Vitals organisation). Both are
// organisation-only modules (modules.ts ORG_ONLY). Row security (migration 1845) keeps the board to organisation admins
// and the funding list to leaders; these routes say the same in words first.
// Collectors post numbers (never credentials) to /api/v0/focus-ingest with an ingest key made here; only its sha256 is
// kept. The ingest route sits outside the module's prefix because the key, not the address, picks the organisation.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { admin, fail, leadership, type Tx, type Viewer } from './routes.js';
import { burn, plan, type Account, type Company, type Lane, type Settings } from './focus-plan.js';
import { ORG_TZ, orgZone } from './org-time.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 30 } as const;
const KEY = /^[a-z0-9-]{2,40}$/;
const LANE = /^[A-Za-z0-9._-]{2,60}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const str = (x: unknown, max: number) => String(x ?? '').trim().slice(0, max);
const has = (b: Body, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const int = (x: unknown, lo: number, hi: number, what: string) => { const n = Math.round(Number(x)); return Number.isFinite(n) && n >= lo && n <= hi ? n : fail(400, what); };
const pick = <T extends string>(x: unknown, list: readonly T[], what: string): T => (list as readonly string[]).includes(String(x)) ? String(x) as T : fail(400, what);
const day = (x: unknown) => x === null || x === '' ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(x)) ? String(x) : fail(400, 'Choose a date');
const when = (x: unknown) => { if (x === null || x === '' || x === undefined) return null; const t = Date.parse(String(x)); return Number.isFinite(t) ? new Date(t).toISOString() : fail(400, 'Choose a time'); };
const keys = (x: unknown) => Array.isArray(x) ? [...new Set(x.map(String).filter((k) => KEY.test(k)))].slice(0, 20) : fail(400, 'Choose companies');
const owner = (v: Viewer) => { if (!admin(v) || !v.person) fail(403, 'Only the owner of this workspace sees this.'); };
const lead = (v: Viewer) => { if (!leadership(v) || !v.person) fail(403, 'Only leaders see the funding list.'); };
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const STATUSES = ['blocked', 'ready', 'drafting', 'applied', 'approved', 'rejected', 'active', 'not_fit'] as const;

async function inputs(c: PoolClient) {
  const [settings, companies, accounts, lanes] = await Promise.all([
    c.query(`select reserve_5h "reserve5h", reserve_7d "reserve7d", auto_weights "autoWeights", pulse.focus_key_made() is not null "hasKey", ingest_at "ingestAt" from pulse.focus_settings`),
    c.query('select key, name, weight, hue, sort from pulse.focus_company order by sort, name'),
    c.query(`select a.key, a.name, a.kind, a.provider, a.own_company "ownCompany", a.companies, a.urgent_only "urgentOnly", a.tiers, a.cost, a.source,
        a.status, a.warm_lanes "warmLanes", a.note, a.sort,
        (select jsonb_object_agg(w.win, jsonb_build_object('usedPct', w.used_pct, 'resetsAt', w.resets_at, 'amount', w.amount, 'currency', w.currency, 'at', w.at, 'source', w.source))
           from (select distinct on (win) win, used_pct::float8, resets_at, amount::float8, currency, at, source from pulse.focus_sample
                 where account_id = a.id and win in ('5h', '7d', 'balance') order by win, at desc) w) latest
      from pulse.focus_account a order by a.sort, a.name`),
    c.query(`select key, title, company, value, size, need, to_char(due_on, 'YYYY-MM-DD') "dueOn", urgent, blocked_by "blockedBy", status, account, unblocks, updated_at "updatedAt"
      from pulse.focus_lane where status <> 'done' or updated_at > now() - interval '7 days' order by status, updated_at desc`),
  ]);
  const s = settings.rows[0] ?? { reserve5h: 20, reserve7d: 15, autoWeights: true, hasKey: false, ingestAt: null };
  return { settings: s, companies: companies.rows as Company[], accounts: accounts.rows as Account[], lanes: lanes.rows as Lane[] };
}

async function board(c: PoolClient) {
  const x = await inputs(c);
  const samples = (await c.query(`select a.key account, s.at, s.win, s.used_pct::float8 "usedPct", s.company from pulse.focus_sample s
      join pulse.focus_account a on a.id = s.account_id where s.at > now() - interval '7 days' and s.win = '5h' order by s.at`)).rows;
  const saved = (await c.query(`select day, made_at "madeAt", sent_at "sentAt" from pulse.focus_plan where day = (now() at time zone ${ORG_TZ})::date`)).rows[0] ?? null;
  const zone = await orgZone(c);
  return { ...x, plan: plan({ ...x, settings: x.settings as Settings, zone }), burn: burn(samples, x.accounts), sent: saved, now: new Date().toISOString(), zone };
}

const budget = new Map<string, number[]>();
const tooMany = (k: string, limit: number) => {
  const now = Date.now(); if (budget.size > 5000) budget.clear();
  const list = (budget.get(k) ?? []).filter((t) => now - t < 60_000); list.push(now); budget.set(k, list);
  return list.length > limit;
};

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** SETTINGS-APPLE (T1.4.2): the Focus company a Pulse company is, by its handle, its name or its initials ("Estate
 *  Autopilots" is ea, "Willow Lane" wl, "Atlas Crest" ac, "Vitals Technologies" Vitals). Null when none fits. */
export function focusCompanyOf(companies: readonly { key: string; name: string }[], here: { name: string; handle: string | null }) {
  const n = plain(here.name), initials = n.split(' ').map((w) => w[0]).join('');
  const fits = (c: { key: string; name: string }) => { const m = plain(c.name.split(' /')[0]); return c.key === here.handle || m === n || n.startsWith(`${m} `) || m.startsWith(`${n} `); };
  return companies.find(fits)?.key ?? (n.includes(' ') ? companies.find((c) => c.key === initials)?.key : undefined) ?? null;
}

export function registerFocusRoutes(app: FastifyInstance, { tx, pool }: { tx: Tx; pool: Pool }) {
  // SETTINGS-APPLE (owner, 13 Nov 2026, T1.4.2: "Focus just redirected me to my Savuzo HQ ... if it is available here as
  // well, why not open it for Estate Autopilots itself?"): every Focus route twice. /api/v0/focus/* reads and writes the
  // Focus of the company the person is in (where the module is on); /api/v0/account/focus/* the same Focus from any other
  // company the person works in: pulse.focus_enter_home() (2043) moves this transaction to the account's Focus company,
  // as that company's admin seat, only where account_module_home('focus') finds one. The page there shows the company's
  // own part by default, and every company under a labelled switch, without changing company.
  const homes = new WeakMap<object, { name: string; handle: string | null }>();
  const homeTx: Tx = (req, run) => tx(req, async (c, v) => {
    const here = (await c.query('select o.name, o.handle from pulse.org o where o.id = pulse.current_org()')).rows[0] ?? { name: '', handle: null };
    const home = ((await c.query('select pulse.focus_enter_home() h')).rows[0]?.h as { id: string; name: string; seat: string } | null) ?? fail(404, 'Focus is not set up for you yet.');
    homes.set(req, here);
    return run(c, { ...v, org: home.id, person: home.seat, role: 'admin' });
  });
  const focusRoutes = (P: string, t: Tx) => {
    app.get(`${P}`, (req) => t(req, async (c, v) => {
      owner(v); const b = await board(c); const here = homes.get(req);
      // From another company: which of Focus's companies this one is (null: not in Focus yet), so the page opens on it.
      return here ? { ...b, here: { name: here.name, key: focusCompanyOf(b.companies, here) } } : b;
    }));

    app.post<{ Params: { key: string }; Body: Body }>(`${P}/companies/:key`, { schema: { body } }, (req) => t(req, async (c, v) => {
      owner(v); const b = req.body;
      const r = await c.query(`update pulse.focus_company set weight = coalesce($2, weight), name = coalesce($3, name) where key = $1 returning key`,
        [req.params.key, has(b, 'weight') ? int(b.weight, 0, 100, 'A weight is 0 to 100') : null, has(b, 'name') ? str(b.name, 80) || fail(400, 'Name the company') : null]);
      if (!r.rowCount) fail(404, 'Company not found'); return { ok: true };
    }));

    app.post<{ Body: Body }>(`${P}/settings`, { schema: { body } }, (req) => t(req, async (c, v) => {
      owner(v); const b = req.body;
      await c.query(`insert into pulse.focus_settings(org_id) values (pulse.current_org()) on conflict do nothing`);
      await c.query(`update pulse.focus_settings set reserve_5h = coalesce($1, reserve_5h), reserve_7d = coalesce($2, reserve_7d), auto_weights = coalesce($3, auto_weights)`,
        [has(b, 'reserve5h') ? int(b.reserve5h, 0, 90, 'Keep 0 to 90%') : null, has(b, 'reserve7d') ? int(b.reserve7d, 0, 90, 'Keep 0 to 90%') : null,
          has(b, 'autoWeights') ? b.autoWeights === true : null]);
      return { ok: true };
    }));

    // An account's switches, and a reading typed by hand (for the accounts no collector can read).
    app.post<{ Params: { key: string }; Body: Body }>(`${P}/accounts/:key`, { schema: { body } }, (req) => t(req, async (c, v) => {
      owner(v); const b = req.body;
      const r = await c.query(`update pulse.focus_account set status = coalesce($2, status), companies = coalesce($3, companies), note = coalesce($4, note) where key = $1 returning id`,
        [req.params.key, has(b, 'status') ? pick(b.status, ['ok', 'limited', 'off'] as const, 'Choose a status') : null,
          has(b, 'companies') ? keys(b.companies) : null, has(b, 'note') ? str(b.note, 300) : null]);
      if (!r.rowCount) fail(404, 'Account not found'); return { ok: true };
    }));
    app.post<{ Params: { key: string }; Body: Body }>(`${P}/accounts/:key/reading`, { schema: { body } }, (req) => t(req, async (c, v) => {
      owner(v); const b = req.body;
      const acct = (await c.query('select id from pulse.focus_account where key = $1', [req.params.key])).rows[0] ?? fail(404, 'Account not found');
      let n = 0;
      for (const win of ['5h', '7d'] as const) {
        const k = win === '5h' ? 'used5h' : 'used7d';
        if (!has(b, k) || b[k] === '' || b[k] === null) continue;
        await c.query(`insert into pulse.focus_sample(org_id, account_id, win, used_pct, resets_at, source) values (pulse.current_org(), $1, $2, $3, $4, 'manual')`,
          [acct.id, win, int(b[k], 0, 100, 'Use 0 to 100%'), when(b[win === '5h' ? 'resets5h' : 'resets7d'])]); n++;
      }
      if (has(b, 'balance') && b.balance !== '' && b.balance !== null) {
        const amt = Number(b.balance); if (!Number.isFinite(amt) || amt < 0 || amt > 1e9) fail(400, 'Type the money left');
        await c.query(`insert into pulse.focus_sample(org_id, account_id, win, amount, currency, source) values (pulse.current_org(), $1, 'balance', $2, $3, 'manual')`,
          [acct.id, amt, /^[A-Z]{3}$/.test(String(b.currency)) ? String(b.currency) : 'USD']); n++;
      }
      if (!n) fail(400, 'Type at least one number'); return { ok: true };
    }));

    app.post<{ Body: Body }>(`${P}/lanes`, { schema: { body } }, (req) => t(req, async (c, v) => {
      owner(v); const b = req.body;
      const title = str(b.title, 160) || fail(400, 'Name the work');
      const key = LANE.test(String(b.key ?? '')) ? String(b.key) : `w-${Date.now().toString(36)}`;
      const company = str(b.company, 32);
      if (!(await c.query('select 1 from pulse.focus_company where key = $1', [company])).rowCount) fail(400, 'Choose a company');
      await c.query(`insert into pulse.focus_lane(org_id, key, title, company, value, size, need, due_on, urgent, blocked_by)
        values (pulse.current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [key, title, company, has(b, 'value') ? int(b.value, 1, 10, 'Value is 1 to 10') : 5, has(b, 'size') ? pick(b.size, ['S', 'M', 'L', 'XL'] as const, 'Choose a size') : 'M',
          has(b, 'need') ? pick(b.need, ['T0', 'T1', 'T2', 'T3'] as const, 'Choose how hard it is') : 'T2', day(b.dueOn ?? null), b.urgent === true, str(b.blockedBy, 160) || null]);
      return { key };
    }));
    app.post<{ Params: { key: string }; Body: Body }>(`${P}/lanes/:key`, { schema: { body } }, (req) => t(req, async (c, v) => {
      owner(v); const b = req.body; const cols: [string, unknown][] = [];
      if (has(b, 'title')) cols.push(['title', str(b.title, 160) || fail(400, 'Name the work')]);
      if (has(b, 'value')) cols.push(['value', int(b.value, 1, 10, 'Value is 1 to 10')]);
      if (has(b, 'size')) cols.push(['size', pick(b.size, ['S', 'M', 'L', 'XL'] as const, 'Choose a size')]);
      if (has(b, 'need')) cols.push(['need', pick(b.need, ['T0', 'T1', 'T2', 'T3'] as const, 'Choose how hard it is')]);
      if (has(b, 'dueOn')) cols.push(['due_on', day(b.dueOn)]);
      if (has(b, 'urgent')) cols.push(['urgent', b.urgent === true]);
      if (has(b, 'blockedBy')) cols.push(['blocked_by', str(b.blockedBy, 160) || null]);
      if (has(b, 'status')) cols.push(['status', pick(b.status, ['ready', 'running', 'done', 'parked'] as const, 'Choose a status')]);
      if (!cols.length) fail(400, 'Choose what to change');
      const r = await c.query(`update pulse.focus_lane set ${cols.map(([col], i) => `${col} = $${i + 2}`).join(', ')}, updated_at = now() where key = $1 returning key`,
        [req.params.key, ...cols.map(([, x]) => x)]);
      if (!r.rowCount) fail(404, 'Work not found'); return { ok: true };
    }));

    // Today's plan, saved now (the bot then tells a linked Telegram chat it is ready). Saving again replaces it.
    app.post(`${P}/plan`, (req) => t(req, async (c, v) => {
      owner(v); const b = await board(c);
      await c.query(`insert into pulse.focus_plan(org_id, day, body) values (pulse.current_org(), $1, $2)
        on conflict (org_id, day) do update set body = excluded.body, made_at = now(), sent_at = null`, [b.plan.day, JSON.stringify(b.plan)]);
      return { ok: true, day: b.plan.day };
    }));

    // A new collector key, shown once. The old one stops working.
    app.post(`${P}/ingest-key`, (req) => t(req, async (c, v) => {
      owner(v); const key = `fk_${randomBytes(30).toString('base64url')}`;
      await c.query('select pulse.focus_key_set($1)', [sha256(key)]);
      return { key };
    }));
  };
  focusRoutes('/api/v0/focus', tx);
  focusRoutes('/api/v0/account/focus', homeTx);

  // UX-GAMIFY: where an organisation-only module is on for this account (an organisation where the person is an admin),
  // so its page typed in another organisation opens there instead of a dead page. Null when there is none.
  app.get<{ Params: { module: string } }>('/api/v0/account/module-home/:module', (req) => tx(req, async (c) => {
    const key = pick(req.params.module, ['focus', 'funding', 'pulse_hq'] as const, 'Unknown module');
    const r = (await c.query('select pulse.account_module_home($1) home', [key])).rows[0]?.home as { id: string; name: string } | null;
    return { org: r ?? null };
  }));


  // Collectors: Authorization: Bearer fk_…; numbers only. Publishes the day's plan once after 08:30 India time.
  app.post<{ Body: Body }>('/api/v0/focus-ingest', { schema: { body: { type: 'object', maxProperties: 4 } }, bodyLimit: 256 * 1024 }, async (req, reply) => {
    const m = /^Bearer (fk_[A-Za-z0-9_-]{40})$/.exec(String(req.headers.authorization ?? ''));
    const ip = String(req.headers['x-pulse-client-ip'] ?? req.ip ?? '').slice(0, 80);
    if (tooMany(`ip:${ip}`, 60)) return reply.code(429).send({ error: 'Too many calls. Try again in a minute.' });
    if (!m) return reply.code(401).send({ error: 'Send the collector key as Authorization: Bearer fk_…' });
    const hash = sha256(m[1]);
    if (tooMany(hash, 30)) return reply.code(429).send({ error: 'Too many calls. Try again in a minute.' });
    const c = await pool.connect();
    try {
      await c.query('begin');
      const r = (await c.query('select pulse.focus_ingest($1, $2) r', [hash, JSON.stringify(req.body ?? {})])).rows[0].r as { samples: number; lanes: number; planDue: boolean };
      let planned = false;
      if (r.planDue) {
        const x = (await c.query('select pulse.focus_inputs($1) x', [hash])).rows[0].x;
        // focus_inputs set the key's company for this transaction, so orgZone reads its zone
        const p = plan({ companies: x.companies, accounts: x.accounts, lanes: x.lanes, settings: x.settings ?? { reserve5h: 20, reserve7d: 15, autoWeights: true }, zone: await orgZone(c) });
        planned = (await c.query('select pulse.focus_plan_publish($1, $2) ok', [hash, JSON.stringify(p)])).rows[0].ok;
      }
      await c.query('commit');
      return { samples: r.samples, lanes: r.lanes, planned };
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      if ((e as { code?: string }).code === '28000') return reply.code(401).send({ error: 'Pulse does not know this collector key.' });
      if (['22P02', '22007', '23514', '23502', '22008'].includes(String((e as { code?: string }).code))) return reply.code(400).send({ error: 'A reading was not valid.' });
      throw e;
    } finally { c.release(); }
  });

  // Funding (leaders): startup programmes and credits.
  app.get('/api/v0/funding', (req) => tx(req, async (c, v) => {
    lead(v);
    const programs = (await c.query(`select f.id, f.name, f.kind, f.amount, f.eligibility, f.docs, f.deadline, f.status, f.blocked_by "blockedBy", f.project_id "projectId",
        p.name "projectName", f.url, f.note, f.updated_at "updatedAt" from pulse.funding_program f left join pulse.project p on p.id = f.project_id order by f.sort, f.name`)).rows;
    return { programs, canEdit: true };
  }));
  app.post<{ Body: Body }>('/api/v0/funding', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const b = req.body;
    const r = await c.query(`insert into pulse.funding_program(org_id, name, amount, deadline, status, sort)
      values (pulse.current_org(), $1, $2, $3, 'ready', coalesce((select max(sort) + 1 from pulse.funding_program), 0)) returning id`,
      [str(b.name, 120) || fail(400, 'Name the programme'), str(b.amount, 80), str(b.deadline, 80)]);
    return { id: r.rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/funding/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const b = req.body; const cols: [string, unknown][] = [];
    if (!UUID.test(req.params.id)) fail(404, 'Programme not found');
    for (const [k, col, max] of [['name', 'name', 120], ['amount', 'amount', 80], ['eligibility', 'eligibility', 400], ['docs', 'docs', 400], ['deadline', 'deadline', 80], ['note', 'note', 600]] as const)
      if (has(b, k)) cols.push([col, str(b[k], max)]);
    if (has(b, 'status')) cols.push(['status', pick(b.status, STATUSES, 'Choose a status')]);
    if (has(b, 'blockedBy')) cols.push(['blocked_by', str(b.blockedBy, 120) || null]);
    if (!cols.length) fail(400, 'Choose what to change');
    const r = await c.query(`update pulse.funding_program set ${cols.map(([col], i) => `${col} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning id`,
      [req.params.id, ...cols.map(([, x]) => x)]);
    if (!r.rowCount) fail(404, 'Programme not found'); return { ok: true };
  }));
}

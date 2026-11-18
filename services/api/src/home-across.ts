// CONNECTIONS part A (owner, 16 Nov 2026: the home "looks very ugly, has no purpose"; it said "9 companies" and he is
// not in nine): the companies a person is IN (a seat) and the companies and people they WORK WITH (a connection), for
// the cross-company home, the switcher's words and the counts everywhere.
//
// Like My day and All my companies (my-day.ts, founder.ts), every seat of the signed-in account is read in its own READ
// ONLY transaction, inside that organisation and as the account's person there; no query reads two organisations. A
// test or demo company (pulse.org.purpose, 2199) is listed apart and never counted. A seat that fails to read is
// reported as unavailable, never filled from another.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { fail, type Tx, type Viewer } from './routes.js';
import { inSeat, markOf, MAX_SEATS, realSeat, seatsOf } from './my-day.js';

type Json = Record<string, unknown>;
export type CompanyIn = { org: string; name: string; handle: string | null; current: boolean; seat: string; personal: boolean;
  purpose: 'work' | 'test' | 'demo'; mark: string | null; accent: string | null; people: number | null };
export type WorkWith = { key: string; name: string; org: string | null; handle: string | null; individual: boolean;
  kind: 'client' | 'vendor' | 'partner' | string; role: string | null; weServe: boolean; since: string | null; via: { org: string; name: string; personal?: boolean } };

/** One connection of a company, in the home's words (connect_list's row, read inside that company). */
export function workWithOf(row: Json, via: { org: string; name: string; personal?: boolean }): WorkWith | null {
  const other = (row.other ?? {}) as Json;
  const name = String(other.name ?? '').trim();
  if (!name) return null;
  return { key: `${via.org}:${String(row.id)}`, name, org: other.org ? String(other.org) : null, handle: other.handle ? String(other.handle) : null,
    individual: other.individual === true, kind: String(row.kind ?? 'client'), role: row.role ? String(row.role) : null, weServe: row.weServe === true,
    since: row.since ? String(row.since) : null, via };
}

/** The same other company reached from two of my companies is one line ("client of Vitals, vendor of EA"): kept
 *  apart per company here, so each line says which company the relationship lives in; the page groups them. Companies
 *  I am in myself are not "companies I work with". */
export function workWithList(rows: readonly WorkWith[], mine: ReadonlySet<string>): WorkWith[] {
  const seen = new Set<string>();
  return rows.filter((w) => !(w.org && mine.has(w.org)) && !seen.has(w.key) && (seen.add(w.key), true))
    .sort((a, b) => a.name.localeCompare(b.name) || a.via.name.localeCompare(b.via.name));
}

const who = (v: Viewer) => { if (!v.person) fail(403, 'Sign in with your own account to see your companies'); return v; };

export function registerHomeAcrossRoutes(app: FastifyInstance, { tx, pool }: { tx: Tx; pool: Pool }) {
  app.get('/api/v0/home/companies', async (req) => {
    const { seats, actor } = await tx(req, async (c, v) => { who(v); return { seats: await seatsOf(c), actor: v.email }; });
    const companies: CompanyIn[] = [];
    const rows: WorkWith[] = [];
    const unavailable: string[] = [];
    for (const s of seats.slice(0, MAX_SEATS)) {
      try {
        const r = await inSeat(pool, s, actor, false, async (c) => {
          const kind = (await c.query('select pulse.org_kind() k')).rows[0]?.k as string;
          const accent = ((await c.query('select accent from pulse.org_brand where org_id=pulse.current_org()')).rows[0]?.accent ?? null) as string | null;
          // Team size: active staff people (AI employees apart), as All my companies counts them.
          const people = s.kind === 'staff' ? Number((await c.query(`select count(*)::int n from pulse.person p where p.status='active' and p.side='staff'
            and not exists (select 1 from pulse.agent_member m where m.person_id=p.id)`)).rows[0]?.n ?? 0) : null;
          const links = s.kind === 'staff' && (realSeat(s) || s.personal) ? ((await c.query('select pulse.connect_list() l')).rows[0]?.l ?? []) as Json[] : [];
          return { kind, accent, people, links, mark: await markOf(c, s.org) };
        });
        companies.push({ org: s.org, name: s.name, handle: s.handle, current: s.current, seat: s.kind, personal: s.personal || r.kind === 'personal', purpose: s.purpose,
          mark: r.mark, accent: r.accent, people: r.people });
        for (const l of r.links) { const w = workWithOf(l, { org: s.org, name: s.name, personal: s.personal || r.kind === 'personal' }); if (w) rows.push(w); }
      } catch (e) {
        req.log.warn({ err: e, org: s.org }, 'home companies seat unavailable');
        unavailable.push(s.name);
      }
    }
    const mine = new Set(companies.map((c) => c.org));
    return { generatedAt: new Date().toISOString(),
      companies: companies.filter((c) => !c.personal && c.purpose === 'work'),
      personal: companies.find((c) => c.personal) ?? null,
      practice: companies.filter((c) => !c.personal && c.purpose !== 'work').map((c) => ({ org: c.org, name: c.name, purpose: c.purpose, mark: c.mark, current: c.current })),
      workWith: workWithList(rows, mine), unavailable, more: Math.max(0, seats.length - MAX_SEATS) };
  });
}

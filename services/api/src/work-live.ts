// WORK-SPINE round 2 (owner, 10 Nov 2026: "Goals, projects, tasks … must update live. When the DB changes, open screens
// update within ~1-2 s with no reload"; "through the existing realtime channel … or a light change-feed with targeted
// refetch"). Migration 2070 makes every change to a task (and its checklist, people and late reasons), a project or a goal
// NOTIFY pulse_work "<org>:<t|p|g>:<project or goal>:<person>:<task>"; one LISTEN connection per API process keeps the
// last minute of notes. An open Work page asks GET /api/v0/work/changed?scope=…&id=…&since=<the last answer's time>
// every second or two while it is on screen, and refetches when the answer is changed: true. The answer is a yes or no,
// never an id; the page reads the work again through the usual rules.
// A light poll, not a held stream: a browser opens at most 6 connections to a host over HTTP/1.1, and every Pulse tab
// already holds the screen's and calls' streams, so a third stream per tab hung the next page once two Work tabs were
// open (the walk's step 6, 14 Nov 2026).
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { fail, type Tx } from './routes.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What a note says: a task (or a part of one), a project or a goal; its project or goal; the person; the task. */
export type WorkNote = { kind: 't' | 'p' | 'g'; ref: string; who: string; task: string };
/** The pages that listen: one project, one goal, one task, the person's own work, and the two lists. */
export type WorkScope = { scope: 'project' | 'goal' | 'task' | 'me' | 'projects' | 'goals'; id: string | null };
const SCOPES = new Set(['project', 'goal', 'task', 'me', 'projects', 'goals']);

export function parseNote(payload: string): { org: string; note: WorkNote } | null {
  const [org, kind, ref = '', who = '', task = ''] = payload.split(':');
  if (!org || !UUID.test(org) || (kind !== 't' && kind !== 'p' && kind !== 'g')) return null;
  return { org, note: { kind, ref, who, task } };
}

/** Whether a note touches a page. `projects` is the goal's projects (a goal page counts the tasks of the projects it holds).
 *  An empty project or person is a task with none (or, rarely, one whose writer could not read it): it is on no project,
 *  goal or person's page, so only the two company-wide lists look again (14 Nov: "any" made every open project page
 *  refresh whenever a task with no project changed anywhere in the company). */
export function touches(s: WorkScope, n: WorkNote, me: string, projects: ReadonlySet<string> = new Set()): boolean {
  switch (s.scope) {
    case 'project': return n.kind !== 'g' && n.ref === s.id;
    case 'goal': return n.kind === 'g' ? n.ref === s.id : projects.has(n.ref);
    case 'task': return n.kind === 't' && n.task === s.id;
    case 'me': return n.kind === 't' && n.who === me;
    case 'projects': return n.kind !== 'g';
    case 'goals': return true;
  }
}

/** One LISTEN connection per API process for pulse_work, started by the first question. It keeps the last minute of
 *  notes (at most 5,000); a question about a time it cannot vouch for (before it was listening, or older than what it
 *  kept) is answered "changed", so a page never misses a change, at worst it reads itself once more. */
class WorkHub {
  private client: PoolClient | null = null; private starting = false; private closed = false;
  private recent: { at: number; org: string; note: WorkNote }[] = [];
  /** From when the notes kept are complete (Infinity while not listening). */
  private from = Infinity;
  constructor(private pool?: Pool) {}
  close() { this.closed = true; this.from = Infinity; const c = this.client; this.client = null; if (c) { try { c.release(true); } catch { /* gone */ } } }
  listen() {
    if (!this.pool || this.client || this.starting || this.closed) return; this.starting = true;
    void (async () => {
      try {
        const c = await this.pool!.connect();
        c.on('notification', (m) => {
          const x = parseNote(String(m.payload ?? '')); if (!x) return;
          const now = Date.now(); this.recent.push({ at: now, ...x });
          let cut = 0; while (cut < this.recent.length && this.recent[cut].at < now - 60000) cut++;
          if (this.recent.length - cut > 5000) cut = this.recent.length - 5000;
          if (cut) { this.from = Math.max(this.from, this.recent[cut - 1].at); this.recent.splice(0, cut); }
        });
        c.on('error', () => this.drop(c));
        await c.query('listen pulse_work');
        if (this.closed) { c.release(true); return; }
        this.client = c; this.from = Date.now(); this.recent = [];
      } catch { if (!this.closed) setTimeout(() => this.listen(), 5000).unref(); } finally { this.starting = false; }
    })();
  }
  private drop(c: PoolClient) { if (this.client !== c) return; this.client = null; this.from = Infinity; try { c.release(true); } catch { /* gone */ } if (!this.closed) setTimeout(() => this.listen(), 2000).unref(); }
  /** Whether anything after `at` touches the page; null when the hub cannot vouch for that time. */
  changedSince(org: string, at: number, hit: (n: WorkNote) => boolean): boolean | null {
    if (at < this.from) return null;
    return this.recent.some((r) => r.at > at && r.org === org && hit(r.note));
  }
}

export function registerWorkLiveRoutes(app: FastifyInstance, { tx, pool }: { tx: Tx; pool?: Pool }) {
  const hub = new WorkHub(pool);
  app.addHook('onClose', async () => hub.close());

  // Has anything this page shows changed since `since` (the time of this page's previous answer)? A first question
  // (no since) only starts the clock. The viewer must see the project, goal or task asked about.
  app.get<{ Querystring: { scope?: string; id?: string; since?: string } }>('/api/v0/work/changed', (req) => tx(req, async (c, v) => {
    const raw = String(req.query.scope ?? 'me');
    if (!SCOPES.has(raw)) fail(400, 'Choose what to follow');
    const s: WorkScope = { scope: raw as WorkScope['scope'], id: null };
    if (s.scope === 'project' || s.scope === 'goal' || s.scope === 'task') {
      const id = String(req.query.id ?? ''); if (!UUID.test(id)) fail(400, 'Choose what to follow'); s.id = id;
    }
    const me = v.person ?? fail(403, 'Use your own Pulse account');
    const seen = async (sql: string) => ((await c.query(sql, [s.id])).rowCount ?? 0) > 0;
    if (s.scope === 'project' && !(await seen('select 1 from pulse.project where id=$1') || await seen('select 1 from pulse.task where project_id=$1 limit 1'))) fail(404, 'This project is not there');
    if (s.scope === 'task' && !(await seen('select 1 from pulse.task where id=$1'))) fail(404, 'This task is not there');
    let projects = new Set<string>();
    if (s.scope === 'goal') {
      if (!(await seen('select 1 from pulse.goal where id=$1'))) fail(404, 'This goal is not there');
      projects = new Set((await c.query('select distinct project_id::text id from pulse.goal_link where goal_id=$1 and project_id is not null', [s.id])).rows.map((r) => r.id as string));
    }
    hub.listen();
    const at = Date.now(), since = Number(req.query.since);
    if (!Number.isFinite(since) || since <= 0) return { at, changed: false };
    return { at, changed: hub.changedSince(v.org, since, (n) => touches(s, n, me, projects)) ?? true };
  }));
}

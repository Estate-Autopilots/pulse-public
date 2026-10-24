import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, hr, leadership, type Tx, type Viewer } from './routes.js';

/** TASKS-3: who reports to whom. The chart everyone may read; HR and admins set lines and pod heads; Pulse proposes the
 *  first lines from the roster, pods, roles, Workspace groups, PEOPLE-LIVE's work evidence and who gives whom tasks, and HR
 *  confirms each in one click (or all above a confidence). Writes go through pulse.org_* (0185). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const optId = (x: unknown) => x === undefined || x === null || x === '' ? null : id(x);
const body = { type: 'object' } as const;
const PHOTO = (alias: string) => `(select ph.updated_at from pulse.person_photo ph where ph.person_id=${alias}.id)`;
const editor = (v: Viewer) => v.role === 'admin' || v.role === 'hr';

export type Staff = { id: string; name: string; role: string | null; pod: string | null; department: string | null; managerId: string | null; synthetic: boolean };
export type Proposal = { kind: 'manager' | 'pod_head'; personId: string; managerId?: string; pod?: string; confidence: number; evidence: string[] };
export type Evidence = {
  staff: Staff[]; heads: Map<string, string>; pods: string[];
  /** person → pod → role keys held on that pod's unit (pgs, head_pgs, manager, or "unit manager"). */ unitRoles: Map<string, Map<string, string[]>>;
  /** person → count of PEOPLE-LIVE links as the client's PGS, and as its assigned PM. */ pgs: Map<string, number>; pm: Map<string, number>;
  /** person → the PGS/PM they most often work beside on the same clients, with the count. */ worksWith: Map<string, { id: string; n: number }>;
  /** giver → taker → tasks given (created for or reviewed). */ gives: Map<string, Map<string, number>>;
  /** person → pods their Workspace groups put them in. */ groups: Map<string, string[]>;
};
const TOP = /\b(founder|co-?founder|ceo|chief executive)\b/i;
const LEADS = /\b(head|lead|manager|director|chief)\b/i;

/** Pure: the proposals the evidence supports. Pod heads first (where a pod has none), then a manager for everyone without
 *  one: their pod's head, the CEO for pod heads and leadership, else who gives them work or whose clients they work on. */
export function propose(e: Evidence): Proposal[] {
  const out: Proposal[] = []; const byId = new Map(e.staff.map((s) => [s.id, s]));
  // The top of the company: the CEO, else a founder, else whoever in the Leadership pod gives the most work.
  const given = (id: string) => [...(e.gives.get(id)?.values() ?? [])].reduce((a, b) => a + b, 0);
  const ceo = e.staff.find((s) => /\bceo\b/i.test(s.role ?? '') && !s.synthetic) ?? e.staff.find((s) => /\bceo\b/i.test(s.role ?? ''))
    ?? e.staff.find((s) => TOP.test(s.role ?? '')) ?? e.staff.filter((s) => s.pod === 'Leadership' && given(s.id) > 0).sort((a, b) => given(b.id) - given(a.id))[0] ?? null;
  const ceoRole = ceo ? (TOP.test(ceo.role ?? '') ? ceo.role : 'head of the company (gives the most work in Leadership)') : null;
  const heads = new Map(e.heads); const proposedHeads = new Map<string, string>();
  for (const pod of e.pods) {
    if (heads.has(pod) || pod === 'Shared') continue;
    const members = e.staff.filter((s) => s.pod === pod);
    if (pod === 'Leadership') { if (ceo && ceo.pod === pod) { out.push({ kind: 'pod_head', personId: ceo.id, pod, confidence: 0.8, evidence: [`${ceo.role} in the Leadership pod`] }); proposedHeads.set(pod, ceo.id); } continue; }
    const scored = members.map((m) => {
      const ev: string[] = []; let score = 0;
      const roles = e.unitRoles.get(m.id)?.get(pod) ?? [];
      if (roles.length) { score += 3; ev.push(`Holds the ${roles.join(' and ')} role on ${pod}`); }
      if (LEADS.test(m.role ?? '')) { score += 2; ev.push(`Their role is “${m.role}”`); }
      const pgs = e.pgs.get(m.id) ?? 0, pm = e.pm.get(m.id) ?? 0;
      if (pgs) { score += Math.min(3, pgs / 25); ev.push(`The client's PGS on ${pgs} projects (PEOPLE-LIVE)`); }
      if (pm) { score += Math.min(2, pm / 25); ev.push(`Assigned PM on ${pm} projects`); }
      const given = members.reduce((n, o) => n + (o.id !== m.id ? e.gives.get(m.id)?.get(o.id) ?? 0 : 0), 0);
      if (given) { score += Math.min(2, given / 4); ev.push(`Gives or reviews ${given} tasks of ${pod} people`); }
      return { m, score, ev };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    if (scored.length && scored[0].score >= 2) {
      const [top, next] = scored; const conf = Math.min(0.9, top.score / (top.score + (next?.score ?? 0) + 1));
      out.push({ kind: 'pod_head', personId: top.m.id, pod, confidence: Math.round(conf * 1000) / 1000, evidence: top.ev });
      proposedHeads.set(pod, top.m.id);
    }
  }
  for (const s of e.staff) {
    if (s.managerId || TOP.test(s.role ?? '') || s.id === ceo?.id) continue;
    const ev: string[] = []; let to: string | null = null, conf = 0;
    const head = s.pod ? heads.get(s.pod) ?? proposedHeads.get(s.pod) : undefined;
    const isHead = [...heads.values(), ...proposedHeads.values()].includes(s.id);
    const giver = [...e.gives.entries()].map(([g, m]) => ({ g, n: m.get(s.id) ?? 0 })).filter((x) => x.n >= 3 && x.g !== s.id).sort((a, b) => b.n - a.n)[0];
    if (head && head !== s.id) { to = head; conf = heads.has(s.pod!) ? 0.85 : 0.65; ev.push(`${s.pod} member; ${byId.get(head)?.name ?? 'its head'} ${heads.has(s.pod!) ? 'heads' : 'is proposed to head'} ${s.pod}`); }
    else if ((isHead || s.pod === 'Leadership') && ceo && ceo.id !== s.id) { to = ceo.id; conf = TOP.test(ceo.role ?? '') ? 0.6 : 0.45; ev.push(isHead ? `Pod heads report to the ${ceoRole}, ${ceo.name}` : `In the Leadership pod; ${ceo.name} is the ${ceoRole}`); }
    else if (giver) { to = giver.g; conf = Math.min(0.75, 0.4 + giver.n / 40); ev.push(`${byId.get(giver.g)?.name ?? 'They'} gives or reviews ${giver.n} of their tasks`); }
    else {
      const w = e.worksWith.get(s.id);
      if (w && w.n >= 5) {
        const partner = byId.get(w.id); const partnerHead = partner?.pod ? heads.get(partner.pod) ?? proposedHeads.get(partner.pod) : undefined;
        to = partnerHead && partnerHead !== s.id ? partnerHead : w.id; conf = Math.min(0.6, 0.3 + w.n / 100);
        ev.push(`Works on ${w.n} projects where ${partner?.name ?? 'a PGS'} is the client's PGS or PM${partnerHead && partnerHead !== w.id ? ` (${partner?.pod}, headed by ${byId.get(partnerHead)?.name})` : ''}`);
      } else if (ceo && ceo.id !== s.id) { to = ceo.id; conf = 0.3; ev.push(`No other evidence: ${ceo.name}, the ${ceoRole}, by default`); }
    }
    const groups = e.groups.get(s.id); if (groups?.length) ev.push(`Workspace groups: ${groups.join(', ')}`);
    if (to && to !== s.id) out.push({ kind: 'manager', personId: s.id, managerId: to, confidence: Math.round(conf * 1000) / 1000, evidence: ev });
  }
  return out;
}

async function evidence(c: PoolClient): Promise<Evidence> {
  // Twin records of one person (the same name twice) carry their evidence over to the record people sign in with.
  const canon = new Map<string, string>();
  for (const r of (await c.query(`select p.id,coalesce(k.id,p.id) canonical from pulse.person p left join lateral (select w.id from pulse.work_people() w join pulse.person q on q.id=w.id
    where lower(regexp_replace(btrim(q.display_name),'\\s+',' ','g'))=lower(regexp_replace(btrim(p.display_name),'\\s+',' ','g')) limit 1) k on true where p.side='staff'`)).rows) canon.set(r.id, r.canonical);
  const one = (pid: string) => canon.get(pid) ?? pid;
  const staff = (await c.query(`select p.id,p.display_name name,pp.role,pp.pod,pp.department,pp.manager_id "managerId",coalesce(pp.email like '%@synthetic.invalid' or pp.role like '%(synthetic)%',false) synthetic
   from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.id in (select id from pulse.work_people()) order by p.display_name`)).rows as Staff[];
  const heads = new Map((await c.query('select name,head_id from pulse.hr_pod')).rows.map((r) => [r.name as string, r.head_id as string]));
  for (const r of (await c.query("select name,head_person_id h from pulse.unit where kind='pod' and valid_to is null and head_person_id is not null")).rows) if (!heads.has(r.name)) heads.set(r.name, r.h);
  const pods = (await c.query("select name from pulse.unit where kind='pod' and valid_to is null order by name")).rows.map((r) => r.name as string);
  const unitRoles = new Map<string, Map<string, string[]>>();
  for (const r of (await c.query(`select r.person_id p,u.name pod,case when r.is_manager_of_unit then 'unit manager' else r.role_key end role from pulse.role_assignment r join pulse.unit u on u.id=r.unit_id
    where u.kind='pod' and (r.is_manager_of_unit or r.role_key in ('pgs','head_pgs','manager')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity')`)).rows) {
    const m = unitRoles.get(one(r.p)) ?? new Map<string, string[]>(); m.set(r.pod, [...(m.get(r.pod) ?? []), r.role === 'pgs' ? 'PGS' : r.role === 'head_pgs' ? 'head PGS' : r.role]); unitRoles.set(one(r.p), m);
  }
  const links = ((await c.query(`select person_id p,project_id pr,role from pulse.people_work_link where kind='project' and status<>'rejected' and retired_at is null and project_id is not null`)).rows as { p: string; pr: string; role: string | null }[])
    .map((l) => ({ ...l, p: one(l.p) }));
  const pgs = new Map<string, number>(), pm = new Map<string, number>(), lead = new Map<string, Set<string>>();
  for (const l of links) {
    if (/pgs for the client/i.test(l.role ?? '')) { pgs.set(l.p, (pgs.get(l.p) ?? 0) + 1); lead.set(l.pr, (lead.get(l.pr) ?? new Set()).add(l.p)); }
    else if (/assigned pm/i.test(l.role ?? '')) { pm.set(l.p, (pm.get(l.p) ?? 0) + 1); lead.set(l.pr, (lead.get(l.pr) ?? new Set()).add(l.p)); }
  }
  const worksWith = new Map<string, { id: string; n: number }>(); const pair = new Map<string, Map<string, number>>();
  for (const l of links) { if (/pgs for the client|assigned pm/i.test(l.role ?? '')) continue; for (const leader of lead.get(l.pr) ?? []) if (leader !== l.p) { const m = pair.get(l.p) ?? new Map(); m.set(leader, (m.get(leader) ?? 0) + 1); pair.set(l.p, m); } }
  for (const [p, m] of pair) { const [best] = [...m.entries()].sort((a, b) => b[1] - a[1]); if (best) worksWith.set(p, { id: best[0], n: best[1] }); }
  const gives = new Map<string, Map<string, number>>();
  for (const r of (await c.query(`select giver,taker,count(*)::int n from (select t.created_by giver,coalesce(t.assignee_person_id,t.owner_id) taker from pulse.task t where t.source='pulse' and t.created_by is not null
     union all select t.review_owner_id,coalesce(t.assignee_person_id,t.owner_id) from pulse.task t where t.review_owner_id is not null) x
    where giver is not null and taker is not null and giver<>taker group by 1,2`)).rows) { const g = one(r.giver), t = one(r.taker); if (g === t) continue; const m = gives.get(g) ?? new Map(); m.set(t, (m.get(t) ?? 0) + r.n); gives.set(g, m); }
  const groups = new Map<string, string[]>();
  for (const r of (await c.query(`select person_id p,array_agg(distinct coalesce(pod,group_label)) g from pulse.people_work_link where kind='pod' and status<>'rejected' and retired_at is null group by 1`)).rows) groups.set(one(r.p), [...new Set([...(groups.get(one(r.p)) ?? []), ...r.g])]);
  return { staff, heads, pods, unitRoles, pgs, pm, worksWith, gives, groups };
}

async function chart(c: PoolClient, v: Viewer) {
  const people = (await c.query(`select p.id,p.display_name name,pp.role,pp.pod,pp.department,pp.manager_id "managerId",${PHOTO('p')} "photoAt"
   from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.id in (select id from pulse.work_people()) order by p.display_name`)).rows;
  const pods = (await c.query(`select u.name,coalesce(h.head_id,u.head_person_id) "headId" from pulse.unit u left join pulse.hr_pod h on h.org_id=u.org_id and h.name=u.name where u.kind='pod' and u.valid_to is null order by u.name`)).rows;
  const proposals = leadership(v) || hr(v) ? (await c.query(`select x.id,x.kind,x.person_id "personId",p.display_name "personName",x.manager_id "managerId",m.display_name "managerName",x.pod,x.confidence::float confidence,x.evidence,x.created_at "createdAt"
    from pulse.org_line_proposal x join pulse.person p on p.id=x.person_id left join pulse.person m on m.id=x.manager_id where x.status='pending' order by x.kind='pod_head' desc,x.confidence desc,p.display_name`)).rows : [];
  const decided = leadership(v) || hr(v) ? (await c.query("select count(*) filter(where status='confirmed')::int confirmed,count(*) filter(where status='dismissed')::int dismissed from pulse.org_line_proposal")).rows[0] : null;
  return { people, pods, departments: [...new Set(people.map((p) => p.department).filter(Boolean))].sort(), proposals, decided, canEdit: editor(v), canSuggest: editor(v) || leadership(v), me: v.person };
}

export function registerOrgRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/org/chart', req => tx(req, async (c, v) => chart(c, v)));
  // HR and admins: one line, a pod head.
  app.post<{ Body: Body }>('/api/v0/org/line', { schema: { body } }, req => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'HR and admins set reporting lines');
    await c.query('select pulse.org_line_set($1,$2)', [id(req.body.personId), optId(req.body.managerId)]); return { ok: true };
  }));
  app.post<{ Body: Body }>('/api/v0/org/pod-head', { schema: { body } }, req => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'HR and admins set pod heads');
    const pod = String(req.body.pod ?? '').trim().slice(0, 80); if (!pod) fail(400, 'Choose a pod');
    await c.query('select pulse.org_pod_head_set($1,$2)', [pod, optId(req.body.personId)]); return { ok: true };
  }));
  // Look for lines in the evidence again (pending proposals are replaced; decided ones are kept and not proposed again).
  app.post('/api/v0/org/suggest', req => tx(req, async (c, v) => {
    if (!editor(v) && !leadership(v)) fail(403, 'HR, leadership and admins look for reporting lines');
    const found = propose(await evidence(c));
    const n = (await c.query('select pulse.org_line_propose($1) n', [JSON.stringify(found)])).rows[0].n as number;
    return { proposed: n, pods: found.filter((p) => p.kind === 'pod_head').length, lines: found.filter((p) => p.kind === 'manager').length };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/org/proposals/:id/confirm', { schema: { body } }, req => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'HR and admins confirm reporting lines');
    return (await c.query('select pulse.org_line_decide($1,true,$2) r', [id(req.params.id), optId(req.body.managerId)])).rows[0].r;
  }));
  app.post<{ Params: { id: string } }>('/api/v0/org/proposals/:id/dismiss', req => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'HR and admins confirm reporting lines');
    return (await c.query('select pulse.org_line_decide($1,false,null) r', [id(req.params.id)])).rows[0].r;
  }));
  // One click for everything above a confidence: pod heads first, so their pods' lines follow them.
  app.post<{ Body: Body }>('/api/v0/org/proposals/confirm-all', { schema: { body } }, req => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'HR and admins confirm reporting lines');
    const min = Math.max(0, Math.min(1, Number(req.body.min ?? 0.6)));
    const rows = (await c.query("select id from pulse.org_line_proposal where status='pending' and confidence>=$1 order by kind='pod_head' desc,confidence desc", [min])).rows;
    let confirmed = 0; const failed: string[] = [];
    for (const r of rows) {
      await c.query('savepoint org_one');
      try { await c.query('select pulse.org_line_decide($1,true,null)', [r.id]); await c.query('release savepoint org_one'); confirmed++; }
      catch (e) { await c.query('rollback to savepoint org_one'); failed.push(e instanceof Error ? e.message : 'Not confirmed'); }
    }
    return { confirmed, failed };
  }));
}

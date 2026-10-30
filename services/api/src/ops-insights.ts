import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, leadership, type Tx, type Viewer } from './routes.js';
import { normalizeDoc, type SopStep } from './sop-model.js';
// WA-NATIVE (1053): Insights → Client operations. What the company's imported WhatsApp groups say about how it runs a
// client (the service path and its timings, who waits for whom, what clients ask, where it goes wrong, the onboarding
// SOP against what the chats show) and six recommendations a leader turns into work in one click: a task, or a change
// proposed in an SOP draft for review (never made active by itself). Leadership and admins only; counts, medians and
// client names, never message text. Per client: health, churn risk and why, groups waiting on us, the latest sentiment.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
type Data = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- the database's jsonb read
const lead = (v: Viewer) => { if (!v.person) fail(403, 'Insights need your individual employee account'); if (!leadership(v)) fail(403, 'Insights are for leadership and admins'); };
const days = (h: unknown) => typeof h === 'number' ? Math.round(h / 24 * 10) / 10 : null;
const pct = (x: unknown) => typeof x === 'number' ? `${Math.round(x * 100)}%` : '–';
const step = (d: Data, no: number) => ((d.sop?.steps ?? []) as Data[]).find((s) => s.step_no === no) ?? {};
const signal = (d: Data, kind: string) => ((d.wrong?.signals ?? []) as Data[]).find((s) => s.kind === kind) ?? { n: 0, groups: 0 };

export type Rec = { id: string; title: string; why: string; evidence: string[]; task: { title: string; notes: string }; sop: { title: string; detail: string; phase: string; slaHours: number | null } };
/** The six recommendations, with this company's own numbers (PLAYBOOK, WA-IMPORT dataset v2). */
export function recommendations(d: Data): Rec[] {
  const g = d.groups ?? 0, team = d.waits?.sides?.team ?? {}, lq = signal(d, 'lead_quality'), access = days(step(d, 12).median_hours_from_start), held = days(step(d, 6).median_hours_from_start);
  const recs: Omit<Rec, 'task'>[] = [
    { id: 'day-one', title: 'Collect everything on day 1, in one message',
      why: `Project facts are the clients' biggest topic and price changes the most common change; Page and Business Manager access arrived a median ${access ?? '–'} days in.`,
      evidence: [`Page & Business Manager access: seen in ${pct(step(d, 12).observed_share)} of groups, median ${access ?? '–'} days after start`, `Project & location info from the client: ${pct(step(d, 8).observed_share)} of groups`],
      sop: { title: 'Day 1: ask for everything in one message', phase: 'Onboarding', slaHours: 24,
        detail: 'One message on day 1: brochure, cost sheet with current prices, RERA number and QR, the contact number for ads, location pin, logo, and Page + Business Manager access.' } },
    { id: 'call-48h', title: 'Hold the onboarding call within 48 hours and write down what was agreed',
      why: `The "as discussed" message came a median ${held ?? '–'} days in; the service agreement shows in ${pct(step(d, 7).observed_share)} of groups.`,
      evidence: [`Onboarding call held: ${pct(step(d, 6).observed_share)} of groups, median ${held ?? '–'} days after start`, `Service agreement: ${pct(step(d, 7).observed_share)} of groups`],
      sop: { title: 'Onboarding call within 48 hours; agreement in week 1', phase: 'Onboarding', slaHours: 48,
        detail: 'Hold the onboarding call within 48 hours of the group starting, post what was agreed in the group the same day, and send the service agreement in the first week.' } },
    { id: 'one-approver', title: 'Agree the approval rhythm: one named approver, a 24-hour review window',
      why: `Creatives → client approval took a median ${d.path?.days?.creativeToApproval ?? '–'} days and start → live ${d.path?.days?.startToLive ?? '–'} days; the wait is on approvals.`,
      evidence: [`Creatives → approval: median ${d.path?.days?.creativeToApproval ?? '–'} days`, `Start → campaign live: median ${d.path?.days?.startToLive ?? '–'} days`, `Change requests per group: median ${d.path?.days?.revisions ?? '–'}`],
      sop: { title: 'Name one approver; 24-hour review window', phase: 'Creatives', slaHours: 24,
        detail: 'At onboarding, the client names one approver for creatives and agrees to answer within 24 hours; the team follows up at 24 hours.' } },
    { id: 'funds-rule', title: 'Set the funds rule before going live',
      why: `Asking the client to add funds is the team's most repeated request (${(d.wrong?.funds?.asks ?? 0).toLocaleString('en-IN')} times in ${d.wrong?.funds?.groups ?? 0} groups); campaigns stall when the budget runs out over a weekend.`,
      evidence: [`Funds requests by the team: ${(d.wrong?.funds?.asks ?? 0).toLocaleString('en-IN')} in ${d.wrong?.funds?.groups ?? 0} of ${g} groups`],
      sop: { title: 'Agree a minimum balance and a weekend top-up before going live', phase: 'Go live', slaHours: null,
        detail: 'Before the campaign goes live: agree a minimum ad balance and a weekend top-up, and pin the payment QR or link in the group.' } },
    { id: 'lead-feedback', title: 'Make lead feedback a routine',
      why: `Lead quality drives most complaints and the churn index: ${lq.n} lead-quality signals in ${lq.groups} groups.`,
      evidence: [`Lead-quality signals: ${lq.n} in ${lq.groups} groups`, `Complaints in all: ${signal(d, 'complaint').n} in ${signal(d, 'complaint').groups} groups`],
      sop: { title: 'Weekly lead feedback on a fixed day', phase: 'Leads', slaHours: null,
        detail: 'A shared lead sheet and a fixed weekday when the client marks each lead (genuine, junk, broker, not reachable); the team reviews targeting the same day.' } },
    { id: 'one-owner', title: "Keep the team's answer time and give each client one owner",
      why: `The team answers in a median ${team.medianMinutes ?? '–'} working minutes (90% within ${team.p90Hours ?? '–'} h); ${d.wrong?.atRisk ?? 0} clients score high on churn risk.`,
      evidence: [`Team answer: median ${team.medianMinutes ?? '–'} working minutes, 90th percentile ${team.p90Hours ?? '–'} h`, `Clients at high churn risk: ${d.wrong?.atRisk ?? 0}`],
      sop: { title: 'One owner per client; answer within working minutes', phase: 'Throughout', slaHours: 1,
        detail: 'Each client has one named owner in the team (the colleague most active with them), who answers within an hour of working time and escalates what they cannot answer.' } },
  ];
  return recs.map((r) => ({ ...r, task: { title: r.title, notes: `From Insights → Client operations (what ${g.toLocaleString('en-IN')} WhatsApp groups show).\n\nWhy: ${r.why}\n\n${r.evidence.map((e) => `- ${e}`).join('\n')}\n\nProposed step: ${r.sop.title}. ${r.sop.detail}` } }));
}

const SOP_COLS = `id,title,purpose,status,doc,owner_role "ownerRole",owner_id "ownerId",client_id "clientId",category,tags`;
/** The draft that collects the proposed changes (made once from the measured SOP, else the observed one). */
export async function proposal(c: PoolClient, d: Data): Promise<Data> {
  if (d.sop?.proposedId) { const r = (await c.query(`select ${SOP_COLS} from pulse.sop where id=$1`, [d.sop.proposedId])).rows[0]; if (r && r.status !== 'archived') return r; }
  const base = d.sop?.sopId ? (await c.query(`select ${SOP_COLS} from pulse.sop where id=$1`, [d.sop.sopId])).rows[0] : null;
  const measured = new Map(((d.sop?.steps ?? []) as Data[]).map((s) => [String(s.step).toLowerCase(), s]));
  const steps = ((base?.doc?.steps ?? []) as SopStep[]).map((s) => { const m = measured.get(s.title.toLowerCase());
    return m ? { ...s, detail: [s.detail, `Measured in the WhatsApp groups: seen in ${pct(m.observed_share)} of ${m.groups} groups, median ${days(m.median_hours_from_start) ?? '–'} days after start.`].filter(Boolean).join('\n\n') } : s; });
  const doc = normalizeDoc({ ...(base?.doc ?? {}), steps });
  if ('error' in doc) fail(400, doc.error);
  const title = `${base?.title ?? 'Client onboarding'}: proposed changes from the WhatsApp groups`.slice(0, 200);
  const sid = (await c.query('select pulse.sop_save(null,$1) id', [JSON.stringify({ title, status: 'draft', doc: (doc as { doc: unknown }).doc, category: base?.category ?? 'Onboarding',
    tags: ['whatsapp_import', 'proposed'], purpose: `For review: ${base ? `"${base.title}"` : 'the onboarding SOP'} with what ${(d.groups ?? 0).toLocaleString('en-IN')} WhatsApp groups show (each step's measured share and timing) and the changes proposed from Insights → Client operations. Nothing changes until a leader makes it active.`,
    note: 'Proposed from the WhatsApp analysis' })])).rows[0].id as string;
  await c.query("select pulse.wa_company_insights(true)");
  return (await c.query(`select ${SOP_COLS} from pulse.sop where id=$1`, [sid])).rows[0];
}

export function registerOpsInsightRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const body = { type: 'object' } as const;
  const read = async (c: PoolClient, fresh = false) => {
    const d = (await c.query('select pulse.wa_company_insights($1) r', [fresh])).rows[0].r as Data | null;
    if (!d) fail(403, 'Insights are for leadership and admins');
    return d!;
  };
  app.get('/api/v0/insights/operations', (req) => tx(req, async (c, v) => {
    lead(v); const d = await read(c, (req.query as { fresh?: string }).fresh === '1');
    return { ...d, recommendations: recommendations(d) };
  }));
  // VISIBLE (owner, 25 Oct 2026): leadership's Home cards: groups waiting on us, clients at churn risk and what Insights
  // found, each with its way into the full page. Counts and names only. Read after the Home is on screen.
  app.get('/api/v0/insights/home', (req) => tx(req, async (c, v) => {
    lead(v);
    const waits = (await c.query(`select id, name, waiting_since "since", waiting_who "who" from pulse.chat_group_hub()
      where waiting_since is not null and not coalesce(archived_by_me, false) order by waiting_since`)).rows as { id: string; name: string; since: string; who: string | null }[];
    const d = (await c.query('select pulse.wa_company_insights(false) r')).rows[0].r as Data | null;
    const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const signals = ((await c.query('select pulse.wa_signals($1) r', [JSON.stringify({ since, limit: 1000 })])).rows[0].r ?? []) as { kind: string }[];
    const kinds = Object.entries(signals.reduce<Record<string, number>>((n, s) => ({ ...n, [s.kind]: (n[s.kind] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
    const churn = ((d?.wrong?.churn ?? []) as Data[]).filter((r) => (r.risk ?? 0) >= 0.5);
    // A wait of the last 14 days is one to act on; older ones are counted apart (imported history can be months old).
    const recent = waits.filter((g) => Date.parse(g.since) > Date.now() - 14 * 86400_000);
    return {
      waiting: { count: recent.length, older: waits.length - recent.length, top: recent.slice(0, 3) },
      atRisk: d ? { count: d.wrong?.atRisk ?? churn.length, top: churn.slice(0, 3).map((r) => ({ clientId: r.clientId as string, client: r.client as string, risk: r.risk as number })) } : null,
      insights: d ? { recommendations: recommendations(d).length, first: recommendations(d)[0]?.title ?? null, signals30d: signals.length, kinds: kinds.slice(0, 3) } : null,
    };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/insights/clients/:id', (req) => tx(req, async (c, v) => {
    lead(v); const cid = UUID.test(req.params.id) ? req.params.id : fail(400, 'Choose a valid client');
    return { health: (await c.query('select pulse.wa_client_health($1) r', [cid])).rows[0].r };
  }));
  // One click: the recommendation becomes a task (mine, due in a week) or a step proposed in the SOP draft for review.
  app.post<{ Body: Body }>('/api/v0/insights/operations/actions', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const d = await read(c); const rec = recommendations(d).find((r) => r.id === req.body.rec) ?? fail(400, 'Choose a recommendation');
    const kind = req.body.kind === 'sop' ? 'sop' : req.body.kind === 'task' ? 'task' : fail(400, 'Make a task or propose an SOP change');
    let ref: string;
    if (kind === 'task') {
      const due = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      ref = (await c.query('select pulse.task_save(null,$1) id', [JSON.stringify({ title: rec!.task.title.slice(0, 200), notes: rec!.task.notes, assigneeId: v.person, dueOn: due })])).rows[0].id;
    } else {
      const s = await proposal(c, d);
      const steps = ((s.doc?.steps ?? []) as SopStep[]).filter((x) => x.id !== `wa-${rec!.id}`);
      const add = { id: `wa-${rec!.id}`, kind: 'task', title: rec!.sop.title, detail: `${rec!.sop.detail}\n\nWhy: ${rec!.why}`, phase: rec!.sop.phase, slaHours: rec!.sop.slaHours, involves: [], inputs: [], outputs: [], kpis: [], links: [], next: null };
      const doc = normalizeDoc({ ...s.doc, steps: [...steps, add] });
      if ('error' in doc) fail(400, doc.error);
      await c.query('select pulse.sop_save($1,$2)', [s.id, JSON.stringify({ ...s, status: 'draft', doc: (doc as { doc: unknown }).doc, note: `Proposed: ${rec!.sop.title}`.slice(0, 300) })]);
      ref = s.id;
    }
    await c.query('select pulse.wa_insight_action_add($1,$2,$3)', [rec!.id, kind, ref]);
    return { ok: true, kind, ref };
  }));
  // Load the SOP proposal for review (the measured SOP with each step's share and timing), without a recommendation.
  app.post('/api/v0/insights/operations/sop', (req) => tx(req, async (c, v) => {
    lead(v); const s = await proposal(c, await read(c)); return { ok: true, ref: s.id };
  }));
}

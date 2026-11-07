import type { FastifyInstance } from 'fastify';
import { fail, type Tx, type Viewer } from './routes.js';

/** LIFECYCLE part 5: My Pulse, each person's own home (their records only), kudos between colleagues, and corrections
 *  to what Pulse knows, which go to HR as an ordinary request. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const body = { type: 'object' } as const;
const own = (v: Viewer) => v.person ?? fail(403, 'Sign in with your own staff account');
const str = (x: unknown, max: number) => String(x ?? '').trim().slice(0, max);

export function registerMyPulseRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/me/pulse', req => tx(req, async (c, v) => {
    own(v);
    const home = (await c.query('select pulse.me_pulse() h')).rows[0].h;
    // COMP-B: payslips from Pulse payroll join the issued ones (month and date only; figures open in the PDF).
    const slips = (await c.query('select pulse.pay_payslips($1) l', [v.person])).rows[0].l as { id: string; month: string; version: number; issuedAt: string }[];
    if (slips.length && home?.money) {
      const seen = new Set((home.money.payslips as { month: string }[]).map((p) => p.month));
      const latest = new Map<string, (typeof slips)[number]>();
      for (const s of slips) if (!seen.has(s.month.slice(0, 7)) && !latest.has(s.month.slice(0, 7))) latest.set(s.month.slice(0, 7), s);
      home.money.payslips = [...home.money.payslips, ...[...latest.values()].map((s) => ({ month: s.month.slice(0, 7), version: s.version, issuedAt: s.issuedAt, net: null, reimbursements: null, href: `/api/v0/comp/payslips/${s.id}/pdf` }))]
        .sort((a: { month: string }, b: { month: string }) => b.month.localeCompare(a.month)).slice(0, 6);
    }
    // INTEGRITY (0910): a task carries no value, so no points reach a person's page (week, month, accepted work).
    if (home?.week) delete home.week.points;
    if (home?.money) delete home.money.pointsThisMonth;
    if (Array.isArray(home?.recognition?.accepted)) for (const a of home.recognition.accepted) delete a.points;
    const value = ((await c.query('select pulse.value_mine(6) m')).rows[0].m as Record<string, unknown>[]).map(({ points: _p, ...m }) => { void _p; return m; });
    const colleagues = (await c.query(`select p.id,p.display_name name,pp.pod from pulse.person p join pulse.people_profile pp on pp.person_id=p.id
      where p.side='staff' and p.status='active' and p.id<>$1 and not pulse.lifecycle_possibly_left(p.id) order by p.display_name`, [v.person])).rows;
    return { ...home, value, colleagues };
  }));
  app.post<{ Body: Record<string, unknown> }>('/api/v0/kudos', { schema: { body } }, req => tx(req, async (c, v) => {
    own(v); const b = req.body ?? {};
    const to = b.to ? id(b.to) : fail(400, 'Choose a colleague to thank');
    return { id: (await c.query('select pulse.kudos_give($1,$2,$3) id', [to, str(b.note, 280), b.taskId ? id(b.taskId) : null])).rows[0].id };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/kudos/:id/hide', req => tx(req, async (c, v) => {
    own(v); await c.query('select pulse.kudos_hide($1)', [id(req.params.id)]); return { ok: true };
  }));
  // "That's not right": a request to HR that names the fact, what Pulse shows and what it should be.
  app.post<{ Body: Record<string, unknown> }>('/api/v0/me/corrections', { schema: { body } }, req => tx(req, async (c, v) => {
    own(v); const b = req.body ?? {};
    const label = str(b.label, 80), proposed = str(b.proposed, 300);
    if (label.length < 2 || proposed.length < 2) fail(400, 'Say what should change');
    const text = [`What Pulse shows: ${str(b.value, 300) || 'nothing'}`, `What it should be: ${proposed}`, str(b.note, 1000)].filter(Boolean).join('\n');
    return { id: (await c.query("select pulse.hr_ticket_open('other',$1,$2,'normal') id", [`Correction: ${label}`.slice(0, 140), text])).rows[0].id };
  }));
}

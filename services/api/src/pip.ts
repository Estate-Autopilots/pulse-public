// TASK-MERGE (Pip, owner 7 Nov 2026): what a person did with Pip's suggestions ("Not useful", or used it), kept per
// person, per suggestion kind and subject (1695_pip_feedback.sql). The web app reads it once per visit so a dismissed
// suggestion never comes back on any device, and a kind the person keeps dismissing scores down for them
// (apps/web/app/lib/pip-suggest.mjs). Row security keeps every row to its own person.
import type { FastifyInstance } from 'fastify';
import { fail, type Tx } from './routes.js';

const KIND = /^[a-z][a-z0-9-]{0,39}$/;
type Body = { kind?: unknown; subject?: unknown; action?: unknown };

/** The change a person sends, checked for shape. */
export function pipFeedbackChange(b: Body): { kind: string; subject: string; action: 'accept' | 'dismiss' } {
  const kind = String(b.kind ?? ''); const subject = String(b.subject ?? '').trim(); const action = String(b.action ?? '');
  if (!KIND.test(kind)) fail(400, 'Unknown suggestion');
  if (!subject || subject.length > 200) fail(400, 'Unknown suggestion');
  if (action !== 'accept' && action !== 'dismiss') return fail(400, 'Say whether it was useful');
  return { kind, subject, action };
}

export function registerPipRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/pip/feedback', req => tx(req, async (c, v) => {
    if (!v.person) return { rows: [] };
    const rows = (await c.query(`select kind, subject, accepted, dismissed, dismissed_at "dismissedAt" from pulse.pip_feedback
      where person_id = $1 order by updated_at desc limit 2000`, [v.person])).rows;
    return { rows };
  }));
  app.post<{ Body: Body }>('/api/v0/pip/feedback', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Sign in with your own account to tell Pip');
    const { kind, subject, action } = pipFeedbackChange(req.body ?? {});
    const dismiss = action === 'dismiss';
    await c.query(`insert into pulse.pip_feedback(org_id, person_id, kind, subject, accepted, dismissed, dismissed_at)
      values (pulse.current_org(), $1, $2, $3, $4, $5, case when $6 then now() end)
      on conflict (org_id, person_id, kind, subject) do update set accepted = pulse.pip_feedback.accepted + excluded.accepted,
        dismissed = pulse.pip_feedback.dismissed + excluded.dismissed, dismissed_at = coalesce(excluded.dismissed_at, pulse.pip_feedback.dismissed_at), updated_at = now()`,
      [v.person, kind, subject, dismiss ? 0 : 1, dismiss ? 1 : 0, dismiss]);
    return { ok: true };
  }));
}

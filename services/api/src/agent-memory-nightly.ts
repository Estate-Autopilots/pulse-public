// AGENT-MEMORY (2090, owner P4.1: "every conversation is captured, then consolidated nightly"). Every 15 minutes, for each
// active company, pulse.agent_memory_nightly() runs in the company's context with no viewer: from 3 a.m. company time,
// once a day, each AI employee that has the Memory tool reads its day's conversations and keeps what the typed rules find
// (per person, per conversation, company candidates), and lets unused learned notes fade. The database decides when it
// is due and what is kept; this loop only knocks. PULSE_AGENT_MEMORY_LOOP=0 turns it off.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

export async function agentMemoryPass(pool: Pool): Promise<{ orgs: number; learned: number }> {
  const orgs = (await pool.query('select pulse.list_active_orgs() org')).rows.map((r) => r.org as string);
  let learned = 0;
  for (const org of orgs) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('pulse.org_id',$1,true), set_config('pulse.viewer_id','',true)", [org]);
      learned += Number((await c.query('select pulse.agent_memory_nightly() n')).rows[0].n ?? 0);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw Object.assign(new Error((e as Error).message?.slice(0, 160) ?? 'failed'), { org });
    } finally { c.release(); }
  }
  return { orgs: orgs.length, learned };
}

export function registerAgentMemoryNightly(app: FastifyInstance, pool?: Pool) {
  if (!pool || process.env.PULSE_AGENT_MEMORY_LOOP === '0') return;
  let busy = false;
  const due = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await agentMemoryPass(pool);
      if (r.learned) app.log.info(r, 'AI employees learned from their day (nightly)');
    } catch (e) {
      app.log.warn({ org: (e as { org?: string }).org, reason: (e as Error).message }, 'AI employee nightly learning failed');
    } finally { busy = false; }
  };
  const tick = setInterval(() => void due(), 15 * 60_000);
  tick.unref();
  app.addHook('onClose', async () => { clearInterval(tick); });
}

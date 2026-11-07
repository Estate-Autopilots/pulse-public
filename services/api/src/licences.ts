// LICENCES (owner, 23 Oct 2026): the central register of every organisation licensed to run Pulse (0943). Leaders of
// the platform organisation read it; each install is checked live: its public /healthz answers with the release it
// runs, so the register shows who is online and who is behind on updates. Only the address is called, nothing is sent.
import type { FastifyInstance } from 'fastify';
import { fail, leadership, type Tx } from './routes.js';

type Licence = { key: string; name: string; handle: string; orgId: string | null; hosting: 'central' | 'self-hosted'; address: string | null;
  plan: string; seats: number | null; status: string; issuedOn: string; renewsOn: string | null; note: string | null; people: number | null };
type Live = { online: boolean; release: string | null; ms: number | null; checkedAt: string };

const cache = new Map<string, { at: number; live: Live }>();

/** One install's health, at most once every 30 seconds per address, 4 seconds at most. */
export async function probe(address: string, now = Date.now(), fetcher: typeof fetch = fetch): Promise<Live> {
  const hit = cache.get(address);
  if (hit && now - hit.at < 30_000) return hit.live;
  const start = Date.now();
  let live: Live;
  try {
    const r = await fetcher(`${address}/healthz`, { signal: AbortSignal.timeout(4_000), headers: { accept: 'application/json' }, redirect: 'manual' });
    const body = r.ok ? await r.json().catch(() => null) as { status?: string; release?: string } | null : null;
    live = { online: !!body && body.status === 'ok', release: typeof body?.release === 'string' ? body.release.slice(0, 12) : null, ms: Date.now() - start, checkedAt: new Date().toISOString() };
  } catch { live = { online: false, release: null, ms: null, checkedAt: new Date().toISOString() }; }
  cache.set(address, { at: now, live });
  return live;
}

export function registerLicenceRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // FEATURES-1024 / CONNECT 2: who referred which organisation to Pulse (client requests), for the platform's leaders.
  app.get('/api/v0/licences/referrals', (req) => tx(req, async (c, v) => {
    if (!leadership(v)) fail(403, 'Referrals are for the platform’s leaders.');
    try { return { referrals: (await c.query('select pulse.referral_list() r')).rows[0].r }; }
    catch (e) { if ((e as { code?: string }).code === '42501') fail(403, 'Referrals are kept by the platform organisation.'); throw e; }
  }));
  app.get('/api/v0/licences', async (req) => {
    const rows = await tx(req, async (c, v) => {
      if (!leadership(v)) fail(403, 'Licences are for the platform’s leaders.');
      try { return (await c.query<{ list: Licence[] }>('select pulse.licence_list() list')).rows[0].list; }
      catch (e) { if ((e as { code?: string }).code === '42501') fail(403, 'Licences are kept by the platform organisation.'); throw e; }
    });
    const live = await Promise.all(rows.map((l) => l.address ? probe(l.address) : Promise.resolve(null)));
    const own = live[rows.findIndex((l) => l.handle === 'estateautopilots')]?.release ?? null;
    return { licences: rows.map((l, i) => ({ ...l, live: live[i], current: !!own && !!live[i]?.release && live[i]!.release === own })), release: own };
  });
}

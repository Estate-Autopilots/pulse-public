import type { FastifyInstance } from 'fastify';
import type { Installation } from './installation.js';
import { admin, fail, type Tx } from './routes.js';

const PATH = '/api/v0/integrations/handovers/settings';
export function registerHandoverSettings(app: FastifyInstance, { tx }: { tx: Tx }, installation: Installation) {
  app.route({ method: ['GET', 'POST'], url: PATH, exposeHeadRoute: false,
    onRequest: async (req, reply) => {
      reply.header('cache-control', 'private, no-store');
      if (req.headers.authorization !== undefined || req.headers['x-pulse-agent-key'] !== undefined)
        fail(403, 'Staff sign-in required');
      if (req.url.includes('?')) fail(400, 'Query parameters are not supported');
    }, handler: async (req, reply) => {
      try {
        return await tx(req, async (c, v) => {
          if (!admin(v) || !v.person || v.side !== 'staff' || v.org !== await installation.readOrg()) fail(403, 'Company admin required');
          if (req.method === 'POST' && (!process.env.PULSE_PUBLIC_URL || req.headers.origin !== new URL(process.env.PULSE_PUBLIC_URL).origin)) fail(403, 'Invalid origin');
          if (req.method === 'GET') return (await c.query('select pulse.handover_settings() settings')).rows[0].settings;
          const b = req.body as Record<string, unknown> | null, fields: { path: string; problem: string }[] = [];
          const invalid = (path: string) => fields.push({ path, problem: 'Invalid field' });
          if (!b || typeof b !== 'object' || Array.isArray(b)) invalid('$');
          else {
            for (const k of Object.keys(b)) if (!['version', 'approvedAccountIds', 'customerCodePrefix'].includes(k)) invalid(k);
            if (!Number.isInteger(b.version) || Number(b.version) < 0 || Number(b.version) > 2147483646) invalid('version');
            if (!Array.isArray(b.approvedAccountIds)) invalid('approvedAccountIds');
            else {
              if (b.approvedAccountIds.length > 5 || new Set(b.approvedAccountIds).size !== b.approvedAccountIds.length) invalid('approvedAccountIds');
              b.approvedAccountIds.forEach((a, i) => { if (typeof a !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(a) || a.includes('\n')) invalid(`approvedAccountIds[${i}]`); });
            }
            if (b.customerCodePrefix !== null && (typeof b.customerCodePrefix !== 'string' || !/^[A-Z][A-Z0-9]{1,5}$/.test(b.customerCodePrefix) || b.customerCodePrefix.includes('\n'))) invalid('customerCodePrefix');
          }
          if (fields.length) return reply.code(422).send({ error: 'invalid', fields });
          return (await c.query('select pulse.handover_settings($1,$2,$3) settings', [b!.version, b!.approvedAccountIds, b!.customerCodePrefix])).rows[0].settings;
        });
      } catch (e) {
        const error = e as { code?: string; message?: string };
        if (error.code === '40001' && ['settings_changed', 'prefix_locked'].includes(error.message ?? ''))
          return reply.code(409).send({ error: error.message });
        throw e;
      }
    } });
}

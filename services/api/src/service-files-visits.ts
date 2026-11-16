import type { FastifyInstance } from 'fastify';
import { withServiceKey } from './service-key.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const missing = (what: string) => Object.assign(new Error(`${what} not found`), { statusCode: 404 });
const checked = (value: string, what: string) => { if (!UUID.test(value)) throw missing(what); return value; };

/** WL-PROMISES (msg 171): an install key's reads of an issued quotation's filed PDF and of site visits. The definer
 *  functions (1610) re-check the key and scope and return only their allowlisted fields. */
export function registerServiceFilesVisits(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/v1/service/files/documents/:id/pdf', { exposeHeadRoute: false }, async (request, reply) => {
    const file = await withServiceKey(request, reply, 'files.read', async (c, keyId) => {
      const row = (await c.query('select bytes,number from pulse.service_quotation_pdf($1,pulse.service_key_hash($1),$2)', [keyId, checked(request.params.id, 'Document')])).rows[0];
      if (!row) throw missing('Document');
      return row as { bytes: Buffer; number: string | null };
    });
    if (reply.sent || !file || !('bytes' in file)) return file;
    const name = String(file.number ?? 'quotation').replace(/[^A-Za-z0-9-]+/g, '-');
    return reply.type('application/pdf').header('content-disposition', `attachment; filename="${name}.pdf"`).send(file.bytes);
  });
  app.get<{ Params: { id: string } }>('/api/v1/service/customers/:id/site-visits', { exposeHeadRoute: false }, (request, reply) =>
    withServiceKey(request, reply, 'site_visits.read', async (c, keyId) =>
      (await c.query('select pulse.service_site_visits($1,pulse.service_key_hash($1),$2) r', [keyId, checked(request.params.id, 'Customer')])).rows[0].r));
  app.get<{ Params: { id: string } }>('/api/v1/service/site-visits/:id', { exposeHeadRoute: false }, (request, reply) =>
    withServiceKey(request, reply, 'site_visits.read', async (c, keyId) => {
      const visit = (await c.query('select pulse.service_site_visit($1,pulse.service_key_hash($1),$2) r', [keyId, checked(request.params.id, 'Site visit')])).rows[0].r;
      if (!visit) throw missing('Site visit');
      return visit;
    }));
}

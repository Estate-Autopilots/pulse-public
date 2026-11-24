import { createHash, randomUUID } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { fail, work, type Tx } from './routes.js';
import { loadKeyring, seal, open } from './document-keys.js';

const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const validator = new Ajv2020({ strict: true, coerceTypes: false, removeAdditional: false });
validator.addFormat('date-time', s => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s.slice(0,10)).toISOString().slice(0,10) === s.slice(0,10));
const body = { type: 'object', additionalProperties: false, required: ['requestKey','mime','data'], properties: {
  requestKey: uuid, mime: { enum: ['image/jpeg','image/png','image/webp'] },
  data: { type: 'string', minLength: 4, maxLength: 6666668 },
  takenAt: { type: 'string', format: 'date-time' }, source: { enum: ['upload','camera'] },
} };
const params = { type: 'object', additionalProperties: false, required: ['lead'], properties: { lead: uuid } };
// Compile once; handlers validate only after tx authenticates and work() checks the viewer's role.
const validLead = validator.compile(params);
const validMedia = validator.compile({ ...params, required: ['lead','media'], properties: { lead: uuid, media: uuid } });
const validUpload = validator.compile(body);
type Upload = { requestKey: string; mime: string; data: string; takenAt?: string; source?: 'upload' | 'camera' };
const context = (org: string, lead: string, media: string) => `${org}/lead/${lead}/media/${media}`;
const keyring = async () => { const state = await loadKeyring(); return state.ok ? state.ring : fail(503, 'Private photo encryption is unavailable'); };

export async function normalizeLeadPhoto(bytes: Buffer, mime: string) {
  if (!bytes.length || bytes.length > 5_000_000) return fail(400, 'Photos must be at most 5 MB');
  try {
    const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning' });
    const meta = await image.metadata();
    if (!['jpeg','png','webp'].includes(meta.format ?? '') || mime !== `image/${meta.format}` || (meta.pages ?? 1) > 1) throw new Error();
    // Decode and re-encode pixels: default output excludes EXIF, GPS, XMP and original file trailers.
    const { data, info } = await image.rotate().toColourspace('srgb').webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
    if (data.length > 5_000_000) throw new Error();
    return { data, width: info.width, height: info.height };
  } catch { return fail(400, 'Choose a valid JPEG, PNG or WebP photo under 5 MB and 16 megapixels'); }
}

export function registerLeadMedia(app: FastifyInstance, tx: Tx) {
  const path = '/api/v0/acquisition/leads/:lead/photos';
  app.get<{ Params: { lead: string } }>(path, req => tx(req, async (c, v) => {
    work(v);
    if (!validLead(req.params)) return fail(400, 'Choose a valid lead photo record');
    return { photos: (await c.query('select pulse.acq_media_list($1) photos', [req.params.lead])).rows[0].photos };
  }));
  app.post<{ Params: { lead: string }; Body: Upload }>(path, {
    bodyLimit: 6_668_000,
  }, req => tx(req, async (c, v) => {
    work(v);
    if (!validLead(req.params)) return fail(400, 'Choose a valid lead photo record');
    if (!validUpload(req.body)) return fail(400, 'Choose a valid lead photo upload');
    const lead = req.params.lead, p = req.body;
    await c.query('select pulse.acq_media_require($1)', [lead]);
    const raw = Buffer.from(p.data, 'base64'), takenAt = p.takenAt ? new Date(p.takenAt).toISOString() : null, source = p.source ?? 'upload';
    if (!raw.length || raw.length > 5_000_000 || raw.toString('base64') !== p.data) return fail(400, 'Choose a base64 photo under 5 MB');
    const requestHash = createHash('sha256').update(raw).update(JSON.stringify([p.mime, takenAt, source])).digest('hex');
    const old = (await c.query('select pulse.acq_media_retry($1,$2,$3) photo', [lead, p.requestKey, requestHash])).rows[0].photo;
    if (old) return old;
    const photo = await normalizeLeadPhoto(raw, p.mime), media = randomUUID();
    const sealed = seal(await keyring(), photo.data, context(v.org, lead, media));
    return (await c.query('select pulse.acq_media_add($1,$2,$3,$4,$5,$6) photo', [lead, {
      id: media, requestKey: p.requestKey, requestHash, source, takenAt, width: photo.width, height: photo.height,
      size: photo.data.length, keyId: sealed.keyId,
    }, sealed.dataKey, sealed.data, p.requestKey, requestHash])).rows[0].photo;
  }));
  app.get<{ Params: { lead: string; media: string } }>(path + '/:media', async (req, reply) => {
    const bytes = await tx(req, async (c, v) => {
      work(v);
      if (!validMedia(req.params)) return fail(400, 'Choose a valid lead photo record');
      const row = (await c.query('select * from pulse.acq_media_read($1,$2)', [req.params.lead, req.params.media])).rows[0];
      return open(await keyring(), { keyId: row.key_id, dataKey: row.data_key, data: row.bytes }, context(v.org, req.params.lead, req.params.media));
    });
    return reply.type('image/webp').header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'inline; filename="site-photo.webp"').send(bytes);
  });
}

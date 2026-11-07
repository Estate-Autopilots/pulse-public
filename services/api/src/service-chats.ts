import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FastifyInstance } from 'fastify';
import { withServiceKey } from './service-key.js';

const validator = new Ajv2020({ strict: false });
type Payload = { text: string; image?: { name: string; mime: string; bytes: string } };
export function registerServiceChats(app: FastifyInstance) {
  app.post<{ Params: { chatId: string }; Body: Payload }>('/api/v1/service/chats/:chatId/messages', {
    bodyLimit: 3 * 1024 * 1024, validatorCompiler: ({ schema }) => validator.compile(schema),
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: { type: 'string', pattern: '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$' } } },
      body: { type: 'object', additionalProperties: false, required: ['text'], properties: {
        text: { type: 'string', minLength: 1, maxLength: 12000 },
        image: { type: 'object', additionalProperties: false, required: ['name','mime','bytes'], properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 }, mime: { type: 'string', enum: ['image/png','image/jpeg'] }, bytes: { type: 'string' },
        } },
      } },
    },
  }, (request, reply) => withServiceKey(request, reply, 'chats.post', async (c, keyId) => {
    const slot = request.headers['idempotency-key'], { text, image } = request.body;
    if (typeof slot !== 'string' || !/^\d{4}-\d{2}-\d{2}-(am|pm)$/.test(slot) || !Number.isFinite(Date.parse(slot.slice(0,10))) ||
      new Date(slot.slice(0,10)).toISOString().slice(0,10) !== slot.slice(0,10) || slot.startsWith('0000-') || !text.trim()) {
      throw Object.assign(new Error('Use a real date slot YYYY-MM-DD-am or YYYY-MM-DD-pm and nonempty text'), { statusCode: 400 });
    }
    let bytes: Buffer | null = null;
    if (image) {
      bytes = Buffer.from(image.bytes,'base64');
      if (bytes.toString('base64') !== image.bytes) throw Object.assign(new Error('Invalid base64 image'), { statusCode: 400 });
      if (bytes.length > 2 * 1024 * 1024) throw Object.assign(new Error('Image limit is 2 MiB'), { statusCode: 413 });
      const magic = image.mime === 'image/png' ? Buffer.from('89504e470d0a1a0a','hex') : Buffer.from('ffd8ff','hex');
      if (!bytes.subarray(0,magic.length).equals(magic)) throw Object.assign(new Error('Image type does not match its bytes'), { statusCode: 400 });
    }
    const result = (await c.query('select pulse.service_chat_post($1,$2,$3,$4,$5,$6,$7) result',
      [keyId,request.params.chatId,slot,text,image?.name ?? null,image?.mime ?? null,bytes])).rows[0].result;
    reply.code(result.replayed ? 200 : 201); return result;
  }));
}

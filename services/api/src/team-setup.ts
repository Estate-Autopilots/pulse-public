import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fail, sessionHash, type Open, type Tx } from './routes.js';

// ONBOARD (owner, 26 Oct 2026): the public team setup page (/team-setup) and HR → Onboard team → Team setup.
// Public: the team code (shared by the admin in the team's WhatsApp group), the person's name, and their company Google
// address or (no account yet) a personal e-mail and WhatsApp number. Limited per address and per code; no captcha; no
// list of names ever comes back, only the one Workspace address that matches the name typed. Nothing is sent to anyone.
const ERRORS: Record<string, string> = {
  code: 'That team code isn’t right. Ask your admin for the current code (it’s in the team’s WhatsApp group).',
  closed: 'Team setup is closed right now. Ask your admin.',
  name: 'Type your full name (first and last).',
  email: 'Type your company e-mail address.',
  personal: 'Type a personal e-mail address you can open.',
  personal_is_company: 'That is a company address. If you have one, answer Yes above; otherwise type a personal e-mail.',
  whatsapp: 'Type your WhatsApp number with the country code, for example +91 followed by 10 digits.',
  full: 'Team setup has too many open requests right now. Ask your admin.',
};
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const code = { type: 'string', minLength: 1, maxLength: 24 } as const, name = { type: 'string', minLength: 1, maxLength: 120 } as const;
const checkBody = { type: 'object', additionalProperties: false, required: ['code', 'name'], properties: { code, name } } as const;
const submitBody = { type: 'object', additionalProperties: false, required: ['code', 'name', 'hasGoogle'], properties: { code, name, hasGoogle: { type: 'boolean' },
  email: { type: 'string', maxLength: 254 }, personalEmail: { type: 'string', maxLength: 254 }, whatsapp: { type: 'string', maxLength: 32 } } } as const;
// No required fields: the database checks the role first (403), then what was asked (400 / 404).
const adminBody = { type: 'object', additionalProperties: false, properties: {
  action: { enum: ['rotate', 'enable', 'disable', 'domain', 'directory', 'decide'] }, domain: { type: 'string', maxLength: 253 },
  accounts: { type: 'array', maxItems: 5000, items: { type: 'object', additionalProperties: false, required: ['email'], properties: {
    email: { type: 'string', maxLength: 254 }, givenName: { type: 'string', maxLength: 120 }, familyName: { type: 'string', maxLength: 120 }, suspended: { type: 'boolean' } } } },
  id: { type: 'string', pattern: UUID }, decision: { enum: ['use-email', 'done', 'dismiss', 'reopen'] }, personId: { type: 'string', pattern: UUID }, email: { type: 'string', maxLength: 254 } } } as const;
type Check = { code: string; name: string };
type Submit = Check & { hasGoogle: boolean; email?: string; personalEmail?: string; whatsapp?: string };
type Admin = { action?: string; domain?: string; accounts?: unknown[]; id?: string; decision?: string; personId?: string; email?: string };

export function registerTeamSetupRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  const ip = (req: FastifyRequest) => String(req.headers['x-pulse-client-ip'] ?? req.ip);
  const codeKey = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Per address (a person types the code, then answers: a few tries each) and per code (the whole team signing up at once).
  const allowed = (req: FastifyRequest, kind: string, perAddress: number, c: string) => open(async db =>
    (await db.query('select pulse.auth_allow($1,$2) a, pulse.auth_allow($3,$4) b', [sessionHash(`team-setup-${kind}:${ip(req)}`), perAddress, sessionHash(`team-setup-code:${codeKey(c)}`), 300])).rows[0]);
  const refuse = (r: { error?: string; domain?: string }) => {
    if (r.error === 'domain') fail(400, `Use your @${r.domain} address, or answer No if you don’t have one.`);
    if (r.error) fail(400, ERRORS[r.error] ?? 'Please check what you typed.');
  };
  app.post<{ Body: Check }>('/api/v0/auth/team-setup-check', { schema: { body: checkBody } }, async req => {
    const ok = await allowed(req, 'check', 30, req.body.code);
    if (!ok.a || !ok.b) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const r = await open(async c => (await c.query('select pulse.team_setup_check($1,$2) d', [req.body.code, req.body.name])).rows[0].d);
    refuse(r);
    return { domain: r.domain ?? null, suggestion: r.suggestion ?? null };
  });
  app.post<{ Body: Submit }>('/api/v0/auth/team-setup', { schema: { body: submitBody } }, async req => {
    const ok = await allowed(req, 'send', 10, req.body.code);
    if (!ok.a || !ok.b) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const r = await open(async c => (await c.query('select pulse.team_setup_submit($1) d', [JSON.stringify(req.body)])).rows[0].d);
    refuse(r);
    return { ok: true };
  });
  // HR → Onboard team → Team setup (admins and HR; the database checks the role).
  app.get('/api/v0/hr/team-setup', req => tx(req, async c => (await c.query('select pulse.team_setup_state() d')).rows[0].d));
  app.post<{ Body: Admin }>('/api/v0/hr/team-setup', { schema: { body: adminBody } }, req => tx(req, async c => {
    const { action, decision, ...rest } = req.body ?? {};
    return (await c.query('select pulse.team_setup_admin($1,$2) d', [action ?? '', JSON.stringify(action === 'decide' ? { ...rest, action: decision ?? '' } : rest)])).rows[0].d;
  }));
}

import { randomBytes } from 'node:crypto';
import { currentMailBrand } from './brand.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, sessionHash, type Tx } from './routes.js';
import { googleBridge } from './google.js';
import { companyOrigin, hostCompany } from './tenant-context.js';
import { googleInvitable, googleInviteBody } from './account-security.js';
import { readGooglePolicy } from './google-sign-in.js';
import { platformMail } from './platform-config.js';

type Invitation = { personId: string; name: string; username: string; recipient: string | null; status: string; reason: string | null; batchId: string; expiresAt: string | null };
export const startGuide = 'Open Pulse on your phone or laptop. Set a password only you know, then sign in with your username. Start on Dashboard, check your People profile and My desk, and open Chats to talk to your team. Keep the link private. Forgot your password or username? Use the links on Sign in. For HR: a person’s profile → Account access has Resend invitation, Send password reset link, a one-time sign-in link and Unlock. Ask HR if your profile needs a correction.';
/** ONBOARD: the guide after a Continue with Google invitation (no password or username to remember). */
export const googleGuide = 'Start on Dashboard, check your People profile and My desk, and open Chats to talk to your team. Keep the link private. Ask HR if your profile needs a correction.';
export function registerInvitationRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // DE-EA: the install's sender (platform-config.ts); googleBridge refuses to send without one.
  const mailFrom = () => platformMail().mailFrom ?? '';
  // PEOPLE-CONTACTS (any company can onboard): the subject and sign-off carry the organisation's own name.
  const orgName = async (c: PoolClient) => String((await c.query('select name from pulse.org where id=pulse.current_org()')).rows[0]?.name ?? 'Pulse');
  const preview = async (req: Parameters<Tx>[0]) => tx(req, async c => ({ invitations: (await c.query('select pulse.invitation_preview() rows')).rows[0].rows,
    from: mailFrom(), subject: `Your ${await orgName(c)} Pulse account`, guide: startGuide,
    sendEnabled: process.env.PULSE_GMAIL_SEND_ENABLED === '1' && !hostCompany(), linkNotice: 'Each email gets its own one-time set-password link when sent. It expires after 7 days.' }));
  app.get('/api/v0/admin/invitations', preview);
  app.post('/api/v0/admin/invitations/prepare', req => tx(req, async c => {
    const batchId = (await c.query('select pulse.invitation_prepare() id')).rows[0].id;
    return { batchId, invitations: (await c.query('select pulse.invitation_preview() rows')).rows[0].rows };
  }));
  app.post<{ Body: { personId?: string; batchId?: string; confirmed?: boolean } }>('/api/v0/admin/invitations/link', req => tx(req, async c => {
    const rows: Invitation[] = (await c.query('select pulse.invitation_preview() rows')).rows[0].rows;
    const row = rows.find(r => r.personId === req.body?.personId && r.batchId === req.body?.batchId && r.status === 'prepared');
    if (!row) fail(409, 'Preview the current invitation before preparing its link');
    if(req.body.confirmed!==true)fail(400,'Confirm private delivery after checking identity');
    const token = randomBytes(32).toString('base64url');
    await c.query('select pulse.invitation_link($1,$2,$3)', [row!.personId, row!.batchId, sessionHash(token)]);
    const url = new URL('/login/set-password', companyOrigin());
    url.hash = token;
    return { username: row!.username, link: url.href, expiresInDays: 7 };
  }));
  // PRESENCE-ONBOARD: HR's Onboard team view may send to the people it selected (personIds); nothing is sent until pressed.
  app.post<{ Body: { batchId?: string; personIds?: string[] } }>('/api/v0/admin/invitations/send', async req => {
    const rows: Invitation[] = await tx(req, async c => (await c.query('select pulse.invitation_preview() rows')).rows[0].rows);
    if (process.env.PULSE_GMAIL_SEND_ENABLED !== '1') fail(403, 'Email sending needs verified Google permissions');
    // UX-TENANT: the install's mailbox writes for the install's own company only; another company needs its own sender.
    if (hostCompany()) fail(403, 'This company has no e-mail sender of its own yet. Use "Prepare link" to hand each person a private link.');
    const only = Array.isArray(req.body?.personIds) ? new Set(req.body.personIds.map(String)) : null;
    const selected = rows.filter(r => r.batchId === req.body?.batchId && r.status === 'prepared' && (!only || only.has(r.personId)));
    const org = await tx(req, async c => orgName(c)), policy = await tx(req, readGooglePolicy);
    if (!selected.length) fail(409, 'Preview the current invitation list before sending');
    let sent = 0, failed = 0;
    for (const row of selected) {
      const token = randomBytes(32).toString('base64url');
      const recipient = await tx(req, async c => (await c.query('select pulse.invitation_start($1,$2,$3) recipient', [row.personId, row.batchId, sessionHash(token)])).rows[0].recipient);
      let ok = false;
      try {
        const url = new URL('/login/set-password', companyOrigin());
        url.hash = token; // fragments do not enter HTTP access logs or Referer headers
        const brand = await currentMailBrand();
        // ONBOARD: an invitation to an allowed Workspace address is accepted with Continue with Google (no password).
        const how = new URL('/login/how', companyOrigin()).href;
        await googleBridge('send', { subject: mailFrom(), from: mailFrom(), to: recipient, title: `Your ${org} Pulse account`, ...(brand ? { brand } : {}),
          body: googleInvitable(policy, recipient) ? `${googleInviteBody(String(recipient), url.href, row.name)}\n\n${googleGuide}\n\n${org} HR`
            : `Hello ${row.name},\n\nYour Pulse username: ${row.username}\n\nSet your password: ${url.href}\n\nThis private link can be used once and expires in 7 days. No password is included in this email.\n\n${startGuide}\n\nHow you get into Pulse: ${how}\n\n${org} HR` });
        ok = true; sent++;
      } catch { failed++; }
      await tx(req, async c => c.query('select pulse.invitation_finish($1,$2)', [row.personId, ok]));
    }
    return { sent, failed };
  });
}

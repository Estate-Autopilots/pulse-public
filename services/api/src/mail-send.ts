// MAIL-IDENTITY: the one place the API sends Pulse's own e-mail. It works out which company the mail is for, picks the
// sender (mail-identity.ts), lays the message out (mail-template.ts: HTML and plain text) and hands it to the provider
// the sender belongs to: Resend for the platform's address (mail-provider.ts), the install's Google/SMTP bridge for the
// install's sender (google.ts), or the company's own connected mailbox (mailbox.ts). The guards are the ones that were
// already in front of every send: CI and tests only ever reach the sink (testMail / testCompanyMail), nothing goes out
// unless PULSE_GMAIL_SEND_ENABLED=1, and a non-production host mails only its staging allow-list.
// MAIL-GUARD (5 Nov 2026): that last rule now stands at the top of sendMail, before any route is chosen, so a
// company's connected mailbox on staging (a copy of real company data) can no more reach a client than Resend can.
import type { PoolClient } from 'pg';
import { googleBridge } from './google.js';
import { chooseSender, type MailKind, type OrgMail, type Sender } from './mail-identity.js';
import { renderMail } from './mail-template.js';
import { mailFiles, resendSend, type MailFile } from './mail-provider.js';
import { attachmentNotes, companyMail, hostedMailCompany, mailboxReader, type AttachmentNote } from './mailbox.js';
import { mailRecipientAllowed, platformConfig } from './platform-config.js';
import { hostCompany } from './tenant-context.js';

export type SentMail = { from: string; to: string; title: string; body: string; replyTo?: string; fromName?: string;
  kind?: MailKind; route?: Sender['route']; brand?: Sender['brand']; text?: string; html?: string; attachments?: AttachmentNote[] };
/** Tests read what would have gone out (CI and the sink never reach a provider). */
export const testMail: SentMail[] = [];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const mailSink = () => process.env.PULSE_CI === '1' || process.env.NODE_ENV === 'test' || process.env.PULSE_AUTH_MAIL_MODE === 'sink';
export const mailSwitchOn = () => process.env.PULSE_GMAIL_SEND_ENABLED === '1';

/** A non-production host mails only its staging allow-list (platform-config.ts mailRecipientAllowed: the one rule
 *  google.ts and mailbox.ts use too). */
export function recipientAllowed(to: string, env: NodeJS.ProcessEnv = process.env) {
  return mailRecipientAllowed(to, env);
}

/** What the guard refused (tests read it; the log line names the kind and the recipient's domain only). */
export const refusedMail: { kind: MailKind; domain: string }[] = [];
function refuse(kind: MailKind, to: string) {
  const domain = to.slice(to.lastIndexOf('@') + 1).toLowerCase();
  refusedMail.push({ kind, domain });
  if (refusedMail.length > 200) refusedMail.shift();
  console.warn(JSON.stringify({ msg: 'mail refused: not production and the recipient is not on PULSE_MAIL_STAGING_ALLOW', kind, domain }));
}

type Run = <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>;
type Identity = OrgMail & { logoPng: string | null };
/** The company the mail is for, read inside it (pulse.org_mail_identity, migration 1530); null when unknown. */
export async function readOrgMail(run: Run | null): Promise<Identity | null> {
  if (!run) return null;
  const r = await run(async (c) => (await c.query('select pulse.org_mail_identity() m')).rows[0]?.m as Record<string, unknown> | null).catch(() => null);
  if (!r || typeof r.org !== 'string') return null;
  const s = (x: unknown) => typeof x === 'string' && x ? x : null;
  return { org: r.org, name: s(r.name) ?? 'Your company', install: r.install === true, mailbox: s(r.mailbox), replyTo: s(r.replyTo), logoPng: s(r.logoPng) };
}

export type MailRequest = { kind: MailKind; to: unknown; title: string; body: string; signOff?: string | null;
  /** The company the mail is for; omitted: the request's own company when it is not the install's (platform mail) or
   *  the request's company, install included (organisation mail). */
  org?: Identity | null;
  /** Client mail (client-mail.ts): the install's own client sender and its Reply-To instead of the HR mailbox. */
  installSender?: { from: string; fromName?: string; replyTo?: string };
  /** BILLING-EMAIL: files sent with it (a document's PDF; mail-provider.ts mailFiles). */
  attachments?: MailFile[];
  within?: Run };

async function requestOrg(kind: MailKind, within?: Run): Promise<Identity | null> {
  const hosted = hostedMailCompany();
  // Platform mail on the install's own addresses (and on the platform's, e.g. sign-up) is about no company.
  if (kind === 'platform' && !hosted) return null;
  const reader = mailboxReader();
  return readOrgMail(within ?? (reader ? (fn) => reader((c) => fn(c)) : null));
}

/** Send one e-mail; true when it was accepted (or recorded by the sink). Never throws. */
export async function sendMail(m: MailRequest): Promise<boolean> {
  if (typeof m.to !== 'string' || !EMAIL.test(m.to.trim())) return false;
  const to = m.to.trim();
  // MAIL-GUARD: one guard for every route (company mailbox, Resend, the install's bridge). The sink never reaches a
  // provider, so it still records; anything else off production goes only to the allow-list.
  if (!mailSink() && !mailRecipientAllowed(to)) { refuse(m.kind, to); return false; }
  let org = m.org !== undefined ? m.org : await requestOrg(m.kind, m.within);
  // A sender of the install's own (client mail, the operator's setup invitations) speaks for the install's company.
  if (m.installSender && !org && m.kind === 'org') org = { org: 'install', name: m.installSender.fromName ?? platformConfig().product, install: true, mailbox: null, replyTo: null, logoPng: null };
  const sender = chooseSender(m.kind, org);
  if (m.installSender && (sender.route === 'install' || (sender.route === 'none' && (!org || org.install)))) {
    Object.assign(sender, { route: 'install', from: m.installSender.from, fromName: m.installSender.fromName ?? sender.fromName, replyTo: m.installSender.replyTo ?? null });
  }
  const look = { brand: sender.brand, orgName: sender.orgName, orgLogoPng: sender.brand === 'org' ? org?.logoPng ?? null : null, product: platformConfig().product };
  const mail = renderMail({ title: m.title, body: m.body, signOff: m.signOff }, look);
  const files = mailFiles(m.attachments);
  // A company's own mailbox (or none connected: counted for its admin, as before).
  if (sender.route === 'mailbox' || (sender.route === 'none' && org && !org.install)) {
    return (await companyMail(org!.org, to, m.title, mail.text, m.within, { html: mail.html, inline: mail.inline, replyTo: sender.replyTo, attachments: files }).catch(() => 'failed')) === 'sent';
  }
  // The install's sender belongs to the install's addresses only (UX-TENANT).
  if (sender.route === 'install' && hostCompany()) return false;
  if (mailSink()) {
    testMail.push({ from: sender.from ?? 'pulse@mail.invalid', to, title: m.title, body: m.body, fromName: sender.fromName, kind: m.kind, route: sender.route, brand: sender.brand,
      text: mail.text, html: mail.html, ...(sender.replyTo ? { replyTo: sender.replyTo } : {}), ...(files.length ? { attachments: attachmentNotes(files) } : {}) });
    return true;
  }
  if (!mailSwitchOn() || !sender.from || sender.route === 'none') return false;
  const args = { from: sender.from, fromName: sender.fromName, replyTo: sender.replyTo ?? undefined, to, title: m.title, body: mail.text, html: mail.html, inline: mail.inline, attachments: files };
  try {
    if (sender.route === 'resend') {
      if (!recipientAllowed(to)) return false;
      await resendSend(args);
    } else {
      // googleBridge('send') enforces the configured production host and the non-production allow-list itself.
      // The bridge (tools/google-bridge.py) takes one file as `attachment`.
      const { attachments, ...rest } = args;
      await googleBridge('send', { subject: sender.from, ...rest, ...(attachments[0] ? { attachment: { name: attachments[0].filename, mime: attachments[0].contentType, bytes: attachments[0].base64 } } : {}) });
    }
    return true;
  } catch { return false; }
}


// MAIL-IDENTITY (owner, 4 Nov 2026): the owner signed up the new "Vitals Technologies" organisation on app.vitalsos.ai
// and the sign-in code came from hr@estateautopilots.com, with the Estate Autopilots logo and "Sent by Pulse for Estate
// Autopilots". Who an e-mail is from is now chosen in layers, by what kind of mail it is and whose company it is for:
//
//   platform mail (codes, sign-up, invitations into a new organisation, account notices): from the platform's sender,
//     "Pulse by Vitals" <no-reply@org-9912dc.example> (PULSE_PLATFORM_MAIL_FROM), with Pulse branding, never a company's logo.
//     It goes through Resend (RESEND_API_KEY). Without Resend the existing provider is the fallback: the install's own
//     sender (PULSE_MAIL_FROM) under the name "Pulse by Vitals" on the install's addresses, or a company's connected
//     mailbox on that company's address (as before); none of those, nothing is sent.
//     In a company's context it answers to the company (Reply-To) and says which company it is about.
//   organisation mail (HR, leave, payslips, approvals): the company's name and logo, from its own sender when it has
//     connected one (Settings → Mail), else from the platform's address as "<Company> via Pulse" with Reply-To the
//     company (Resend only; without Resend it waits for the mailbox, as before). The install's company (Estate
//     Autopilots on this server) keeps its configured sender, PULSE_MAIL_FROM, for its own mail only.
//
// Pure: no environment beyond the one passed in, no database, so the choice is tested per kind and per company.
import { platformSender, resendConfigured } from './mail-provider.js';
import { platformMail } from './platform-config.js';

export type MailKind = 'platform' | 'org';
/** What is known about the company the mail is for (null: none, e.g. sign-up on the platform's own address). */
export type OrgMail = { org: string; name: string; install: boolean; mailbox: string | null; replyTo: string | null };
export type MailRoute = 'resend' | 'install' | 'mailbox' | 'none';
export type Sender = { kind: MailKind; route: MailRoute; from: string | null; fromName: string; replyTo: string | null;
  /** Whose look the e-mail has: Pulse's, or the company's name and logo. */ brand: 'pulse' | 'org'; orgName: string | null };

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const name = (x: string | null | undefined) => String(x ?? '').replace(/[\r\n"<>\\]/g, '').trim().slice(0, 60);
const address = (x: string | null | undefined) => { const a = String(x ?? '').trim().toLowerCase(); return EMAIL.test(a) ? a : null; };

export function chooseSender(kind: MailKind, org: OrgMail | null, env: NodeJS.ProcessEnv = process.env): Sender {
  const platform = platformSender(env);
  const resend = resendConfigured(env);
  const installFrom = platformMail(env).mailFrom;
  const company = org ? { ...org, name: name(org.name) || 'Your company', mailbox: address(org.mailbox), replyTo: address(org.replyTo) } : null;
  const hosted = company && !company.install ? company : null;
  const none = (brand: Sender['brand']): Sender => ({ kind, route: 'none', from: null, fromName: platform.name, replyTo: null, brand, orgName: company?.name ?? null });

  if (kind === 'platform') {
    // Answers go to the company the mail is about (its own mailbox, else its admin), never to no-reply.
    const replyTo = hosted ? hosted.mailbox ?? hosted.replyTo : null;
    const base = { kind, brand: 'pulse' as const, orgName: hosted?.name ?? null };
    if (resend) return { ...base, route: 'resend', from: platform.address, fromName: platform.name, replyTo };
    if (hosted) return hosted.mailbox ? { ...base, route: 'mailbox', from: hosted.mailbox, fromName: hosted.name, replyTo: null } : none('pulse');
    return installFrom ? { ...base, route: 'install', from: installFrom, fromName: platform.name, replyTo: null } : none('pulse');
  }
  // Organisation mail.
  if (!company) return chooseSender('platform', null, env);
  const base = { kind, brand: 'org' as const, orgName: company.name };
  if (company.install) return installFrom ? { ...base, route: 'install', from: installFrom, fromName: company.name, replyTo: null } : none('org');
  if (company.mailbox) return { ...base, route: 'mailbox', from: company.mailbox, fromName: company.name, replyTo: null };
  if (resend) return { ...base, route: 'resend', from: platform.address, fromName: `${company.name} via Pulse`, replyTo: company.replyTo };
  return none('org');
}

/** The From line as a person reads it ("Name" <address>), for tests and the sink. */
export const fromLine = (s: Pick<Sender, 'from' | 'fromName'>) => s.from ? `"${s.fromName}" <${s.from}>` : '';

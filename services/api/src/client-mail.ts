// PORTAL-2 (owner, 25 Oct 2026): e-mail to clients goes from its own sender, never the HR mailbox. The address is
// PULSE_CLIENT_MAIL_FROM (decision portal-client-mail-from), else admin@ of the Google domain the bridge sends for; the
// display name is the company's name and Reply-To is the client's contact at the company, so an answer reaches a
// person. Sending needs the same switch as every other mail (PULSE_GMAIL_SEND_ENABLED); CI and tests use the sink.
// Nothing here sends on its own except the digest a client turned on themselves.
import type { Pool } from 'pg';
import { testMail } from './auth-mail.js';
import { currentMailBrand } from './brand.js';
import { googleBridge } from './google.js';
import { hostCompany } from './tenant-context.js';

const MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sink = () => process.env.PULSE_CI === '1' || process.env.NODE_ENV === 'test' || process.env.PULSE_AUTH_MAIL_MODE === 'sink';
export const clientMailAvailable = () => sink() || (process.env.PULSE_GMAIL_SEND_ENABLED === '1' && !hostCompany());
/** The client sender: its own setting, else admin@ of the bridge's Google domain. Never the HR mailbox. */
export function clientMailFrom() {
  const set = process.env.PULSE_CLIENT_MAIL_FROM?.trim().toLowerCase();
  if (set && MAIL.test(set)) return set;
  return `admin@${(process.env.PULSE_GOOGLE_DOMAIN?.trim() || 'estateautopilots.com').toLowerCase()}`;
}

export type ClientMail = { to: unknown; subject: string; body: string; company?: string | null; replyTo?: string | null };
export async function clientMail(m: ClientMail): Promise<boolean> {
  if (typeof m.to !== 'string' || !MAIL.test(m.to) || hostCompany() || !clientMailAvailable()) return false;
  const from = clientMailFrom();
  const replyTo = m.replyTo && MAIL.test(m.replyTo) ? m.replyTo : undefined;
  const fromName = (m.company ?? '').replace(/[\r\n"<>]/g, '').trim().slice(0, 80) || undefined;
  if (sink()) { testMail.push({ from, to: m.to, title: m.subject, body: m.body, replyTo, fromName }); return true; }
  try {
    const brand = await currentMailBrand();
    await googleBridge('send', { subject: from, from, fromName, replyTo, to: m.to, title: m.subject, body: m.body, ...(brand ? { brand } : {}) });
    return true;
  } catch { return false; }
}

const first = (name: string) => name.trim().split(/\s+/)[0] || 'there';

/** The account e-mails, in the client's words. `link` carries the token in its fragment. */
export function accountMail(kind: 'reset' | 'signin' | 'confirm', r: { name: string; org: string; handle?: string; minutes?: number }, link: string) {
  const who = `Hi ${first(r.name)},`;
  if (kind === 'signin') return { subject: `Your sign-in link for ${r.org} on Pulse`,
    body: `${who}\n\nPress this link to sign in to your space with ${r.org}:\n${link}\n\nIt works once, within ${r.minutes ?? 15} minutes, on the device where you open it. Your Pulse handle is @${r.handle}.\n\nDidn't ask for it? Ignore this e-mail: nobody can sign in without the link.` };
  if (kind === 'reset') return { subject: `Choose a new Pulse password`,
    body: `${who}\n\nSomeone (we hope you) asked to reset the password of your Pulse account @${r.handle}. Choose a new one here:\n${link}\n\nThe link works once, within ${r.minutes ?? 60} minutes. Your other devices are signed out when you change it.\n\nDidn't ask for it? Ignore this e-mail: your password stays as it is.` };
  return { subject: `Confirm your e-mail for Pulse`,
    body: `${who}\n\nConfirm this address for your Pulse account, to get sign-in links and your daily summary from ${r.org} here:\n${link}\n\nThe link works once, within 24 hours. Didn't ask for it? Ignore this e-mail.` };
}

export type DigestItem = { title: string; href: string; at: string };
/** The daily summary: what arrived since the last one, newest first, each with its link. */
export function digestMail(r: { name: string; org: string; items: DigestItem[] }, origin: string) {
  const items = r.items.slice(0, 20);
  const lines = items.map((i) => `• ${i.title}\n  ${new URL(i.href, origin).href}`);
  const more = r.items.length > items.length ? `\n…and ${r.items.length - items.length} more in your space.` : '';
  return {
    subject: items.length === 1 ? `${r.org}: ${items[0].title}` : `${r.org}: ${r.items.length} new things in your space`,
    body: `Hi ${first(r.name)},\n\nHere is what is new in your space with ${r.org} since yesterday:\n\n${lines.join('\n\n')}${more}\n\nOpen your space: ${new URL('/client', origin).href}\n\nYou get this summary once a day because you turned it on. Turn it off any time: ${new URL('/client?digest=off', origin).href}`,
  };
}

/** Send the digests due now (pulse.cp_digest_due claims them, once a day per person after 09:00 company time). */
export async function drainClientDigest(pool: Pool, origin = process.env.PULSE_PUBLIC_URL ?? 'https://pulse.estateautopilots.com') {
  if (!clientMailAvailable()) return { enabled: false, sent: 0 };
  const c = await pool.connect();
  let due: { to: string; name: string; org: string; replyTo: string | null; items: DigestItem[] }[] = [];
  try { await c.query('begin'); due = (await c.query('select pulse.cp_digest_due(20) d')).rows[0].d ?? []; await c.query('commit'); }
  catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
  let sent = 0;
  for (const d of due) { const mail = digestMail(d, origin); if (await clientMail({ to: d.to, subject: mail.subject, body: mail.body, company: d.org, replyTo: d.replyTo })) sent++; }
  return { enabled: true, sent, due: due.length };
}

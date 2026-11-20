// SELF-SERVE (owner, 4 Nov 2026; Kazuk's 3 Nov meeting: "Dhanashree's onboarding mail isn't reaching her… Resend") and
// MAIL-IDENTITY (owner, 4 Nov 2026: "platform mail must come from Vitals, company mail must carry the company's brand"):
// Pulse's own e-mails can go out through Resend instead of the Google bridge. The provider is chosen by the environment:
// RESEND_API_KEY set means Resend for every message from the platform's sender (PULSE_PLATFORM_MAIL_FROM, default
// "Pulse by Vitals" <no-reply@org-9912dc.example>; RESEND_FROM is read as an older name for it); absent, the current provider
// (PULSE_MAIL_TRANSPORT: google or smtp, from the install's sender) as before. Mail sent as a person's own mailbox
// (Finance, a flow's e-mail step) and the install company's own sender (PULSE_MAIL_FROM, Estate Autopilots' HR mailbox)
// always stay with Google. The same switch, sink and allow-list apply in front of either (mail-send.ts): tests and CI
// never reach a provider, and a non-production host mails only its allow-list. The key is never logged or echoed.
//
// The interface is the SELF-SERVE lane's (resendFor, resendRequest, resendSend, MailArgs), widened: an HTML part, inline
// images (a logo, by Content-ID) and a Reply-To.

export type InlineImage = { cid: string; filename: string; png: string };
/** BILLING-EMAIL (5 Nov 2026): a file sent with the message (a quotation's or invoice's PDF), base64. Only PDFs. */
export type MailFile = { filename: string; contentType: 'application/pdf'; base64: string };
export const MAX_MAIL_FILE = 8 * 1024 * 1024;
/** The files a message may carry: PDFs with a plain name, at most two and 8 MB each; anything else is left out. */
export function mailFiles(files: unknown): MailFile[] {
  if (!Array.isArray(files)) return [];
  return files.filter((f): f is MailFile => !!f && typeof f === 'object' && (f as MailFile).contentType === 'application/pdf' && typeof (f as MailFile).base64 === 'string'
    && /^[A-Za-z0-9+/=]+$/.test((f as MailFile).base64) && (f as MailFile).base64.length * 0.75 <= MAX_MAIL_FILE)
    .slice(0, 2).map((f) => ({ filename: clean(f.filename, 120).replace(/[^A-Za-z0-9._-]+/g, '-') || 'document.pdf', contentType: 'application/pdf', base64: f.base64 }));
}
export type MailArgs = { subject?: unknown; from?: unknown; fromName?: unknown; replyTo?: unknown; to?: unknown; title?: unknown; body?: unknown;
  html?: unknown; inline?: InlineImage[]; attachments?: MailFile[] };

export const DEFAULT_PLATFORM_SENDER = { name: 'Pulse by Vitals', address: 'no-reply@org-9912dc.example' };
const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const clean = (x: unknown, max: number) => String(x ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);

/** "Name <address>", "<address>" or "address" → its parts; null when the address is not one. */
export function parseSender(raw: unknown): { name: string; address: string } | null {
  const text = clean(raw, 300);
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>]+)>\s*$/.exec(text);
  const address = (m ? m[2] : text).trim().toLowerCase();
  if (!ADDRESS.test(address)) return null;
  return { name: (m?.[1] ?? '').replace(/["<>\\]/g, '').trim().slice(0, 80), address };
}

/** The platform's own sender: PULSE_PLATFORM_MAIL_FROM (or the older RESEND_FROM), else "Pulse by Vitals" <no-reply@org-9912dc.example>. */
export function platformSender(env: NodeJS.ProcessEnv = process.env): { name: string; address: string } {
  const set = parseSender(env.PULSE_PLATFORM_MAIL_FROM) ?? parseSender(env.RESEND_FROM);
  return set ? { name: set.name || DEFAULT_PLATFORM_SENDER.name, address: set.address } : { ...DEFAULT_PLATFORM_SENDER };
}

export const resendConfigured = (env: NodeJS.ProcessEnv = process.env) => !!(env.RESEND_API_KEY ?? '').trim();

/** Whether this send goes through Resend: a key is set and the sender is the platform's own. */
export function resendFor(args: MailArgs, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!resendConfigured(env)) return false;
  const sender = String(args.from ?? args.subject ?? '').trim().toLowerCase();
  return !!sender && sender === platformSender(env).address;
}

/** The request Resend gets (kept apart so tests check it without sending). */
export function resendRequest(args: MailArgs, env: NodeJS.ProcessEnv = process.env) {
  const to = clean(args.to, 254).toLowerCase();
  if (!ADDRESS.test(to)) throw new Error('Mail needs one valid recipient');
  const platform = platformSender(env);
  const own = clean(args.from ?? args.subject, 254).toLowerCase() || platform.address;
  if (own !== platform.address) throw new Error('Resend sends only from the platform sender');
  const name = clean(args.fromName, 80).replace(/["<>\\]/g, '') || platform.name;
  const replyTo = clean(args.replyTo, 254);
  const html = typeof args.html === 'string' && args.html ? args.html.slice(0, 400000) : null;
  const inline = (args.inline ?? []).filter((i) => i && /^[a-z0-9-]{1,40}$/.test(i.cid) && typeof i.png === 'string').slice(0, 4);
  const files = mailFiles(args.attachments).map((f) => ({ filename: f.filename, content: f.base64, content_type: f.contentType }));
  const attachments = [...(html ? inline.map((i) => ({ filename: clean(i.filename, 80) || `${i.cid}.png`, content: i.png, content_type: 'image/png', content_id: i.cid })) : []), ...files];
  return {
    url: 'https://api.resend.com/emails',
    init: { method: 'POST', headers: { authorization: `Bearer ${(env.RESEND_API_KEY ?? '').trim()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: `${name} <${own}>`, to: [to], subject: clean(args.title, 300) || 'Pulse', text: String(args.body ?? '').slice(0, 100000),
        ...(html ? { html } : {}), ...(ADDRESS.test(replyTo) ? { reply_to: replyTo } : {}),
        ...(attachments.length ? { attachments } : {}) }) },
  };
}

/** Send through Resend; the answer is the message id. Errors say only that the provider refused (never the key). */
export async function resendSend(args: MailArgs, send: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<{ id: string; sent: true }> {
  const { url, init } = resendRequest(args, env);
  let r: Response;
  try { r = await send(url, { ...init, signal: AbortSignal.timeout(15000) }); } catch { throw new Error('Mail provider unavailable'); }
  const data = await r.json().catch(() => ({})) as { id?: unknown };
  if (!r.ok || typeof data.id !== 'string') throw new Error(`Mail provider refused the message (${r.status})`);
  return { id: data.id, sent: true };
}

// PULSE-ADMIN (owner, 27 Oct 2026): who runs this Pulse, from the server's environment only. Pulse moves to its own
// company and domain later; that move is a change of these variables, never of code.
//   PULSE_PLATFORM_NAME      the product's name (default "Pulse")
//   PULSE_PLATFORM_COMPANY   the company that runs it (legal name shown in the console; default: unset)
//   PULSE_SUPPORT_EMAIL      where people write for help (default: unset)
//   PULSE_PLATFORM_DOMAIN    the product's own domain (default: the host of PULSE_PUBLIC_URL)
//   PULSE_BUG_TRIAGE_PATH    the bug-report triage page inside Pulse (default /bug-reports, the BUG-REPORT lane's triage page)
// DE-EA (owner, 28 Oct 2026: "make Pulse ready as a product for any company"): every address the server used to default
// to one company's is derived here, from the same variables, and is null (mail is not sent) when nothing is set:
//   PULSE_GOOGLE_DOMAIN      the install's Google Workspace domain (default: the platform domain without its first label,
//                            "pulse.example.com" → "example.com")
//   PULSE_MAIL_FROM          the install's sender for sign-in, invitation and notification mail (default: hr@ that domain,
//                            the Workspace mailbox the install has always sent from)
//   PULSE_CLIENT_MAIL_FROM   the sender of client mail (default: admin@ that domain)
//   PULSE_MAIL_PRODUCTION_HOST  the host that may mail anyone (default: the platform domain when PULSE_ENV=production;
//                            unset elsewhere, so a staging host mails only PULSE_MAIL_STAGING_ALLOW)
//   PULSE_MAIL_STAGING_ALLOW the addresses a non-production host may mail (default: the install's own two senders)

export type PlatformConfig = { product: string; company: string | null; supportEmail: string | null; domain: string | null; publicUrl: string | null; bugTriagePath: string };
export type PlatformMail = { /** The web origin people open (https://host, no trailing slash), or null. */ origin: string | null;
  mailDomain: string | null; mailFrom: string | null; clientMailFrom: string | null; mailProductionHost: string | null; mailStagingAllow: string[] };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function platformConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const clean = (x: string | undefined, max = 120) => (x ?? '').trim().slice(0, max) || null;
  const publicUrl = clean(env.PULSE_PUBLIC_URL, 300);
  let urlHost: string | null = null;
  try { urlHost = publicUrl ? new URL(publicUrl).hostname : null; } catch { urlHost = null; }
  const rawDomain = clean(env.PULSE_PLATFORM_DOMAIN, 253)?.toLowerCase() ?? urlHost;
  const domain = rawDomain && HOST.test(rawDomain) ? rawDomain : null;
  const support = clean(env.PULSE_SUPPORT_EMAIL, 200);
  const triage = clean(env.PULSE_BUG_TRIAGE_PATH, 200);
  return {
    product: clean(env.PULSE_PLATFORM_NAME, 60) ?? 'Pulse',
    company: clean(env.PULSE_PLATFORM_COMPANY),
    supportEmail: support && EMAIL.test(support) ? support : null,
    domain,
    publicUrl,
    bugTriagePath: triage && /^\/[A-Za-z0-9/_?=&.-]*$/.test(triage) ? triage : '/bug-reports',
  };
}

/** DE-EA: the install's web origin and mail addresses (see the variables above), derived from the same environment. */
export function platformMail(env: NodeJS.ProcessEnv = process.env): PlatformMail {
  const clean = (x: string | undefined, max = 120) => (x ?? '').trim().slice(0, max) || null;
  const { domain, publicUrl } = platformConfig(env);
  const email = (x: string | undefined) => { const e = clean(x, 200)?.toLowerCase(); return e && EMAIL.test(e) ? e : null; };
  const google = clean(env.PULSE_GOOGLE_DOMAIN, 253)?.toLowerCase();
  const mailDomain = google && HOST.test(google) ? google : domain && domain.split('.').length > 2 ? domain.split('.').slice(1).join('.') : domain;
  const mailFrom = email(env.PULSE_MAIL_FROM) ?? (mailDomain ? `hr@${mailDomain}` : null);
  const clientMailFrom = email(env.PULSE_CLIENT_MAIL_FROM) ?? (mailDomain ? `admin@${mailDomain}` : null);
  const prodHost = clean(env.PULSE_MAIL_PRODUCTION_HOST, 253)?.toLowerCase() ?? (env.PULSE_ENV === 'production' ? domain : null);
  const allow = env.PULSE_MAIL_STAGING_ALLOW !== undefined
    ? env.PULSE_MAIL_STAGING_ALLOW.split(',').map((a) => a.trim().toLowerCase()).filter((a) => EMAIL.test(a))
    : [mailFrom, clientMailFrom].filter((a): a is string => !!a);
  let origin: string | null = null;
  try { origin = publicUrl ? new URL(publicUrl).origin : domain ? `https://${domain}` : null; } catch { origin = domain ? `https://${domain}` : null; }
  return { origin, mailDomain, mailFrom, clientMailFrom, mailProductionHost: prodHost && HOST.test(prodHost) ? prodHost : null, mailStagingAllow: allow };
}

// PULSE-ADMIN (owner, 27 Oct 2026): who runs this Pulse, from the server's environment only. Pulse moves to its own
// company and domain later; that move is a change of these variables, never of code.
//   PULSE_PLATFORM_NAME      the product's name (default "Pulse")
//   PULSE_PLATFORM_COMPANY   the company that runs it (legal name shown in the console; default: unset)
//   PULSE_SUPPORT_EMAIL      where people write for help (default: unset)
//   PULSE_PLATFORM_DOMAIN    the product's own domain (default: the host of PULSE_PUBLIC_URL)
//   PULSE_BUG_TRIAGE_PATH    the bug-report triage page inside Pulse (default /bug-reports, the BUG-REPORT lane's triage page)

export type PlatformConfig = { product: string; company: string | null; supportEmail: string | null; domain: string | null; publicUrl: string | null; bugTriagePath: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function platformConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const clean = (x: string | undefined, max = 120) => (x ?? '').trim().slice(0, max) || null;
  const publicUrl = clean(env.PULSE_PUBLIC_URL, 300);
  let urlHost: string | null = null;
  try { urlHost = publicUrl ? new URL(publicUrl).hostname : null; } catch { urlHost = null; }
  const domain = clean(env.PULSE_PLATFORM_DOMAIN, 253)?.toLowerCase() ?? urlHost;
  const support = clean(env.PULSE_SUPPORT_EMAIL, 200);
  const triage = clean(env.PULSE_BUG_TRIAGE_PATH, 200);
  return {
    product: clean(env.PULSE_PLATFORM_NAME, 60) ?? 'Pulse',
    company: clean(env.PULSE_PLATFORM_COMPANY),
    supportEmail: support && EMAIL.test(support) ? support : null,
    domain: domain && HOST.test(domain) ? domain : null,
    publicUrl,
    bugTriagePath: triage && /^\/[A-Za-z0-9/_?=&.-]*$/.test(triage) ? triage : '/bug-reports',
  };
}

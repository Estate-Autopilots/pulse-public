// VITALS-HOSTS (owner, 4 Nov 2026: "move Pulse to vitalsos.ai", F3/F4 groundwork): the platform's own addresses come in
// families (PULSE_HOST_FAMILIES): app, api, mcp and id hosts served by one container, plus the install's own address
// (PULSE_PUBLIC_URL), which stays for good and behaves as before. The web decides which paths each host answers; the
// API needs a family for three things only:
//   - where a request's links and sign-in point (companyOrigin): a family's app or id host is its own sign-in origin,
//     so Google's callback, passkeys (WebAuthn's RP ID) and e-mailed links stay on the host the person is using;
//   - the OAuth issuer returned as `iss` (RFC 9207), which must equal the one the web's discovery names;
//   - whether the install's Google sign-in may start on this host (google-sign-in-flow.ts).
// The web's copy is apps/web/app/lib/host-families.mjs (test: test/host-families.test.mjs compares the two).

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export const ROLES = ['app', 'api', 'mcp', 'id'] as const;
export type HostRole = typeof ROLES[number];
type Family = { name: string; listed: boolean } & Record<HostRole, string | null>;
export type HostFamily = { name: string; listed: boolean; role: HostRole; host: string; self: string; app: string; issuer: string; mcp: string; signIn: string };
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

const bare = (raw: unknown) => typeof raw === 'string' ? raw.trim().toLowerCase().replace(/:\d{1,5}$/, '').replace(/\.$/, '') : '';
const portOf = (raw: unknown) => typeof raw === 'string' ? raw.trim().match(/:(\d{1,5})$/)?.[1] ?? null : null;
const local = (host: string) => host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');

let memo: { key: string | null; value: Family[] } = { key: null, value: [] };
/** The configured families, then the install's own; a host belongs to the first family that names it. Bad entries are skipped. */
export function hostFamilies(env: NodeJS.ProcessEnv = process.env): Family[] {
  const key = `${env.PULSE_HOST_FAMILIES ?? ''}\n${env.PULSE_PUBLIC_URL ?? ''}`;
  if (memo.key === key) return memo.value;
  let listed: unknown[] = [];
  try { const parsed = JSON.parse(env.PULSE_HOST_FAMILIES || '[]'); listed = Array.isArray(parsed) ? parsed : []; } catch { listed = []; }
  const seen = new Set<string>(), families: Family[] = [];
  for (const [i, f] of listed.entries()) {
    if (!f || typeof f !== 'object') continue;
    const given = f as Record<string, unknown>;
    const hosts = Object.fromEntries(ROLES.map(role => [role, typeof given[role] === 'string' && HOST.test(bare(given[role])) ? bare(given[role]) : null])) as Record<HostRole, string | null>;
    if (!hosts.app || ROLES.some(role => hosts[role] && seen.has(hosts[role]!))) continue;
    if (new Set(ROLES.map(r => hosts[r]).filter(Boolean)).size !== ROLES.filter(r => hosts[r]).length) continue;
    ROLES.forEach(role => hosts[role] && seen.add(hosts[role]!));
    families.push({ name: typeof given.name === 'string' && NAME.test(given.name) ? given.name : `family-${i + 1}`, listed: true, ...hosts });
  }
  let install: string | null = null;
  try { install = bare(new URL(env.PULSE_PUBLIC_URL ?? '').host); } catch { install = null; }
  if (install && HOST.test(install) && !seen.has(install)) families.push({ name: 'install', listed: false, app: install, api: null, mcp: null, id: null });
  memo = { key, value: families };
  return families;
}

/** https://host, except plain http with the request's port on this computer (a *.localhost rehearsal of the family). */
export function hostOrigin(host: string, port: string | null = null): string {
  return local(host) ? `http://${host}${port ? `:${port}` : ''}` : `https://${host}`;
}

/** The family of a host (the raw x-pulse-host, port allowed) with this host's job and the family's addresses, or null. */
export function hostFamily(rawHost: unknown, env: NodeJS.ProcessEnv = process.env): HostFamily | null {
  const host = bare(rawHost);
  if (!host) return null;
  const family = hostFamilies(env).find(f => ROLES.some(role => f[role] === host));
  if (!family) return null;
  const port = portOf(rawHost), at = (h: string) => hostOrigin(h, port);
  const role = ROLES.find(r => family[r] === host)!;
  const app = at(family.app!), self = at(host);
  return { name: family.name, listed: family.listed, role, host, self, app, issuer: at(family.id ?? family.app!),
    mcp: role === 'app' || role === 'mcp' ? self : at(family.mcp ?? family.app!), signIn: role === 'app' || role === 'id' ? self : app };
}

/** A configured family's host where people sign in (app or id), else false: the install's Google sign-in may start there. */
export const familySignInHost = (rawHost: unknown, env: NodeJS.ProcessEnv = process.env) => {
  const f = hostFamily(rawHost, env);
  return !!f && f.listed && (f.role === 'app' || f.role === 'id');
};

/** Names under a family's domain that no company may claim (vitalsos-domain-plan §2: the platform's own jobs). */
export const RESERVED_LABELS = ['www', 'app', 'api', 'mcp', 'id', 'auth', 'login', 'oauth', 'sso', 'docs', 'help', 'status', 'cdn', 'downloads', 'download',
  'apps', 'mail', 'email', 'admin', 'pulse', 'pulse-admin', 'staging', 'app-staging', 'api-staging', 'mcp-staging', 'id-staging', 'site-staging', 'site',
  'fallback', 'customers', 'files', 'license', 'registry', 'billing', 'support', 'security', 'blog', 'dev', 'test'];

/** Why a company may not claim this address (it is one of Pulse's own, or a reserved name under a family's domain),
 *  else null. The domain of a family is its app host without the first label (app.vitalsos.ai → vitalsos.ai). */
export function reservedHost(rawHost: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  const host = bare(rawHost);
  if (!host) return null;
  // The install's own address (the "install" family) is left to the existing rules: its company may already hold it.
  if (hostFamily(host, env)?.listed) return `${host} is one of Pulse's own addresses; choose another for the company`;
  for (const f of hostFamilies(env).filter(x => x.listed)) {
    const labels = f.app!.split('.');
    if (labels.length < 3) continue;
    const domain = labels.slice(1).join('.');
    if (host === domain) return `${host} is Pulse's own domain; choose an address under it, such as company.${domain}`;
    if (host.endsWith(`.${domain}`) && RESERVED_LABELS.includes(host.slice(0, -domain.length - 1)))
      return `${host.slice(0, -domain.length - 1)}.${domain} is kept for Pulse itself; choose another name, such as company.${domain}`;
  }
  return null;
}

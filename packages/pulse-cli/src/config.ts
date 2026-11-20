// Where the pulse command keeps its sign-ins: one JSON file in the OS config directory, readable by you only (0600 in
// a 0700 directory), written atomically. One entry per Pulse address and organisation (a profile), so one computer can
// keep a sign-in to several companies, on their own addresses or on the shared one, and switch between them.
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { CliError, EXIT, usage } from './errors.js';

/** The hosted Pulse service; PULSE_HOST or --host (or your last `pulse login`) picks another company's address. */
export const DEFAULT_HOST = 'https://pulse.estateautopilots.com'; // tenant-neutral:allow: the hosted service's address, the CLI's default as the owner asked

/** The organisation a sign-in acts in (Pulse's answer to /api/v1/people/me at login), shown and matched by `pulse org switch`. */
type Labels = { org?: string };
export type OAuthCredential = Labels & { kind: 'oauth'; clientId: string; accessToken: string; refreshToken: string; expiresAt: number; scope: string;
  tokenEndpoint: string; revocationEndpoint?: string; savedAt: string };
export type TokenCredential = Labels & { kind: 'token'; token: string; savedAt: string };
export type Credential = OAuthCredential | TokenCredential;
/** `hosts` maps a profile to its sign-in: the address alone (an older login), or `<address>#<organisation>`. */
export type Store = { version: 1; defaultHost?: string; hosts: Record<string, Credential> };

export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const pick = (value: string | undefined, name: string) => {
    if (value && !isAbsolute(value)) usage(`${name} must be an absolute path`);
    return value;
  };
  const own = pick(env.PULSE_CONFIG_DIR, 'PULSE_CONFIG_DIR');
  if (own) return own;
  if (platform === 'win32') return join(pick(env.APPDATA, 'APPDATA') ?? join(homedir(), 'AppData', 'Roaming'), 'pulse');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'pulse');
  return join(pick(env.XDG_CONFIG_HOME, 'XDG_CONFIG_HOME') ?? join(homedir(), '.config'), 'pulse');
}
export const storePath = () => join(configDir(), 'credentials.json');

/** https anywhere; plain http only on this computer (a local Pulse). Origin only: no path, query, user or password. */
export function normalizeHost(raw: string): string {
  let text = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(text) ? 'http://' : 'https://') + text;
  let url: URL;
  try { url = new URL(text); } catch { return usage(`Not a Pulse address: ${raw}`, 'Example: --host https://pulse.example.com'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
    usage(`Give only the Pulse address, without a path: ${raw}`, `Did you mean --host ${url.origin}?`);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)))
    usage(`Pulse addresses use https (plain http only on localhost): ${raw}`);
  return url.origin;
}

export function readStore(): Store {
  let text: string;
  try { text = readFileSync(storePath(), 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, hosts: {} };
    throw new CliError(`Cannot read ${storePath()}: ${(e as Error).message}`, EXIT.failed);
  }
  try {
    const data = JSON.parse(text) as Store;
    if (data && data.version === 1 && data.hosts && typeof data.hosts === 'object') return data;
  } catch { /* falls through */ }
  throw new CliError(`${storePath()} is not a pulse credentials file; delete it and run pulse login again`, EXIT.failed);
}

export function writeStore(store: Store) {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.credentials.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(store, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, storePath());
  } finally { rmSync(temporary, { force: true }); }
}

/**
 * Run `work` while holding the credentials lock. A sign-in's refresh token works once (a replayed one ends the
 * connection), so two pulse commands refreshing at the same time must take turns. A lock older than 30 s is stale.
 */
export async function withStoreLock<T>(work: () => Promise<T>): Promise<T> {
  const dir = configDir(), lock = join(dir, 'credentials.lock');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const started = Date.now();
  for (;;) {
    try { closeSync(openSync(lock, 'wx', 0o600)); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (Date.now() - started > 20_000) throw new CliError(`Another pulse command holds ${lock}; try again (or delete it if none is running)`, EXIT.failed);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try { return await work(); } finally { rmSync(lock, { force: true }); }
}

/** --host, then PULSE_HOST, then the address of your last `pulse login` (or `pulse org switch`), then the default. */
export function resolveHost(flag: string | undefined, env: NodeJS.ProcessEnv = process.env, store?: Store): string {
  if (flag) return normalizeHost(flag);
  if (env.PULSE_HOST) return normalizeHost(env.PULSE_HOST);
  const remembered = (store ?? safeStore()).defaultHost;
  return remembered ? normalizeHost(hostOf(remembered)) : DEFAULT_HOST;
}
const safeStore = (): Store => { try { return readStore(); } catch { return { version: 1, hosts: {} }; } };

// AGENT-API (owner, 5 Nov 2026: "org switch" in the CLI): someone in Willow Lane and I-Solar keeps both sign-ins, even on
// the one shared address, and picks one with `pulse org switch <name>`, --org <name> or PULSE_ORG.
export const orgSlug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const hostOf = (profile: string) => profile.split('#')[0];
export const profileKey = (host: string, org?: string) => (org && orgSlug(org) ? `${host}#${orgSlug(org)}` : host);
/** The profiles matching an organisation name (its slug or full name) or an address, optionally on one address. */
export function findProfiles(store: Store, name: string, host?: string): string[] {
  const want = orgSlug(name);
  let asHost: string | undefined;
  try { asHost = /[.:/]/.test(name) ? normalizeHost(name) : undefined; } catch { asHost = undefined; }
  return Object.keys(store.hosts).filter(k => (!host || hostOf(k) === host) && (
    (want && (k.split('#')[1] === want || orgSlug(store.hosts[k].org ?? '') === want)) || (asHost !== undefined && (k === asHost || hostOf(k) === asHost))));
}
/** The sign-in a command uses: --org / PULSE_ORG, else your default on that address, else the only one there. */
export function resolveProfile(flagHost: string | undefined, flagOrg: string | undefined, env: NodeJS.ProcessEnv = process.env, store: Store = safeStore()): string {
  const org = flagOrg ?? env.PULSE_ORG;
  const host = flagHost ? normalizeHost(flagHost) : env.PULSE_HOST ? normalizeHost(env.PULSE_HOST) : undefined;
  if (org) {
    const found = findProfiles(store, org, host);
    if (found.length === 1) return found[0];
    if (found.length > 1) usage(`More than one sign-in matches ${org}`, 'Add --host to say which address.');
    throw new CliError(`Not signed in to ${org}${host ? ` at ${host}` : ''}`, EXIT.auth, 'Run `pulse login` (with --host for its address) while signed in to that company, or `pulse auth status` to see your sign-ins.');
  }
  const remembered = store.defaultHost;
  if (!host) return remembered ?? DEFAULT_HOST;
  if (remembered && hostOf(remembered) === host) return remembered;
  if (store.hosts[host]) return host;
  const there = Object.keys(store.hosts).filter(k => hostOf(k) === host);
  if (there.length > 1) usage(`You are signed in to ${there.length} organisations at ${host}`, `Choose one with --org <name> or \`pulse org switch <name>\`.`);
  return there[0] ?? host;
}

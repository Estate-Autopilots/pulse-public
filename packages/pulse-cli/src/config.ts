// Where the pulse command keeps its sign-ins: one JSON file in the OS config directory, readable by you only (0600 in
// a 0700 directory), written atomically. One entry per Pulse address, so one computer can use several companies.
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { CliError, EXIT, usage } from './errors.js';

/** The hosted Pulse service; PULSE_HOST or --host (or your last `pulse login`) picks another company's address. */
export const DEFAULT_HOST = 'https://pulse.estateautopilots.com'; // tenant-neutral:allow: the hosted service's address, the CLI's default as the owner asked

export type OAuthCredential = { kind: 'oauth'; clientId: string; accessToken: string; refreshToken: string; expiresAt: number; scope: string;
  tokenEndpoint: string; revocationEndpoint?: string; savedAt: string };
export type TokenCredential = { kind: 'token'; token: string; savedAt: string };
export type Credential = OAuthCredential | TokenCredential;
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

/** --host, then PULSE_HOST, then the address of your last `pulse login`, then the default. */
export function resolveHost(flag: string | undefined, env: NodeJS.ProcessEnv = process.env, store?: Store): string {
  if (flag) return normalizeHost(flag);
  if (env.PULSE_HOST) return normalizeHost(env.PULSE_HOST);
  const remembered = (store ?? safeStore()).defaultHost;
  return remembered ? normalizeHost(remembered) : DEFAULT_HOST;
}
const safeStore = (): Store => { try { return readStore(); } catch { return { version: 1, hosts: {} }; } };

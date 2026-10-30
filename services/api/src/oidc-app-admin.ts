// PULSE-ID: register an app on this install from the server itself, for an install whose admins are not at a browser
// (Pulse production for Sales X-Ray, owner's approval 27 Oct 2026). It calls the same audited function as Settings →
// Developer apps (pulse.oidc_app_manage) as the named admin of the install's own organisation, whom the audit names, in
// one transaction. The client secret goes only to a new file (mode 600, never overwritten); stdout carries the app id and
// client id. Run inside the install's API container (its database login and issuer), as root:
//   node services/api/dist/oidc-app-admin.js register <new-file> --as <admin person uuid> --name "…" [--maker "…"]
//     [--home https://…] --redirect https://… [--redirect https://…] --scopes openid,profile,… [--verified]
//   node services/api/dist/oidc-app-admin.js list --as <admin person uuid>
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Client } from 'pg';
import { apiPoolConfig } from './database.js';
import { newClientId, newClientSecret, oidcIssuer, SCOPES } from './oidc.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const usage = 'Usage: oidc-app-admin register <new-file> --as <admin uuid> --name "…" [--maker "…"] [--home https://…] --redirect https://… [--redirect …] --scopes a,b [--verified] | list --as <admin uuid>';
type App = { id: string; clientId: string; name: string; verified: boolean; status: string };
let db: Client | undefined;
try {
  const [action, ...args] = process.argv.slice(2);
  if (action !== 'register' && action !== 'list') throw Error(usage);
  const target = action === 'register' ? args.shift() : undefined;
  const o: { as?: string; name?: string; maker?: string; home?: string; redirects: string[]; scopes?: string[]; verified: boolean } = { redirects: [], verified: false };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--verified' && action === 'register' && !o.verified) { o.verified = true; continue; }
    const value = args.shift();
    if (!value) throw Error(usage);
    if (flag === '--as' && !o.as && UUID.test(value)) o.as = value;
    else if (action === 'register' && flag === '--name' && !o.name) o.name = value;
    else if (action === 'register' && flag === '--maker' && !o.maker) o.maker = value;
    else if (action === 'register' && flag === '--home' && !o.home) o.home = value;
    else if (action === 'register' && flag === '--redirect') o.redirects.push(value);
    else if (action === 'register' && flag === '--scopes' && !o.scopes) o.scopes = value.split(',');
    else throw Error(usage);
  }
  const known: readonly string[] = SCOPES;
  if (!o.as || (action === 'register' && (!target || !o.name || !o.redirects.length || !o.scopes?.length || o.scopes.some((s) => !known.includes(s))))) throw Error(usage);
  const issuer = oidcIssuer();
  if (!issuer) throw Error('Set PULSE_OIDC_ISSUER or PULSE_PUBLIC_URL');
  db = new Client(apiPoolConfig());
  await db.connect();
  await db.query('begin');
  await db.query("select set_config('pulse.org_id', pulse.install_org()::text, true), set_config('pulse.viewer_id', $1, true)", [o.as]);
  const manage = async (op: string, p: object) => (await db!.query('select pulse.oidc_app_manage($1, $2) r', [op, JSON.stringify(p)])).rows[0].r;
  if (action === 'list') {
    for (const a of (await manage('list', {})) as App[]) console.log(`${a.id} ${a.clientId} ${a.verified ? 'verified' : 'unverified'} ${a.status} ${a.name}`);
    await db.query('rollback');
  } else {
    const clientId = newClientId(), secret = newClientSecret();
    const made = (await manage('save', { name: o.name, maker: o.maker, homeUrl: o.home, redirectUris: o.redirects, scopes: o.scopes, clientId,
      secretHash: createHash('sha256').update(secret).digest('hex') })) as App;
    if (o.verified) await manage('verify', { id: made.id, verified: true });
    // The file first: a failed write leaves nothing registered; a failed commit leaves a file for a secret that never was.
    await writeFile(target!, [`# ${o.name} on ${issuer} (oidc-app-admin, ${new Date().toISOString()}). Secret: never print, paste or commit.`,
      `PULSE_ISSUER=${issuer}`, `PULSE_CLIENT_ID=${made.clientId}`, `PULSE_CLIENT_SECRET=${secret}`, ''].join('\n'), { mode: 0o600, flag: 'wx' });
    await db.query('commit');
    console.log(`${made.id} ${made.clientId}`);
  }
} catch (e) {
  // The function's own refusals (not an admin, a bad return address) are safe to show; anything else may carry a
  // database address with its password, so only its code is shown.
  const err = e as { code?: string; message?: string };
  const said = err.code === undefined || ['42501', '22023', 'P0002'].includes(err.code) ? err.message : `failed (${err.code})`;
  console.error(`oidc-app-admin: ${said}. Nothing was registered (list shows what exists).`);
  process.exitCode = 1;
} finally {
  await db?.end().catch(() => undefined);
}

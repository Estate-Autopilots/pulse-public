#!/usr/bin/env node
// pulse: Pulse from a terminal or a script. `pulse login` signs in as you in the browser; every Pulse API v1 operation
// is a command (`pulse people search asha`, `pulse hr onboarding --stuck true`); `pulse api` calls any API path.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse, one, type Spec } from './args.js';
import { browserLogin, logout, readTokenInput, saveCredential, session, type Session } from './auth.js';
import { commandHelp, commands, GLOBAL, GROUPS, groupHelp, buildRequest, specFor, title, type Command } from './commands.js';
import { readStore, resolveHost, storePath, DEFAULT_HOST } from './config.js';
import { CliError, EXIT, redact, secret, usage } from './errors.js';
import { call, refusal, VERSION } from './http.js';
import { human, print, printJson, table } from './output.js';
import { API_VERSION, OPERATIONS } from './operations.generated.js';

const err = (line: string) => process.stderr.write(redact(line) + '\n');

function mainHelp(list: Command[]): string {
  const top = list.filter(c => !c.group);
  const groups = [...new Set(list.map(c => c.group).filter((g): g is string => !!g && g !== 'op'))];
  const rows: [string, string][] = [
    ['login', 'Sign in with your Pulse account in the browser (--token to paste a token, --no-browser on a server)'],
    ['logout', 'Sign out here and end this computer\'s connection to Pulse'],
    ...top.map(c => [c.name, c.op.summary] as [string, string]),
    ...groups.map(g => [`${g} …`, GROUPS[g] ?? ''] as [string, string]),
    ['ops', 'List every API v1 operation and its command'],
    ['api <METHOD> <path>', 'Call any Pulse API path with your sign-in (raw JSON)'],
  ];
  const pad = Math.max(...rows.map(r => r[0].length));
  return [`pulse ${VERSION}: Pulse from your terminal (API v${API_VERSION})`, '', 'Usage: pulse <command> [options]', '', 'Commands:',
    ...rows.map(([a, b]) => `  ${a.padEnd(pad)}  ${b}`), '',
    'Global options:', '  --host <url>  the Pulse address (or PULSE_HOST; default: your last login, else ' + DEFAULT_HOST + ')',
    '  --json        print Pulse\'s answers as JSON for scripts', '  -h, --help    help for any command', '  --version     the CLI version', '',
    'Scripts and CI: set PULSE_TOKEN to a token instead of signing in. Exit codes: 0 ok, 1 Pulse or network failed,',
    '2 not signed in, 3 refused (role or scope), 4 wrong command or input, 5 rate limited.', '',
    'Examples:', '  pulse login', '  pulse people search asha', '  pulse hr onboarding --stuck true',
    '  pulse hr correct <personId> --field joinedOn --value 2026-08-01 --reason "Offer letter says so"',
    '  pulse changes list --json', '  pulse api GET /api/v1/people/me'].join('\n');
}

/** Send one operation request with the sign-in; a 401 on a browser sign-in renews it once and retries. */
async function send(s: Session, method: string, path: string, query: Record<string, string>, body: unknown, headers: Record<string, string>) {
  const url = new URL(path, s.host);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const attempt = (token: string) => call(url, { method, headers: { ...headers, authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { json: body }) });
  let reply = await attempt(s.token);
  if (reply.status === 401 && s.refresh) reply = await attempt(await s.refresh());
  if (reply.status < 200 || reply.status >= 300) throw refusal(reply);
  if (reply.body === undefined && reply.text) return reply.text;
  return reply.body;
}

async function login(rest: string[]) {
  // A bare --token (last, or followed by another option) asks for the token without echoing it.
  const tokens = rest.map((t, i) => t === '--token' && (i === rest.length - 1 || rest[i + 1].startsWith('--')) ? '--token=-' : t);
  const spec: Spec = { values: new Set(['host', 'token', 'scopes', 'port']), booleans: new Set(['json', 'help', 'browser']) };
  const p = parse(tokens, spec, 'pulse login');
  if (p.booleans.get('help')) return print(['Sign in to Pulse. The CLI then acts as you, with your roles.', '',
    'Usage: pulse login [--host <url>] [--no-browser] [--token [<token>|-]] [--scopes "<scope> …"]', '',
    '  (default)        opens Pulse\'s consent screen in your browser; choose Allow (OAuth 2.1 + PKCE, loopback on 127.0.0.1)',
    '  --no-browser     prints the link to open anywhere; paste back the address the browser ends on (servers, SSH)',
    '  --token [value]  store a token you already have (personal token or app key); bare --token or - asks without echo,',
    '                   or reads it from stdin when piped: echo "$TOKEN" | pulse login --token',
    '  --scopes "…"     ask for fewer permissions (default: all; Pulse still checks your role on every call)',
    '  --port <n>       the loopback port to listen on (default: any free port)',
    '', `Sign-ins are kept in ${storePath()} (readable by you only).`].join('\n'));
  if (p.positionals.length) usage(`Unexpected argument: ${p.positionals[0]}`);
  const host = resolveHost(one(p, 'host'));
  let token = one(p, 'token');
  if (token !== undefined) {
    if (token === '-') token = await readTokenInput();
    if (!token || /\s/.test(token)) usage('That token is empty or has spaces');
    secret(token);
    const me = await send({ host, token, source: 'token' }, 'GET', '/api/v1/people/me', {}, undefined, {}) as { name?: string; username?: string };
    await saveCredential(host, { kind: 'token', token, savedAt: new Date().toISOString() });
    if (p.booleans.get('json')) return printJson({ host, signedIn: true, via: 'token', name: me.name, username: me.username });
    return print(`Signed in to ${host} as ${me.name ?? '?'}${me.username ? ` (@${me.username})` : ''} with a token.`);
  }
  const portRaw = one(p, 'port'), port = portRaw === undefined ? undefined : Number(portRaw);
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) usage('--port must be a port number');
  const credential = await browserLogin(host, { browser: p.booleans.get('browser') !== false, scopes: one(p, 'scopes'), port, log: err });
  await saveCredential(host, credential);
  const me = await send({ host, token: credential.accessToken, source: 'oauth' }, 'GET', '/api/v1/people/me', {}, undefined, {}) as { name?: string; username?: string; roles?: string[] };
  if (p.booleans.get('json')) return printJson({ host, signedIn: true, via: 'browser', name: me.name, username: me.username, scope: credential.scope });
  print(`Signed in to ${host} as ${me.name ?? '?'}${me.username ? ` (@${me.username})` : ''}${me.roles?.length ? ` · ${me.roles.join(', ')}` : ''}.`);
}

async function rawApi(rest: string[]) {
  const spec: Spec = { values: new Set(['host', 'data', 'query', 'idempotency-key']), booleans: new Set(['json', 'help']) };
  const p = parse(rest, spec, 'pulse api');
  if (p.booleans.get('help') || !p.positionals.length) return print(['Call any Pulse API path with your sign-in and print the JSON answer.', '',
    'Usage: pulse api <METHOD> <path> [--query name=value …] [--data <json|@file|->] [--idempotency-key <uuid>]', '',
    'Writes (POST, PUT, PATCH, DELETE) get a new Idempotency-Key unless you give one.', '',
    'Examples:', '  pulse api GET /api/v1/people/me', '  pulse api GET /api/v1/people --query query=asha',
    '  pulse api POST /api/v1/chats/groups --data \'{"name":"Launch","memberIds":[]}\''].join('\n'));
  const [methodRaw, path, extra] = p.positionals;
  const method = methodRaw.toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) usage(`Unknown method ${methodRaw}`, 'Use GET, POST, PUT, PATCH or DELETE.');
  if (!path || extra) usage('Usage: pulse api <METHOD> <path>');
  if (!/^\/api\/[A-Za-z0-9._~\-/{}:%]*(\?.*)?$/.test(path)) usage(`The path must start with /api/: ${path}`, 'Example: /api/v1/people/me');
  const query: Record<string, string> = {};
  for (const q of p.values.get('query') ?? []) {
    const at = q.indexOf('=');
    if (at < 1) usage(`--query takes name=value: ${q}`);
    query[q.slice(0, at)] = q.slice(at + 1);
  }
  const dataRaw = one(p, 'data');
  let body: unknown;
  if (dataRaw !== undefined) {
    const text = dataRaw === '-' ? readFileSync(0, 'utf8') : dataRaw.startsWith('@') ? readFileSync(dataRaw.slice(1), 'utf8') : dataRaw;
    try { body = JSON.parse(text); } catch { usage('--data is not valid JSON'); }
  }
  const headers: Record<string, string> = method === 'GET' ? {} : { 'Idempotency-Key': one(p, 'idempotency-key') ?? randomUUID() };
  const s = await session(resolveHost(one(p, 'host')));
  const [bare, search] = path.split('?');
  for (const [k, v] of new URLSearchParams(search ?? '')) query[k] ??= v;
  printJson(await send(s, method, bare, query, body, headers));
}

async function runCommand(c: Command, rest: string[]) {
  const p = parse(rest, specFor(c.op), title(c));
  if (p.booleans.get('help')) return print(commandHelp(c));
  const req = buildRequest(c, p);
  const host = resolveHost(one(p, 'host')), s = await session(host);
  const answer = await send(s, req.method, req.path, req.query, req.body, req.headers);
  if (p.booleans.get('json')) return printJson(answer);
  if (c.operationId === 'whoAmI') {
    const me = answer as { name?: string; username?: string; roles?: string[]; app?: unknown; company?: unknown };
    const via = s.source === 'env' ? 'PULSE_TOKEN' : s.source === 'oauth' ? 'browser sign-in' : 'stored token';
    return print([`${me.name ?? '?'}${me.username ? ` (@${me.username})` : ''}`, human({ host, via, ...me })].join('\n\n'));
  }
  print(human(answer, c.columns));
}

function opsList(list: Command[], json: boolean) {
  const rows = list.map(c => ({ command: title(c).slice(6), method: c.op.method, path: c.op.path, scope: c.op.scopes.join(','), operationId: c.op.operationId, summary: c.op.summary }));
  if (json) return printJson(rows);
  print(table(rows, ['command', 'method', 'path', 'scope', 'summary']));
}

export async function main(argv: string[]): Promise<number> {
  const list = commands(OPERATIONS);
  // Find the command words; options may come first (`pulse --host … people search`).
  const rest: string[] = [];
  let resolved: Command | 'login' | 'logout' | 'api' | 'ops' | 'help' | 'version' | { group: string } | undefined;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const done = resolved !== undefined && !(typeof resolved === 'object' && !('op' in resolved));
    if (done || t.startsWith('-')) {
      rest.push(t);
      if (!done && t === '--host' && argv[i + 1] !== undefined) rest.push(argv[++i]);
      continue;
    }
    if (resolved === undefined) {
      if (['login', 'logout', 'api', 'ops', 'help', 'version'].includes(t)) { resolved = t as 'login'; continue; }
      const top = list.find(c => !c.group && c.name === t);
      if (top) { resolved = top; continue; }
      if (t === 'op' || list.some(c => c.group === t)) { resolved = { group: t }; continue; }
      usage(`Unknown command: ${t}`, 'Run `pulse --help` to see the commands.');
    } else {
      const group = (resolved as { group: string }).group;
      const found = list.find(c => c.group === group && c.name === t) ?? (group === 'op' ? list.find(c => c.operationId === t) : undefined);
      if (!found) usage(`Unknown command: pulse ${group} ${t}`, `Run \`pulse ${group} --help\` to see its commands.`);
      resolved = found;
    }
  }
  const global = () => parse(rest, GLOBAL);
  if (resolved === undefined) {
    const g = global();
    if (g.booleans.get('version')) { print(VERSION); return 0; }
    print(mainHelp(list)); return 0;
  }
  if (resolved === 'version') { print(VERSION); return 0; }
  if (resolved === 'help') {
    const target = rest.find(t => !t.startsWith('-'));
    print(target && list.some(c => c.group === target) ? groupHelp(target, list) : mainHelp(list)); return 0;
  }
  if (resolved === 'login') { await login(rest); return 0; }
  if (resolved === 'api') { await rawApi(rest); return 0; }
  if (resolved === 'logout') {
    const p = parse(rest, { values: new Set(['host']), booleans: new Set(['json', 'help']) }, 'pulse logout');
    if (p.booleans.get('help')) { print('Sign out of a Pulse address: end the connection at Pulse and forget it here.\n\nUsage: pulse logout [--host <url>]'); return 0; }
    const host = resolveHost(one(p, 'host'), process.env, readStore());
    const r = await logout(host);
    if (p.booleans.get('json')) printJson({ host, ...r });
    else print(r.removed ? `Signed out of ${host}${r.revoked ? '' : ' here (Pulse could not be told; end it under Account → Connected apps)'}.` : `Not signed in to ${host}.`);
    if (process.env.PULSE_TOKEN) err('Note: PULSE_TOKEN is still set in this shell.');
    return 0;
  }
  if (resolved === 'ops') { const g = global(); if (g.booleans.get('help')) { print('List every Pulse API v1 operation and the command that calls it.\n\nUsage: pulse ops [--json]'); return 0; } opsList(list, !!g.booleans.get('json')); return 0; }
  if (!('op' in resolved)) { global(); print(groupHelp(resolved.group, list)); return 0; }
  await runCommand(resolved, rest);
  return 0;
}

// Tests import main() with PULSE_CLI_NO_MAIN=1; everything else (the pulse bin, node dist/cli.js) runs it.
if (process.env.PULSE_CLI_NO_MAIN !== '1') {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (e: unknown) => {
    if (e instanceof CliError) {
      err(`pulse: ${e.message}`);
      if (e.hint) err(e.hint);
      process.exitCode = e.exitCode;
    } else {
      err(`pulse: unexpected error: ${(e as Error)?.stack ?? String(e)}`);
      process.exitCode = EXIT.failed;
    }
  });
}

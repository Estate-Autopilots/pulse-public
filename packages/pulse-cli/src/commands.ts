// Every Pulse API v1 operation as a command. The operations (paths, fields, scopes) come from the generated table; this
// file only names them for people (`pulse people search` for searchPeople) and picks table columns. An operation the
// names below do not cover still works as `pulse op <operationId>` and is listed by `pulse ops`.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { kebab, one, type Parsed, type Spec } from './args.js';
import { CliError, usage } from './errors.js';
import { OPERATIONS, type Field, type Operation } from './operations.generated.js';

export type Named = { group?: string; name: string; operationId: string; args?: string[]; columns?: string[]; about?: string };

export const GROUPS: Record<string, string> = {
  people: 'Find colleagues and read staff records',
  hr: 'HR and admin: onboarding roster, record corrections, one-time passwords, sign-in e-mails',
  groups: 'Create chat groups and change their members',
  changes: 'Changes you made through apps and tokens, and undo',
  bugs: 'Bug reports from the Pulse apps (admin and leadership)',
};

export const NAMED: Named[] = [
  { name: 'whoami', operationId: 'whoAmI' },
  { name: 'search', operationId: 'search', args: ['query'], columns: ['id', 'title', 'url'] },
  { name: 'fetch', operationId: 'fetch', args: ['id'] },
  { group: 'people', name: 'search', operationId: 'searchPeople', args: ['query'], columns: ['id', 'name', 'username', 'status', 'role', 'department', 'workEmail'] },
  { group: 'people', name: 'get', operationId: 'getPerson', args: ['personId'] },
  { group: 'hr', name: 'onboarding', operationId: 'listOnboarding', columns: ['id', 'name', 'role', 'joinedOn', 'invite', 'canSignIn', 'percent', 'stuck'] },
  { group: 'hr', name: 'correct', operationId: 'correctPersonField', args: ['personId'] },
  { group: 'hr', name: 'otp', operationId: 'issueOneTimePassword', args: ['personId'] },
  { group: 'hr', name: 'sign-in-email', operationId: 'sendSignInEmail', args: ['personId', 'kind'] },
  { group: 'groups', name: 'create', operationId: 'createChatGroup', args: ['name'] },
  { group: 'groups', name: 'members', operationId: 'changeChatGroupMembers', args: ['groupId'] },
  { group: 'changes', name: 'list', operationId: 'listMyChanges', columns: ['changeId', 'at', 'app', 'action', 'subjectName', 'status', 'undoUntil'] },
  { group: 'changes', name: 'undo', operationId: 'undoChange', args: ['changeId'] },
  { group: 'bugs', name: 'list', operationId: 'listBugReports', columns: ['id', 'createdAt', 'status', 'personName', 'platform', 'page', 'body'] },
  { group: 'bugs', name: 'set-status', operationId: 'setBugReportStatus', args: ['reportId', 'status'] },
];

export type Command = Named & { op: Operation };
/** Named commands for the operations that exist, plus `op <operationId>` for any operation without a name. */
export function commands(ops: readonly Operation[] = OPERATIONS): Command[] {
  const byId = new Map(ops.map(op => [op.operationId, op]));
  const named = NAMED.filter(n => byId.has(n.operationId)).map(n => ({ ...n, op: byId.get(n.operationId)! }));
  const unnamed = ops.filter(op => !NAMED.some(n => n.operationId === op.operationId))
    .map(op => ({ group: 'op', name: op.operationId, operationId: op.operationId, op }));
  return [...named, ...unnamed];
}
export const title = (c: Pick<Named, 'group' | 'name'>) => `pulse ${c.group ? `${c.group} ` : ''}${c.name}`;

export const GLOBAL: Spec = { values: new Set(['host']), booleans: new Set(['json', 'help', 'version']) };

/** The options a command takes: its fields as --kebab-case, plus --data, --idempotency-key and the global ones. */
export function specFor(op: Operation): Spec {
  const spec: Spec = { values: new Set(GLOBAL.values), booleans: new Set(GLOBAL.booleans), negatable: new Set() };
  for (const f of op.fields) {
    const flag = kebab(f.name);
    if (f.type === 'boolean') spec.booleans.add(flag);
    else { spec.values.add(flag); if (f.nullable) spec.negatable!.add(flag); }
  }
  if (op.hasBody) spec.values.add('data');
  if (op.idempotencyKey) spec.values.add('idempotency-key');
  return spec;
}

export type Request = { method: string; path: string; query: Record<string, string>; body?: Record<string, unknown>; headers: Record<string, string> };

function convert(f: Field, raw: string): unknown {
  if (f.type === 'integer' || f.type === 'number') {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n) || (f.type === 'integer' && !Number.isInteger(n))) usage(`--${kebab(f.name)} must be a ${f.type}: ${raw}`);
    return n;
  }
  if (f.type === 'boolean') {
    if (!['true', 'false'].includes(raw)) usage(`${f.name} must be true or false: ${raw}`);
    return raw === 'true';
  }
  return raw;
}

function check(f: Field, value: unknown) {
  const flag = f.in === 'path' ? `<${f.name}>` : `--${kebab(f.name)}`;
  const each = Array.isArray(value) ? value : [value];
  for (const v of each) {
    if (typeof v !== 'string') continue;
    if (f.enum && !f.enum.includes(v)) usage(`${flag} must be one of ${f.enum.join(', ')} (got "${v}")`);
    if (f.pattern && !new RegExp(f.pattern).test(v)) {
      const id = /\[0-9a-f\]\{8\}/.test(f.pattern);
      usage(`${flag} ${id ? 'must be an id (a UUID such as 0b6c…-…)' : `does not match ${f.pattern}`}: "${v}"`,
        id ? 'Ids are in the first column of list commands and in --json output.' : undefined);
    }
    if (f.minLength !== undefined && v.length < f.minLength && f.type !== 'array') usage(`${flag} must be at least ${f.minLength} characters`);
    if (f.maxLength !== undefined && v.length > f.maxLength && f.type !== 'array') usage(`${flag} must be at most ${f.maxLength} characters`);
  }
}

function readData(raw: string): Record<string, unknown> {
  let text = raw;
  if (raw === '-') text = readFileSync(0, 'utf8');
  else if (raw.startsWith('@')) { try { text = readFileSync(raw.slice(1), 'utf8'); } catch (e) { usage(`Cannot read ${raw.slice(1)}: ${(e as Error).message}`); } }
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) usage('--data must be a JSON object');
    return v;
  } catch (e) { if (e instanceof CliError) throw e; return usage('--data is not valid JSON', 'Give JSON, @file.json, or - to read stdin.'); }
}

/** Turn a command's arguments into the HTTP request, checking what the reference says before anything is sent. */
export function buildRequest(command: Command, parsed: Parsed): Request {
  const { op } = command, path: Record<string, string> = {}, query: Record<string, string> = {};
  let body: Record<string, unknown> | undefined = op.hasBody ? {} : undefined;
  const data = op.hasBody ? one(parsed, 'data') : undefined;
  if (data !== undefined) body = readData(data);
  const positionals = [...parsed.positionals], argNames = command.args ?? [];
  if (positionals.length > argNames.length) usage(`Too many arguments for \`${title(command)}\`: ${positionals.slice(argNames.length).join(' ')}`, `See \`${title(command)} --help\`.`);
  for (const f of op.fields) {
    const flag = kebab(f.name), position = argNames.indexOf(f.name);
    const fromArg = position >= 0 ? positionals[position] : undefined;
    let value: unknown;
    if (f.type === 'boolean') value = parsed.booleans.get(flag);
    else {
      const given = parsed.values.get(flag);
      if (fromArg !== undefined && given) usage(`Give ${f.name} once: as an argument or as --${flag}`);
      const raws = fromArg !== undefined ? [fromArg] : given;
      if (raws) {
        if (f.type === 'array') value = raws.flatMap(r => r.split(',')).map(s => s.trim()).filter(Boolean);
        else { if (raws.length > 1) usage(`--${flag} was given more than once`); value = convert(f, raws[0]); }
      } else if (parsed.booleans.get(flag) === false && f.nullable) value = null;
    }
    if (value === undefined) {
      if (f.required && !(f.in === 'body' && body && f.name in body))
        usage(`Missing ${position >= 0 ? `<${f.name}>` : `--${flag}`} for \`${title(command)}\``, `Usage: ${usageLine(command)}`);
      continue;
    }
    check(f, value);
    if (f.in === 'path') path[f.name] = String(value);
    else if (f.in === 'query') query[f.name] = String(value);
    else body![f.name] = value;
  }
  const url = op.path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(path[name] ?? usage(`Missing <${name}>`)));
  const headers: Record<string, string> = {};
  if (op.idempotencyKey) headers['Idempotency-Key'] = one(parsed, 'idempotency-key') ?? randomUUID();
  return { method: op.method, path: url, query, body, headers };
}

// ---- help ------------------------------------------------------------------------------------------------------------

export function usageLine(c: Command): string {
  const args = (c.args ?? []).map(a => {
    const f = c.op.fields.find(x => x.name === a);
    return f?.required ? `<${a}>` : `[${a}]`;
  });
  const required = c.op.fields.filter(f => f.required && !(c.args ?? []).includes(f.name)).map(f => `--${kebab(f.name)} <${f.enum && f.enum.length <= 4 ? f.enum.join('|') : f.name}>`);
  return [title(c), ...args, ...required, '[options]'].join(' ');
}

export function commandHelp(c: Command): string {
  const lines = [c.op.summary, '', `Usage: ${usageLine(c)}`, '', 'Options:'];
  const rows: [string, string][] = [];
  for (const f of c.op.fields) {
    const asArg = (c.args ?? []).includes(f.name);
    const flag = f.type === 'boolean' ? `--${kebab(f.name)}` : `--${kebab(f.name)} <${f.enum && f.enum.length <= 4 ? f.enum.join('|') : f.type === 'array' ? 'a,b,…' : 'value'}>`;
    const notes = [f.required ? 'required' : '', f.enum && f.enum.length > 4 ? `one of ${f.enum.join(', ')}` : '', asArg ? `or as the <${f.name}> argument` : '', f.nullable ? `--no-${kebab(f.name)} sends null` : '',
      f.type === 'array' ? 'comma-separated or repeated' : '', f.description ?? ''].filter(Boolean).join('; ');
    rows.push([flag, notes]);
  }
  if (c.op.hasBody) rows.push(['--data <json|@file|->', 'the request body as JSON (options above override its fields)']);
  if (c.op.idempotencyKey) rows.push(['--idempotency-key <uuid>', 'repeat a write safely: the same key and input replay the first answer (default: a new UUID)']);
  rows.push(['--json', 'print Pulse\'s answer as JSON'], ['--host <url>', 'the Pulse address (default: PULSE_HOST, your last login, or the hosted service)'], ['-h, --help', 'this help']);
  const pad = Math.max(...rows.map(r => r[0].length));
  lines.push(...rows.map(([a, b]) => `  ${a.padEnd(pad)}  ${b}`.trimEnd()));
  lines.push('', `API: ${c.op.method} ${c.op.path}  (operation ${c.op.operationId}; scope ${c.op.scopes.join(', ') || '-'})`);
  return lines.join('\n');
}

export function groupHelp(group: string, list: Command[]): string {
  const mine = group === 'op' ? list.map(c => ({ ...c, name: c.operationId })) : list.filter(c => c.group === group);
  const pad = Math.max(...mine.map(c => c.name.length));
  return [GROUPS[group] ?? (group === 'op' ? 'Operations without a friendlier name, by operation id' : group), '', `Usage: pulse ${group} <command> [options]`, '', 'Commands:',
    ...mine.map(c => `  ${c.name.padEnd(pad)}  ${c.op.summary}`), '', `Run \`pulse ${group} <command> --help\` for its options.`].join('\n');
}

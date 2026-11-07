import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { SERVICE_SCOPES, needsAgent } from './service-key.js';

// Run on the issuing install. Only the UUID enters stdout; only the digest crosses HTTP.
try {
  const [action, ...args] = process.argv.slice(2);
  const usage = 'Usage: service-key-admin issue <new-file> --scopes a,b [--agent <uuid>] --label "Agent" | revoke <id> | list';
  if (!['issue','revoke','list'].includes(action ?? '')) throw Error(usage);
  let target: string | undefined, scopes: string[] | undefined, label: string | undefined, agentId: string | undefined;
  if (action === 'issue') {
    target = args.shift();
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if (flag === '--scopes' && scopes === undefined && value) scopes = value.split(',');
      else if (flag === '--agent' && agentId === undefined && value) agentId = value;
      else if (flag === '--label' && label === undefined && value) label = value;
      else throw Error(usage);
    }
    if (!target || !scopes?.length || new Set(scopes).size !== scopes.length || scopes.some(s => !SERVICE_SCOPES.some(v => v === s)) || !label || [...label].length > 60) throw Error(usage);
    if (needsAgent(scopes) !== (agentId !== undefined) || (agentId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(agentId))) throw Error(usage);
  } else if (action === 'revoke') {
    if (args.length !== 1 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(args[0])) throw Error(usage);
    target = args[0];
  } else if (args.length) throw Error(usage);
  const origin = new URL(process.env.PULSE_OPERATOR_URL ?? 'http://127.0.0.1:8081');
  if (!['http:','https:'].includes(origin.protocol) || !['127.0.0.1','[::1]','localhost'].includes(origin.hostname) || origin.username || origin.password) throw Error('Operator URL must be loopback');
  const operator = process.env.PULSE_OPERATOR_TOKEN_FILE ? (await readFile(process.env.PULSE_OPERATOR_TOKEN_FILE,'utf8')).trim() : process.env.PULSE_OPERATOR_TOKEN;
  if (!operator) throw Error('Configure PULSE_OPERATOR_TOKEN_FILE on this install');
  const id = action === 'issue' ? randomUUID() : target;
  const secret = action === 'issue' ? randomBytes(32).toString('base64url') : null;
  if (secret) await writeFile(target!, `psvc_${id}_${secret}`, { mode: 0o600, flag: 'wx' });
  const response = await fetch(new URL('/api/v1/operator/service-keys',origin), {
    method: action === 'list' ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${operator}`, ...(action === 'list' ? {} : { 'content-type':'application/json' }) },
    ...(action === 'list' ? {} : { body: JSON.stringify({ action,id,...(secret ? { hash: createHash('sha256').update(secret).digest('hex'),scopes,label,agentId } : {}) }) }),
  });
  if (!response.ok) throw Error('Operator call failed; retain any new secret file and inspect locally before retrying');
  const data = await response.json() as { keys?: { id: string }[] };
  if (action === 'list') {
    if (!Array.isArray(data.keys)) throw Error('Invalid operator response');
    for (const key of data.keys) if (/^[0-9a-f-]{36}$/.test(key.id)) console.log(key.id);
  } else console.log(id);
} catch {
  // Do not print arbitrary errors (filesystem paths, request objects or remote bodies may contain credentials).
  console.error('Service-key command failed. Check syntax, loopback operator configuration and any retained secret file locally.');
  process.exitCode = 1;
}

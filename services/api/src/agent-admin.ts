import { readFile } from 'node:fs/promises';

// Run on this install. Print only UUIDs; never reflect credentials, staff emails or remote errors.
try {
  const [action, ...args] = process.argv.slice(2);
  const values = new Map<string, string>();
  if (action !== 'chat') throw Error();
  while (args.length) {
    const flag = args.shift()!, value = args.shift();
    if (!['--name','--username','--chat','--members'].includes(flag) || values.has(flag) || !value) throw Error();
    values.set(flag,value);
  }
  if (values.size !== 4) throw Error();
  const origin = new URL(process.env.PULSE_OPERATOR_URL ?? 'http://127.0.0.1:8081');
  if (!['http:','https:'].includes(origin.protocol) || !['127.0.0.1','[::1]','localhost'].includes(origin.hostname) || origin.username || origin.password) throw Error();
  const token = process.env.PULSE_OPERATOR_TOKEN_FILE ? (await readFile(process.env.PULSE_OPERATOR_TOKEN_FILE,'utf8')).trim() : process.env.PULSE_OPERATOR_TOKEN;
  if (!token) throw Error();
  const response = await fetch(new URL('/api/v1/operator/agent-chat',origin), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: values.get('--name'), username: values.get('--username'), chat: values.get('--chat'), members: values.get('--members')!.split(',').map(s => s.trim()) }),
  });
  if (!response.ok) throw Error();
  const data = await response.json() as { agentId?: string; chatId?: string };
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (!uuid.test(data.agentId ?? '') || !uuid.test(data.chatId ?? '')) throw Error();
  console.log(data.agentId, data.chatId);
} catch {
  console.error('Agent chat setup failed. Check syntax and loopback operator configuration locally.');
  process.exitCode = 1;
}

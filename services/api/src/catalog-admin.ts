import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// Run on the issuing installation. Secret values never enter argv, stdout or an HTTP response.
try {
  const [action, target] = process.argv.slice(2);
  if (!['issue','revoke','share','unshare'].includes(action ?? '') || !target) throw Error('Usage: catalog-admin issue <new-secret-file> | revoke <key-id> | share|unshare <item-id>');
  const origin = new URL(process.env.PULSE_OPERATOR_URL ?? 'http://127.0.0.1:8081');
  if (!['127.0.0.1','[::1]','localhost'].includes(origin.hostname)) throw Error('Operator URL must be loopback');
  const operator = process.env.PULSE_OPERATOR_TOKEN_FILE ? (await readFile(process.env.PULSE_OPERATOR_TOKEN_FILE, 'utf8')).trim() : process.env.PULSE_OPERATOR_TOKEN;
  if (!operator) throw Error('Configure PULSE_OPERATOR_TOKEN_FILE on this install');
  const id = action === 'issue' ? randomUUID() : target;
  const secret = action === 'issue' ? randomBytes(32).toString('base64url') : null;
  if (secret) await writeFile(target, `pcat_${id}_${secret}`, { mode: 0o600, flag: 'wx' });
  const response = await fetch(new URL('/api/v1/operator/catalog', origin), { method: 'POST', headers: {
    authorization: `Bearer ${operator}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ action, id, ...(secret ? { hash: createHash('sha256').update(secret).digest('hex') } : {}) }) });
  if (!response.ok) throw Error(`Operator request failed (${response.status}); retain any created secret file and investigate locally`);
  console.log(JSON.stringify(await response.json()));
} catch (error) {
  // Never print fetch/SQL error objects, request headers, secret contents or remote response bodies.
  console.error(error instanceof Error && !('cause' in error) ? error.message : 'Catalogue operator call failed');
  process.exitCode = 1;
}

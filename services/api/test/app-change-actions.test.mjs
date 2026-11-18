// AI-CONNECT (8 Nov 2026): every action the API records in the change ledger (`change(ctx, '<action>', …)`) must be
// allowed by pulse_priv.app_change's check as the migrations leave it. 1596 and 1621 re-made the check from an old list
// and silently dropped contract.* and goal.*, so those v1/MCP writes failed with 23514 in production (fixed in 1830).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('../../../', import.meta.url).pathname;
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

test('every change-ledger action the API records is allowed by app_change_action_check', () => {
  let allowed = null;
  for (const f of readdirSync(join(root, 'db/migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    const up = readFileSync(join(root, 'db/migrations', f), 'utf8').split(/^--\s*migrate:down\b/m)[0];
    for (const m of up.matchAll(/add constraint app_change_action_check check \(action in \(([\s\S]*?)\)\)/gi))
      allowed = { file: f, actions: new Set([...m[1].matchAll(/'([a-z_.]+)'/g)].map((x) => x[1])) };
  }
  assert.ok(allowed, 'a migration sets app_change_action_check');
  const used = new Set();
  for (const f of walk(join(root, 'services/api/src')).filter((n) => n.endsWith('.ts')))
    for (const m of readFileSync(f, 'utf8').matchAll(/\bchange\(\s*ctx\s*,\s*'([a-z_.]+)'/g)) used.add(m[1]);
  assert.ok(used.has('contract.create') && used.has('task.create'), 'the scan finds the ledger calls');
  const missing = [...used].filter((a) => !allowed.actions.has(a)).sort();
  assert.deepEqual(missing, [], `${allowed.file} does not allow: ${missing.join(', ')}`);
});

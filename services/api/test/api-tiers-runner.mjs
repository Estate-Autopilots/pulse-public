// API-PLATFORM-2: the company's API tier on every call, on real PostgreSQL and tenant row security (migration 1595).
// A key's requests per minute follow the tier (enterprise 5,000, free 60, business 1,200; 429 with Retry-After), and
// after a downgrade its areas outside the new tier keep working for 14 days, then close (403), over REST and MCP.
// The plan is changed as the database owner, as the platform admin's screen would. Synthetic data only.
// Run by tests/core/test_api_tiers.py.
import assert from 'node:assert/strict';

import { Pool } from 'pg';
const { createApp } = await import('../dist/app.js');

const W = JSON.parse(process.env.TEST_W);
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 4 }), app = createApp(pool, pool);
const own = new Pool({ ...JSON.parse(process.env.TEST_OWNER_CONFIG), max: 1 });
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const asPerson = (email, method, url, payload) => app.inject({ method, url, headers: { 'cf-access-authenticated-user-email': email }, ...(payload ? { payload } : {}) });
const get = (token, url) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
async function owner(sql, args = []) {
  const c = await own.connect();
  try {
    await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [W.org]);
    const r = await c.query(sql, args); await c.query('commit'); return r.rows;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}
async function makeToken(email, body) {
  const r = await asPerson(email, 'POST', '/api/v0/api-tokens', body);
  assert.equal(r.statusCode, 201, r.body); checks++;
  return r.json().token;
}
async function rpc(token, name, args) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/mcp', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  const v = r.body.split('\n').filter(s => s.startsWith('data:')).map(s => JSON.parse(s.slice(5))).find(x => x.id === 1);
  return v.result ?? v;
}
const tierRefusal = r => r.statusCode === 403 && /plan does not include finance\.read/.test(r.json().detail);

try {
  // No plan row: enterprise, 5,000 a minute; the key holds finance.read (made while the company was enterprise).
  const key = await makeToken(W.adminEmail, { name: 'Tier check (synthetic)', scopes: ['tasks.read', 'finance.read'], days: 7 });
  let r = await get(key, '/api/v1/tasks?limit=1');
  ok(r.statusCode === 200 && r.headers['ratelimit-limit'] === '5000', `enterprise: 5000 a minute (${r.statusCode} ${r.headers['ratelimit-limit']})`);
  const before = await get(key, '/api/v1/finance/entries?limit=1');
  ok(!tierRefusal(before), 'finance is in the enterprise tier');

  // Downgraded to the trial plan (Free): 14 days' grace at the tier it came from.
  await owner("insert into pulse_priv.platform_plan(for_org, plan) values ($1, 'trial') on conflict (for_org) do update set plan = 'trial'", [W.org]);
  const grace = await owner('select api_prior_tier, api_downgraded_at from pulse_priv.platform_plan where for_org = $1', [W.org]);
  ok(grace[0].api_prior_tier === 'enterprise' && grace[0].api_downgraded_at, 'the downgrade is remembered');
  r = await get(key, '/api/v1/tasks?limit=1');
  ok(r.statusCode === 200 && r.headers['ratelimit-limit'] === '5000', 'during the grace the call runs at the old tier');
  ok((await get(key, '/api/v1/finance/entries?limit=1')).statusCode === before.statusCode, 'during the grace finance still answers as before');
  const plan = (await asPerson(W.adminEmail, 'GET', '/api/v0/api-tokens')).json().plan;
  ok(plan?.tier === 'free' && plan?.callTier === 'enterprise' && typeof plan?.graceUntil === 'string', `Settings sees the grace (${JSON.stringify(plan)})`);

  // The grace ends: finance closes (REST and MCP), and the key is held to Free's 60 a minute.
  await owner("update pulse_priv.platform_plan set api_downgraded_at = now() - interval '15 days' where for_org = $1", [W.org]);
  ok(tierRefusal(await get(key, '/api/v1/finance/entries?limit=1')), 'after the grace, areas outside the tier are refused');
  const viaMcp = await rpc(key, 'list_finance_entries', {});
  ok(viaMcp.isError && viaMcp.structuredContent?.status === 403, 'and over MCP');
  let first429 = null, served = 0;
  for (let i = 0; i < 62 && !first429; i++) {
    const x = await get(key, '/api/v1/tasks?limit=1');
    if (x.statusCode === 429) first429 = x; else { assert.equal(x.statusCode, 200, x.body); assert.equal(x.headers['ratelimit-limit'], '60'); served++; }
  }
  ok(first429 && served === 60 && Number(first429.headers['retry-after']) >= 1 && first429.json().status === 429, `Free: 60 a minute, then 429 with Retry-After (served ${served}; the refused finance call spends nothing)`);

  // Upgraded to growth (Business): the grace ends, 1,200 a minute, finance opens.
  await owner("update pulse_priv.platform_plan set plan = 'growth' where for_org = $1", [W.org]);
  const after = await owner('select api_prior_tier, api_downgraded_at from pulse_priv.platform_plan where for_org = $1', [W.org]);
  ok(after[0].api_prior_tier === null && after[0].api_downgraded_at === null, 'an upgrade clears the grace');
  const fresh = await makeToken(W.adminEmail, { name: 'Business check (synthetic)', scopes: ['tasks.read', 'finance.read'], days: 7 });
  r = await get(fresh, '/api/v1/tasks?limit=1');
  ok(r.statusCode === 200 && r.headers['ratelimit-limit'] === '1200', 'Business: 1200 a minute');
  ok(!tierRefusal(await get(fresh, '/api/v1/finance/entries?limit=1')), 'finance is in the Business tier');
  // Down to starter (Pro): finance stays open for 14 days from this downgrade.
  await owner("update pulse_priv.platform_plan set plan = 'starter' where for_org = $1", [W.org]);
  const pro = await owner('select api_prior_tier from pulse_priv.platform_plan where for_org = $1', [W.org]);
  ok(pro[0].api_prior_tier === 'business', 'Business to Pro starts a grace at Business');
  ok(!tierRefusal(await get(fresh, '/api/v1/finance/entries?limit=1')), 'in the grace');
  console.log(JSON.stringify({ ok: true, checks }));
} finally {
  await owner('delete from pulse_priv.platform_plan where for_org = $1', [W.org]).catch(() => undefined);
  await app.close();
  await pool.end(); await own.end();
}

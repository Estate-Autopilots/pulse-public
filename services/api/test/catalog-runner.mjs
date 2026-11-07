import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { catalogProxy } from '../../../apps/web/app/lib/catalog-proxy.mjs';
import { createApiProxy, v0ProxyOptions } from '../../../apps/web/app/api/proxy.mjs';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const logs = [];
const responses = [];
app.addHook('onSend', async (_request, _reply, payload) => { responses.push(String(payload)); return payload; });
app.log.info = (...args) => logs.push(JSON.stringify(args));
app.log.warn = (...args) => logs.push(JSON.stringify(args));
app.log.error = (...args) => logs.push(JSON.stringify(args));
const operator = { authorization: `Bearer ${process.env.PULSE_OPERATOR_TOKEN}` };
const manage = async (action, id, hash) => {
  const response = await app.inject({ method: 'POST', url: '/api/v1/operator/catalog', headers: operator, payload: { action, id, ...(hash ? { hash } : {}) } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
};
try {
  const secret = randomBytes(32).toString('base64url'), id = randomUUID();
  const hash = createHash('sha256').update(secret).digest('hex');
  assert.deepEqual(await manage('issue', id, hash), { id });
  const headers = { authorization: `Bearer pcat_${id}_${secret}` };
  const get = (url = '/api/v1/catalog/items', override = {}) => app.inject({ url, headers, ...override });
  const fields = ['id','kind','name','description','price','currency','taxRate','publicLink'].sort();
  const initial = await get();
  assert.equal(initial.statusCode, 200, initial.body);
  assert.deepEqual(initial.json().items.map(i => i.id).sort(), JSON.parse(process.env.TEST_ITEMS).sort());
  for (const item of initial.json().items) {
    assert.deepEqual(Object.keys(item).sort(), fields);
    assert.equal(item.price, 12345); assert.equal(item.currency, 'INR'); assert.equal(item.taxRate, 18); assert.equal(item.publicLink, null);
  }
  process.env.PULSE_API_URL = await app.listen({ host: '127.0.0.1', port: 0 });
  const webRequest = (path, auth = headers.authorization) => new Request(`https://synthetic.example/api/v1/catalog/${path}`, { headers: { host: 'synthetic.example', cookie: 'pulse_session=staff-session', 'cf-access-authenticated-user-email': 'staff@synthetic.example', ...(auth ? { authorization: auth } : {}) } });
  const throughWeb = await catalogProxy(webRequest('items'), { params: Promise.resolve({ path: ['items'] }) });
  assert.equal(throughWeb.status, 200); assert.deepEqual(await throughWeb.json(), initial.json());
  assert.equal((await catalogProxy(webRequest('items', null), { params: Promise.resolve({ path: ['items'] }) })).status, 401, 'staff cookies never authorize catalogue reads');
  assert.equal((await createApiProxy(v0ProxyOptions)(webRequest('people'), { params: Promise.resolve({ path: ['people'] }) })).status, 403, 'staff proxy cannot fall back from catalogue keys');
  assert.equal((await get('/api/v1/catalog/items?org_id=another')).statusCode, 400);
  assert.equal((await get('/api/v1/catalog/items', { headers: { ...headers, 'x-pulse-host': 'catalog-other.example' } })).statusCode, 403);
  for (const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS']) assert.equal((await get(undefined, { method })).statusCode, 403);
  for (const url of ['/api/v0/people','/api/v0/tasks','/api/v0/documents','/api/v0/erp/items','/api/v0/erp/documents','/api/v0/finance','/api/v0/brand','/api/v1/operator/status','/healthz']) {
    for (const method of ['GET','POST']) assert.equal((await get(url, { method, headers: { ...headers, 'cf-access-authenticated-user-email': 'admin@synthetic.example', 'x-pulse-session': 'a'.repeat(43) } })).statusCode, 403, `${method} ${url}`);
  }
  for (const authorization of [undefined, 'Bearer wrong', `Bearer pcat_${id}_${'a'.repeat(43)}`]) assert.equal((await get(undefined, { headers: authorization ? { authorization } : {} })).statusCode, 401);
  const itemId = JSON.parse(process.env.TEST_ITEMS)[0];
  const { publicLink } = await manage('share', itemId);
  const listed = (await get()).json().items;
  assert.equal(listed.find(i => i.id === itemId).publicLink, publicLink);
  assert.equal(listed.filter(i => i.publicLink !== null).length, 1);
  const publicResponse = await app.inject({ url: publicLink });
  assert.equal(publicResponse.statusCode, 200, publicResponse.body);
  assert.match(publicResponse.headers['cache-control'], /no-store/);
  assert.equal(publicResponse.headers['referrer-policy'], 'no-referrer');
  const offerParts = publicLink.split('/').slice(-2);
  const publicWeb = await catalogProxy(webRequest(offerParts.join('/'), null), { params: Promise.resolve({ path: offerParts }) });
  assert.equal(publicWeb.status, 200); assert.equal(await publicWeb.text(), publicResponse.body);
  if (process.env.PULSE_CATALOG_SCREENSHOTS) {
    const { chromium } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
    const browser = await chromium.launch({ headless: true });
    try {
      for (const width of [390,1440]) for (const colorScheme of ['light','dark']) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
        await page.goto(process.env.PULSE_API_URL + publicLink);
        assert.equal(await page.locator('dd').count(), 8);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: `${process.env.PULSE_CATALOG_SCREENSHOTS}/offer-${width}-${colorScheme}.png`, fullPage: true });
        await page.close();
      }
    } finally { await browser.close(); }
  }
  assert.ok(publicResponse.body.includes('&lt;script&gt;synthetic&lt;/script&gt;'));
  assert.ok(!publicResponse.body.includes('<script>'));
  assert.deepEqual([...publicResponse.body.matchAll(/<dt>(.*?)<\/dt>/g)].map(m => m[1]).sort(), ['Offer ID','Type','Name','Description','Price before GST (INR)','Currency','GST (%)','Public link'].sort());
  assert.ok(publicResponse.body.includes('123.45'));
  for (const forbidden of ['sensitive-cost','source-secret','package-internals',...JSON.parse(process.env.TEST_ITEMS).slice(1),secret,hash]) assert.ok(!publicResponse.body.includes(forbidden));
  assert.equal((await get(publicLink)).statusCode, 403, 'a service key confers no public-link scope');
  await manage('unshare', itemId);
  assert.equal((await app.inject({ url: publicLink })).statusCode, 404);
  assert.equal((await get()).json().items.find(i => i.id === itemId).publicLink, null);
  const rotated = await manage('share', itemId);
  assert.notEqual(rotated.publicLink, publicLink);
  await manage('revoke', id);
  assert.equal((await get()).statusCode, 401);
  const nextId = randomUUID(), nextSecret = randomBytes(32).toString('base64url');
  await manage('issue', nextId, createHash('sha256').update(nextSecret).digest('hex'));
  assert.equal((await get(undefined, { headers: { authorization: `Bearer pcat_${nextId}_${nextSecret}` } })).statusCode, 200, 'new key works after rotation');
  assert.equal((await app.inject({ url: rotated.publicLink })).statusCode, 200, 'share lifetime is independent of service credentials');
  assert.equal((await app.inject({ url: '/api/v1/catalog/offers/' + 'a'.repeat(43) })).statusCode, 404);
  const invalid = await app.inject({ method: 'POST', url: '/api/v1/operator/catalog', headers: operator, payload: { action: 'issue', id: randomUUID(), hash, scope: 'finance.read' } });
  assert.equal(invalid.statusCode, 400);
  for (const sensitive of [secret,nextSecret,hash,process.env.PULSE_OPERATOR_TOKEN,publicLink,rotated.publicLink]) assert.ok(!JSON.stringify(logs).includes(sensitive), 'audit output excludes secret material');
  for (const sensitive of [secret,nextSecret,hash,process.env.PULSE_OPERATOR_TOKEN]) assert.ok(!JSON.stringify(responses).includes(sensitive), 'responses exclude service/operator secrets and digests');
  let last;
  for (let i=0;i<125;i++) last = await app.inject({ url: '/api/v1/catalog/items' });
  assert.equal(last.statusCode, 429); assert.equal(last.headers['retry-after'], '60');
  console.log('Catalogue synthetic API, scope, public-link, logging and rate-limit checks passed');
} finally { await app.close(); await pool.end(); }

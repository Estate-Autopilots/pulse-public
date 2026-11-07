// ACCEPT-SHARED (1625): the client's link over HTTP. Driven by tests/core/test_erp_accept_shared.py on real
// PostgreSQL/RLS; synthetic data only. The shared address (no company's host) opens, serves and answers a hosted
// company's link; another company's own address answers "not valid" exactly as an unknown token does.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
app.log.info = () => {}; app.log.warn = () => {};
const token = process.env.TEST_TOKEN;
const unknown = 'SyntheticUnknownAcceptToken' + 'y'.repeat(16);
const at = host => (host ? { 'x-pulse-host': host } : {});
const get = (path, host) => app.inject({ method: 'GET', url: `/api/v0/accept/${path}`, headers: at(host) });
const post = (path, host, payload) => app.inject({ method: 'POST', url: `/api/v0/accept/${path}`, headers: at(host), payload });
try {
  // Another company's own address: the hosted link is not found, the same answer as an unknown token's.
  const foreign = await get(token, process.env.TEST_OTHER_HOST);
  const missing = await get(unknown, process.env.TEST_OTHER_HOST);
  assert.equal(foreign.statusCode, 404, foreign.body);
  assert.equal(missing.statusCode, 404, missing.body);
  assert.equal(foreign.json().error ?? foreign.json().message, missing.json().error ?? missing.json().message);
  assert.equal((await get(`${token}/pdf`, process.env.TEST_OTHER_HOST)).statusCode, 404);
  const foreignDecide = await post(token, process.env.TEST_OTHER_HOST, { decision: 'accepted', name: 'Synthetic Signer' });
  const missingDecide = await post(unknown, process.env.TEST_OTHER_HOST, { decision: 'accepted', name: 'Synthetic Signer' });
  assert.equal(foreignDecide.statusCode, missingDecide.statusCode);
  assert.equal(foreignDecide.body, missingDecide.body);

  // Unknown and malformed tokens on the shared address: as before.
  assert.equal((await get(unknown)).statusCode, 404);
  assert.equal((await get('not-a-token')).statusCode, 404);
  assert.equal((await post(unknown, null, { decision: 'accepted', name: 'Synthetic Signer' })).body, missingDecide.body);

  // The shared address: open, file, decide, in the hosted company.
  const opened = await get(token);
  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal(opened.json().number, 'QT/26-27/0001');
  assert.equal(opened.json().canDecide, true);
  const pdf = await get(`${token}/pdf`);
  assert.equal(pdf.statusCode, 200, pdf.body);
  assert.match(pdf.headers['content-type'], /application\/pdf/);
  assert.equal(pdf.body, process.env.TEST_PDF);
  const decided = await post(token, null, { decision: 'accepted', name: 'Synthetic Signer', note: 'Synthetic go ahead' });
  assert.equal(decided.statusCode, 200, decided.body);
  assert.deepEqual(decided.json(), { decision: 'accepted', number: 'QT/26-27/0001' });
  const again = await get(token);
  assert.equal(again.json().decision, 'accepted');
  assert.equal(again.json().canDecide, false);

  // The hosted company's own address: unchanged, it still sees its own link.
  const own = await get(token, process.env.TEST_HOSTED_HOST);
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.json().signer, 'Synthetic Signer');
  console.log('accept-shared runner: ok');
} finally {
  await app.close();
  await pool.end();
}

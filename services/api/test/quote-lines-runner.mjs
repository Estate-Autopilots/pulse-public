// EST-1775: real routes on an isolated synthetic tenant; no browser or live-data writes.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const ids = JSON.parse(process.env.TEST_IDS);
const call = async (path, body, status = 200) => {
  const response = await app.inject({ method: body === undefined ? 'GET' : 'POST', url: '/api/v0/erp/' + path,
    headers: { 'cf-access-authenticated-user-email': `finance@${ids.domain}` }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(response.statusCode, status, response.body);
  return response.json();
};
try {
  const item = (await call(`items/${ids.item}`)).item;
  await call(`items/${ids.item}`, { ...item, addOnIds: [ids.addon] });
  assert.deepEqual((await call(`items/${ids.item}`)).item.addOns.map(a => a.itemId), [ids.addon]);
  const path = `documents/${ids.document}`, current = await call(path);
  const lines = [
    { itemId: ids.item, description: 'Synthetic system', rate: 100000, gstRate: 18 },
    { itemId: ids.addon, description: 'Synthetic add-on', rate: 10000, gstRate: 18, parentIndex: 0 },
    { description: 'Synthetic installation', rate: 0, gstRate: 18, open: true },
  ];
  await call(path, { ...current.document, lines });
  let saved = await call(path);
  assert.equal(saved.lines[1].parentIndex, 0);
  assert.equal(saved.lines[1].parentLineId, saved.lines[0].id);
  assert.equal(saved.lines[2].open, true);
  assert.equal(saved.document.taxable, 110000);
  assert.equal((await call(path + '/issue', {}, 400)).error, 'Fill each open amount or mark it not needed');
  await call(path, { ...current.document, lines: lines.map((line, i) => ({ ...line, notNeeded: i !== 1 })) });
  saved = await call(path);
  assert.deepEqual(saved.lines.map(line => line.notNeeded), [true, true, true]);
  assert.equal(saved.document.total, 0);
  await call(path, { ...current.document, lines: lines.map((line, i) => ({ ...line, notNeeded: i === 2 })) });
  saved = await call(path);
  assert.deepEqual(saved.lines.map(line => line.notNeeded), [false, false, true]);
  assert.equal(saved.document.taxable, 110000);
} finally {
  await app.close(); await pool.end();
}

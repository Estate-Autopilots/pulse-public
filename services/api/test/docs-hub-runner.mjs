// DOCS-HUB (owner, 21 Nov 2026): Billing → Documents' search and the AI's find_documents on real PostgreSQL and tenant
// row security. Run by tests/core/test_docs_hub_search.py, which seeds the synthetic documents (a…h). Synthetic data only.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
const { createApp } = await import('../dist/app.js');

const W = JSON.parse(process.env.TEST_W), I = W.ids;
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 4 }), app = createApp(pool, pool);
const as = (who) => ({ 'cf-access-authenticated-user-email': `${who}@${W.domain}` });
const search = async (q, extra = '', who = 'finance', status = 200) => {
  const r = await app.inject({ method: 'GET', url: `/api/v0/erp/documents/search?q=${encodeURIComponent(q)}${extra}`, headers: as(who) });
  assert.equal(r.statusCode, status, `${q}: ${r.statusCode} ${r.body.slice(0, 600)}`);
  return r.json();
};
const ids = (res) => res.documents.map((d) => d.id);
// The seeded client's name (W.client): the public mirror renames real company names in the source but not a typo or an
// encoded form of them, so those are made from the name here, never written out.
const client = W.client.split(' ').slice(0, 2).join(' ').toLowerCase(), typo = client.replace(/(\s\S)[aeiou]/, '$1y');
const key = (id) => Object.keys(I).find((k) => I[k] === id) ?? id;
const keys = (res) => ids(res).map(key).sort();
let T;
try {
  // 1. The owner's own ask: exactly the one Willow Lane invoice from last month over ₹1,00,000, said back in plain words.
  let r = await search("find last month's invoices for Willow Lane over 1 lakh");
  assert.deepEqual(keys(r), ['a']);
  assert.equal(r.closer, false);
  assert.deepEqual([r.understood[0], r.understood[2], r.understood[3]], ['Invoices', 'Over ₹1 lakh', 'Matching “willow lane”']);
  assert.match(r.understood[1], /^Last month: /);
  assert.equal(r.documents[0].why, 'client');
  assert.equal(r.documents[0].number, 'SYN/INV/0001', 'the screen gets the same row as its list');

  // 2. Spaces, case and punctuation never matter; every field and line is searched; the best place is named.
  assert.deepEqual(keys(await search('willowlane')), ['a', 'b', 'c', 'g', 'h']);
  r = await search('SYN/QT/0007');
  assert.deepEqual([key(r.documents[0].id), r.documents[0].why], ['e', 'number']);
  r = await search('purepower 5');
  assert.deepEqual([keys(r), r.documents[0].why, r.documents[0].whyText], [['e'], 'item', 'Synthetic PurePower 5.0 kW solar system']);
  r = await search('98765 43210');
  assert.deepEqual([keys(r), r.documents[0].why], [['f'], 'contact']);
  r = await search('27AABCS5678K1ZS');
  assert.deepEqual([keys(r), r.documents[0].why], [['a', 'b', 'c', 'g', 'h'], 'contact']);

  // 3. States, amounts and kinds from the words, or from the screen's chips.
  assert.deepEqual(keys(await search('unpaid invoices')), ['a', 'c', 'd']);
  assert.deepEqual(keys(await search('overdue')), ['a']);
  assert.deepEqual(keys(await search('quotes not sent yet')), ['e', 'h']);
  assert.deepEqual(keys(await search('drafts')), ['f']);
  assert.deepEqual(keys(await search('₹1,18,000')), ['g']);
  assert.deepEqual(keys(await search('majestic', '&type=quotation')), ['e']);
  assert.deepEqual(keys(await search('', '&state=paid')), ['b']);

  // 4. A slip of the keyboard: nothing has every word, so the closest names come back, marked as such.
  r = await search(typo);
  assert.equal(r.closer, true);
  assert.ok(['a', 'b', 'c', 'g', 'h'].every((k) => ids(r).includes(I[k])), `closest: ${keys(r)}`);
  assert.equal(r.documents[0].why, 'closer');
  assert.deepEqual((await search('zzqx nothing like this')).documents, []);

  // 5. Who may search: a member without Billing is refused; a sales seat finds only its own deal.
  await search('willow lane', '', 'member', 403);
  assert.deepEqual(keys(await search('willow lane', '', 'seller')), ['h']);

  // 6. The AI's find_documents (API v1, a Billing reader's key): the same answer, with rupees, the state and a link.
  const t = await app.inject({ method: 'POST', url: '/api/v0/api-tokens', headers: as('finance'), payload: { name: 'DOCS-HUB (synthetic)', scopes: ['billing.read'], days: 1 } });
  assert.equal(t.statusCode, 201, t.body); T = t.json().token;
  const find = async (qs) => {
    const x = await app.inject({ method: 'GET', url: `/api/v1/billing/documents?${qs}`, headers: { authorization: `Bearer ${T}` } });
    assert.equal(x.statusCode, 200, `${qs}: ${x.statusCode} ${x.body.slice(0, 600)}`);
    return x.json();
  };
  let f = await find(`query=${encodeURIComponent("last month's invoices for Willow Lane over 1 lakh")}`);
  assert.equal(f.items.length, 1);
  const a = f.items[0];
  assert.deepEqual([a.id, a.kind, a.kindLabel, a.number, a.client, a.state, a.stateLabel, a.totalRupees, a.dueRupees, a.date, a.foundIn],
    [I.a, 'invoice', 'Tax invoice', 'SYN/INV/0001', 'Willow Lane Synthetic Pvt Ltd', 'overdue', 'Overdue', '₹1,50,000', '₹1,50,000', W.last, 'the client']);
  assert.match(a.url, new RegExp(`/erp/documents/${I.a}$`));
  f = await find(`query=${encodeURIComponent(client)}&kind=invoice&minRupees=100000`);
  assert.deepEqual(f.items.map((x) => key(x.id)).sort(), ['a', 'c']);
  assert.deepEqual(f.items.find((x) => x.id === I.c).stateLabel, 'Not sent yet');
  f = await find(`query=${encodeURIComponent('purepower')}`);
  assert.deepEqual([f.items.map((x) => key(x.id)), f.items[0].foundIn], [['e'], 'an item: Synthetic PurePower 5.0 kW solar system']);
  f = await find(`state=part_paid`);
  assert.deepEqual([f.items.map((x) => key(x.id)), f.items[0].dueRupees], [['d'], '₹2,00,000']);
  f = await find(`query=${encodeURIComponent(typo)}&limit=5`);
  assert.equal(f.closer, true);
  console.log('docs-hub runner: ok');
} finally {
  await app.close?.();
  await pool.end();
}

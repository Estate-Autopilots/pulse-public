// POLISH-1115 (owner, 14 Nov 2026): a contract has layers, a cover and contents, and a signature prints as crisp vector ink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { buildContractModel, contractLayers, definedTerms, pngWithVector, renderContractPdf, starterSource, tidyVector, vectorOfPng, FONT_URLS } from '../src/index.js';

const parties = [{ name: 'Lotus Interiors Private Limited', type: 'private_limited', defined: 'Provider', reg: 'U74999MH2020PTC000001' }, { name: 'Harbor Builders LLP', type: 'llp', defined: 'Client' }];

test('a service agreement reads as its layers, each clause in one layer, with the deal facts that belong to it', () => {
  const layers = contractLayers(starterSource('service', { parties, deal: { fee: '₹40,000 a month', notice: '30 days', city: 'Pune' } }));
  const by = Object.fromEntries(layers.map((l) => [l.key, l]));
  assert.deepEqual(layers.map((l) => l.key), ['parties', 'money', 'duties', 'ip', 'term', 'law', 'general', 'schedules']);
  assert.deepEqual(by.parties.parties.map((p) => p.defined), ['Provider', 'Client']);
  assert.deepEqual(by.money.clauses.map((c) => c.title), ['Fees and payment']);
  assert.deepEqual(by.money.facts, [{ label: 'Fee', value: '₹40,000 a month' }]);
  assert.deepEqual(by.term.facts, [{ label: 'Notice period', value: '30 days' }]);
  assert.deepEqual(by.schedules.clauses.map((c) => c.number), ['Schedule 1']);
  assert.deepEqual(by.general.terms, ['Services', 'Fee', 'Effective Date']);
  const all = layers.flatMap((l) => l.clauses.filter((c) => /^\d+$/.test(c.number)).map((c) => c.number)).sort();
  assert.deepEqual(all, ['1', '2', '3', '4', '5', '6'], 'every clause is in exactly one layer');
});

test('the other contract types sort their own clauses (an advance is money, an appointment is a duty)', () => {
  const loan = Object.fromEntries(contractLayers(starterSource('loan')).map((l) => [l.key, l.clauses.map((c) => c.title)]));
  assert.deepEqual(loan.money, ['Nature of the advance', 'No interest']);
  assert.deepEqual(loan.duties, ['Acknowledgement']);
  const offer = Object.fromEntries(contractLayers(starterSource('offer')).map((l) => [l.key, l.clauses.map((c) => c.title)]));
  assert.deepEqual(offer.money, ['Pay']); assert.deepEqual(offer.term, ['Probation and notice']); assert.deepEqual(offer.ip, ['Confidentiality']);
  assert.deepEqual(definedTerms('The "Purpose" means x. Each of them (the “Company”) and "Purpose" means y.'), ['Purpose', 'Company']);
});

test('a signature vector rides inside its PNG, and a tampered or unsafe one is refused', () => {
  // A 1×1 transparent PNG.
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  const v = { v: 1, box: [2, 3, 180, 60], d: ['M2 30 Q40 3 80 40 Q120 63 182 20'], stroke: 2.4 };
  const withV = pngWithVector(png, v);
  assert.ok(withV.length > png.length);
  assert.deepEqual(vectorOfPng(withV), v);
  assert.equal(vectorOfPng(png), null, 'a plain PNG has none');
  assert.deepEqual(vectorOfPng(pngWithVector(withV, { ...v, stroke: 3 })).stroke, 3, 'writing again replaces, never doubles');
  const bad = Uint8Array.from(withV); bad[bad.length - 30] ^= 0xff;
  assert.equal(vectorOfPng(bad), null, 'a changed byte fails the CRC');
  assert.equal(tidyVector({ box: [0, 0, 10, 10], d: ['M0 0 L10 10"><script>'] }), null, 'only path commands and numbers');
  assert.equal(tidyVector({ box: [0, 0, 0, 10], d: ['M0 0 L1 1'] }), null);
  assert.equal(pngWithVector(png, { box: [0, 0, 10, 10], d: ['javascript:'] }), png, 'an unusable vector leaves the PNG as it was');
});

test('a contract with its facts opens on a cover and contents, and every part is a bookmark', async () => {
  const fonts = { regular: new Uint8Array(await readFile(FONT_URLS.regular)), semibold: new Uint8Array(await readFile(FONT_URLS.semibold)) };
  const body = starterSource('service', { date: '2026-11-15', place: 'Pune', parties, deal: { fee: '₹40,000 a month', gst: 'plus GST', billing: 'monthly', start: '1 November 2026', review: '1 May 2027', notice: '30 days', city: 'Pune' } });
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  const image = pngWithVector(png, { v: 1, box: [0, 0, 100, 40], d: ['M0 0 L100 0 L100 40 L0 40 Z M20 10 L80 10 L80 30 L20 30 Z'] });
  const rows = [{ name: parties[0].name, signer: 'Kedab Mifos', signedAt: '15 Nov 2026', signKind: 'typed' }, { name: parties[1].name, signer: 'Diya Nair', signedAt: '15 Nov 2026', signKind: 'uploaded', image }];
  const model = buildContractModel({}, { title: 'Master Service Agreement', body, status: 'active', version: 1, parties: rows, audit: [{ at: '15 Nov', what: 'Signed' }], sha256: 'ab'.repeat(32) });
  assert.equal(model.cover, true);
  assert.ok(model.parties[1].sign.vector, 'the photo signature carries its vector to the PDF');
  const { bytes, pages } = await renderContractPdf(model, { fonts });
  const s = Buffer.from(bytes).toString('latin1');
  assert.ok(pages >= 5, `cover + contents + body + certificate (${pages})`);
  assert.match(s, /\/Outlines/);
  const titles = [...s.matchAll(/\/Title <FEFF([0-9A-F]+)>/g)].map((m) => Buffer.from(m[1], 'hex').swap16().toString('utf16le'));
  for (const t of ['Cover', 'Contents', 'Parties', '1. Definitions', '3. Fees and payment', 'Schedule 1: The detailed sheet', 'Signatures', 'Certificate of signing']) assert.ok(titles.includes(t), `bookmark ${t} in ${titles.join(' | ')}`);
  const ops = [...s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map((m) => { try { return inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { return ''; } }).join('\n');
  assert.match(ops, /\nf\*\n/, 'the traced photo is filled even-odd (its holes stay open)');
  // An older contract with no facts line keeps its first page as it was (no cover).
  const old = buildContractModel({}, { title: 'Old', body: '1. Scope of work\nThe work.', status: 'draft', version: 1 });
  assert.equal(old.cover, false);
});

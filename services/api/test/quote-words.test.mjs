// BHARATA-2: a quotation asked in words is matched against the catalogue on the server (src/quote-words.ts). Synthetic
// catalogues: the suite's (names with "kW solar system") and one shaped like a real install's ("<thing> for <product> N").
import test from 'node:test';
import assert from 'node:assert/strict';
import { normWords, parseWords, pickItem, draftReply, langOf } from '../dist/quote-words.js';

let n = 0;
const item = (code, name, price = 100000, gstRate = 18) => ({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, code, name, price, gstRate });
const SUITE = [
  item('PP-3.0', 'PuREPower 3.0 kW solar system', 9500000, 5), item('PP-5.0', 'PuREPower 5.0 kW solar system', 14000000, 5), item('PP-12.0', 'PuREPower 12.0 kW solar system', 31000000, 5),
  item('PP-15.0L', 'PuREPower 15.0L kW solar system (Lite)', 34000000, 5), item('AO-EXW7-3.0', 'Extended warranty (+7 years) for PuREPower 3.0'),
  item('AO-EXW7-5.0', 'Extended warranty (+7 years) for PuREPower 5.0'), item('AO-EXW7-12.0', 'Extended warranty (+7 years) for PuREPower 12.0'),
  item('AO-ACDB-5.0', 'ACDB for PuREPower 5.0'), item('AO-DCDB-5.0', 'DCDB for PuREPower 5.0'), item('AO-ESS-DONGLE', 'Smart ESS dongle'),
  item('SV-INSTALL', 'Installation & commissioning'), item('SV-DELIVERY', 'Delivery & transport', 0), item('LiBRM-GROMMET', 'Rubber grommet (spare part)', 1500),
];
const SIZES = ['3.0', '3.0L', '5.0', '12.0', '15.0L', '20.0', '60.0'];
const lite = (s) => (s.endsWith('L') ? `${s.slice(0, -1)} Lite` : s);
const SHOP = [
  ...SIZES.map((s) => item(`PP-${s}`, `PuREPower ${lite(s)}`, 10000000, 5)),
  ...SIZES.map((s) => item(`AO-ACDB-${s}`, `AC Distribution Box (ACDB) for PuREPower ${lite(s)}`)),
  ...SIZES.map((s) => item(`AO-DCDB-${s}`, `DC Distribution Box (DCDB) for PuREPower ${lite(s)}`)),
  ...SIZES.map((s) => item(`AO-DONGLE-${s}`, `Smart ESS Dongle for PuREPower ${lite(s)}`, 300000, 5)),
  ...SIZES.map((s) => item(`AO-EXW7-${s}`, `Extended warranty (+7 years) for PuREPower ${lite(s)}`)),
  ...SIZES.map((s) => item(`AO-PACK-${s}`, `Packing and handling charges for PuREPower ${lite(s)}`)),
  item('SV-AMC', 'Annual maintenance contract (AMC)', 0), item('SV-DELIVERY', 'Delivery & transport', 0), item('SV-INSTALL', 'Installation & commissioning', 0),
  item('SV-SURVEY', 'Site survey & load assessment', 0), item('LiBRM-GROMMET', 'Rubber Grommet PurePower', 1500), item('LiBRM-FAN', 'Cooling fan 12V PurePower', 90000),
];
const code = (p) => (p.kind === 'item' ? p.item.code : p.kind);

test('numbers: digits, English, Hindi and Marathi words, Devanagari digits; durations, percentages and rupees are not sizes', () => {
  assert.equal(normWords('पाँच किलोवाट सोलर सिस्टम'), '5 kw solar system');
  assert.equal(normWords('बारा किलोवॅट सिस्टम'), '12 kw system');
  assert.equal(normWords('five kilowatt'), '5 kw');
  assert.equal(normWords('paanch kilowatt'), '5 kw');
  assert.deepEqual(parseWords('१२ kW').sizes, [12]);
  assert.deepEqual(parseWords('10-year warranty').sizes, []);
  assert.deepEqual(parseWords('दस साल की वारंटी').sizes, []);
  assert.deepEqual(parseWords('transport ₹4,000').sizes, []);
  assert.deepEqual(parseWords('5% off the 3 kW system').sizes, [3]);
});

for (const [name, cat] of [['suite catalogue', SUITE], ['install-shaped catalogue', SHOP]]) {
  test(`${name}: the system, its warranty and add-ons, installation and transport`, () => {
    assert.equal(code(pickItem('5 kW system', cat)), 'PP-5.0');
    assert.equal(code(pickItem('5 kW rooftop solar system', cat)), 'PP-5.0');
    assert.equal(code(pickItem('12 kW system', cat)), 'PP-12.0');
    assert.equal(code(pickItem('3 kW', cat)), 'PP-3.0', 'a Lite model only when Lite is said');
    assert.equal(code(pickItem('15 kW Lite system', cat)), 'PP-15.0L');
    assert.equal(code(pickItem('पाँच किलोवाट सोलर सिस्टम', cat)), 'PP-5.0');
    assert.equal(code(pickItem('10-year warranty', cat, [5])), 'AO-EXW7-5.0', 'the size comes from the main product');
    assert.equal(code(pickItem('10 year warranty for 12 kW', cat)), 'AO-EXW7-12.0');
    assert.equal(code(pickItem('दस साल की वारंटी', cat, [3])), 'AO-EXW7-3.0');
    assert.equal(code(pickItem('ACDB', cat, [5])), 'AO-ACDB-5.0');
    assert.equal(code(pickItem('DCDB for 5 kW', cat)), 'AO-DCDB-5.0');
    assert.equal(code(pickItem('installation', cat)), 'SV-INSTALL');
    assert.equal(code(pickItem('Installation & commissioning', cat)), 'SV-INSTALL');
    assert.equal(code(pickItem('transport', cat)), 'SV-DELIVERY');
    assert.equal(code(pickItem('वाहतूक', cat)), 'SV-DELIVERY');
    assert.equal(code(pickItem('delivery', cat)), 'SV-DELIVERY');
    assert.equal(code(pickItem('PP-12.0', cat)), 'PP-12.0', 'a code said is that item');
    assert.equal(code(pickItem('AO-EXW7-5.0', cat)), 'AO-EXW7-5.0');
    assert.equal(code(pickItem('PP-5.0 5 kW system', cat)), 'PP-5.0', 'a code in front of the words');
    assert.equal(code(pickItem('SV-DELIVERY', cat)), 'SV-DELIVERY');
  });
  test(`${name}: nothing is guessed (missing item, a size it does not have, two that fit)`, () => {
    assert.equal(code(pickItem('10 kWh lithium battery bank', cat)), 'none');
    assert.equal(code(pickItem('diesel generator', cat)), 'none');
    assert.equal(code(pickItem('water pump', cat)), 'none');
    const misheard = pickItem('1.5 kW solar system', cat);
    assert.equal(misheard.kind, 'size-missing', 'a voice note heard "1.5 kW": ask which size');
    assert.ok(misheard.choices.some((c) => c.code === 'PP-3.0') && misheard.choices.every((c) => /^PP-/.test(c.code)));
    assert.equal(pickItem('extended warranty', cat).kind, 'ambiguous', 'no size and no main product: which one');
  });
}
test('heard, not typed: a count run into the size ("one five kilowatt" as "1.5 kW") is that count of the sold size', () => {
  for (const cat of [SUITE, SHOP]) {
    const five = pickItem('1.5 kW solar system', cat, [], { heard: true });
    assert.equal(code(five), 'PP-5.0'); assert.deepEqual(five.heardAs, { said: 1.5, count: 1, size: 5 });
    const twelve = pickItem('1.12 kW PuREPower system', cat, [], { heard: true });
    assert.equal(code(twelve), 'PP-12.0'); assert.deepEqual(twelve.heardAs, { said: 1.12, count: 1, size: 12 });
    assert.equal(pickItem('1.5 kW solar system', cat).kind, 'size-missing', 'typed: still asked');
    assert.equal(pickItem('1.7 kW solar system', cat, [], { heard: true }).kind, 'size-missing', 'no such size either way: asked');
  }
  assert.equal(code(pickItem('2.5 kW system', SUITE, [], { heard: true })), 'PP-5.0');
  const run = pickItem('112 kW system', SUITE, [], { heard: true });
  assert.equal(code(run), 'PP-12.0'); assert.deepEqual(run.heardAs, { said: 112, count: 1, size: 12 }, 'the recording heard "one twelve kilowatt" as "112 kW"');
  assert.deepEqual(pickItem('25 kW system', SUITE, [], { heard: true }).heardAs, { said: 25, count: 2, size: 5 });
  assert.equal(code(pickItem('15 kW Lite system', SUITE, [], { heard: true })), 'PP-15.0L', 'a sold size is never re-read');
  assert.equal(pickItem('112 kW system', SUITE).kind, 'size-missing', 'typed: asked');
});

test('a real catalogue\'s spare parts: the add-on for the main product wins, and size questions list the products first', () => {
  const parts = [...SHOP, item('LiBRM-DCDB2202', 'DCDB 2-In 2-Out 12.0 PurePower', 1699900), item('LiBRM-BOX20', 'Wooden Packing Box - 20.0', 867300), item('LiBRM-MCB', '1P DC MCB 125A', 71400)];
  assert.equal(code(pickItem('DCDB', parts, [12], { main: 'PuREPower 12.0' })), 'AO-DCDB-12.0');
  assert.equal(code(pickItem('packing', parts, [20], { main: 'PuREPower 20.0' })), 'AO-PACK-20.0');
  assert.equal(code(pickItem('DCDB for 12 kW', parts, [], { main: 'PuREPower 12.0' })), 'AO-DCDB-12.0');
  const sizes = pickItem('1.5 kW solar system', parts);
  assert.equal(sizes.kind, 'size-missing'); assert.ok(sizes.choices.slice(0, 3).every((c) => /^PP-/.test(c.code)), sizes.choices.map((c) => c.code).join());
});

test('the dongle: one item in one catalogue, one per size in the other', () => {
  assert.equal(code(pickItem('Smart ESS dongle', SUITE)), 'AO-ESS-DONGLE');
  assert.equal(code(pickItem('Smart ESS dongle', SHOP, [5])), 'AO-DONGLE-5.0');
  assert.equal(code(pickItem('dongle', SHOP, [12])), 'AO-DONGLE-12.0');
  assert.equal(code(pickItem('packing', SHOP, [5])), 'AO-PACK-5.0');
  assert.equal(code(pickItem('grommet', SHOP)), 'LiBRM-GROMMET', 'a spare part when it is named');
});

test('the answer: lines, total, the link, in English, Hindi and Marathi', () => {
  const d = { id: 'x', url: 'https://app.example/erp/documents/x', status: 'draft', number: null, buyer: 'Mifos Traders', total: 18299000, roundOff: 0,
    lines: [{ description: 'PuREPower 5.0', qty: 1, rate: 14000000, gstRate: 5, total: 14700000 }] };
  const en = draftReply('en', d, { status: 'drafted', created: true });
  assert.match(en, /Draft quotation for Mifos Traders \(new client, added\)/);
  assert.match(en, /₹1,40,000/); assert.match(en, /Total ₹1,82,990 incl\. GST/); assert.match(en, /erp\/documents\/x/); assert.match(en, /Submit it for approval\?/);
  assert.match(draftReply('hi', d, { status: 'drafted', submittedTo: 'TEST Owner' }), /TEST Owner को मंज़ूरी के लिए भेज दिया है/);
  assert.match(draftReply('mr', { ...d, waitingFor: 'TEST Owner' }, { status: 'existing', reused: true }), /मंजुरीची वाट[^]*$/);
  assert.match(draftReply('en', d, { status: 'existing', reused: true }), /existing draft with the same lines/);
  assert.doesNotMatch(draftReply('en', d, { status: 'existing' }), /existing draft/);
  assert.equal(langOf(undefined, 'देसाई डेयरी'), 'hi'); assert.equal(langOf('mr'), 'mr'); assert.equal(langOf('fr', 'hello'), 'en');
});

// WL-FOLLOWUP (17 Nov 2026): "assign Savuzo a task …" by voice became a new client named after a colleague and a draft
// quotation. A colleague's name is never a new client. Invented names only.
test('a new client name that is a colleague is that colleague, however it is written', async () => {
  const { colleagueNamed, words } = await import('../dist/quote-words.js');
  const team = [{ name: 'Rifob Dorugohum' }, { name: 'Meera Kulkarnī' }, { name: 'Ira' }];
  assert.equal(colleagueNamed('Rifob Dorugohum', team), 'Rifob Dorugohum');
  assert.equal(colleagueNamed('  rifob   DORUGOHUM ', team), 'Rifob Dorugohum');
  assert.equal(colleagueNamed('Meera Kireteso', team), 'Meera Kulkarnī');
  assert.equal(colleagueNamed('Dorugohum Rifob', team), 'Rifob Dorugohum');
  assert.equal(colleagueNamed('ira', team), 'Ira');
  // One shared first name, or a real client with a colleague's surname, is not a colleague.
  assert.equal(colleagueNamed('Rifob', team), null);
  assert.equal(colleagueNamed('Dorugohum Dairy', team), null);
  assert.equal(colleagueNamed('Rifob Dorugohum Traders Pvt Ltd', team), null);
  assert.equal(colleagueNamed('', team), null);
  for (const l of ['en', 'hi', 'mr']) assert.match(words(l).colleague('Rifob Dorugohum'), /Rifob Dorugohum.*(task|टास्क)/s);
});

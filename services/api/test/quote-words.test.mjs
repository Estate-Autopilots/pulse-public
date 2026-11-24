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

// AI-FIX (BUG-CENSUS BC-008): read from Willow Lane's own catalogue (WL-FABLE-AITASKS §1), a word said that the item lacks
// took the item anyway: "PuREPower 5.0 cover" became the ₹1,42,856 unit, "5 kW system AMC" the unit, and on the QA
// company "QA journey item (synthetic)" its one solar system, which the company's rule then issued.
test('an item that lacks a word said is only near: never taken by itself, and an item with every word wins', () => {
  const cover = pickItem('PuREPower 5.0 cover', SHOP);
  assert.equal(cover.kind, 'near'); assert.equal(cover.item.code, 'PP-5.0'); assert.deepEqual(cover.missing, ['cover']);
  assert.deepEqual(cover.choices.map((c) => c.code), ['PP-5.0'], 'the nearest is named, to ask about');
  const lite = pickItem('PuREPower Lite cover', SHOP);
  assert.equal(lite.kind, 'near'); assert.ok(lite.choices.length >= 2 && lite.choices.every((c) => /^PP-.*L$/.test(c.code)), lite.choices.map((c) => c.code).join());
  assert.equal(pickItem('PuREPower 12.0 stand', SHOP).kind, 'near');
  assert.equal(code(pickItem('5 kW system AMC', SHOP)), 'SV-AMC', 'the AMC, not the 5 kW unit');
  const qa = [item('QA-PP5', 'QA PuREPower 5 kW solar system (synthetic)', 28000000, 12)];
  assert.equal(pickItem('QA journey item (synthetic)', qa).kind, 'near');
  assert.equal(pickItem('QA journey item', qa).kind, 'none');
  // Filler said around the thing does not make it near; the plain asks still pick.
  assert.equal(code(pickItem('5 kW system chahiye', SHOP)), 'PP-5.0');
  assert.equal(code(pickItem('PuREPower 5.0', SHOP)), 'PP-5.0');
  assert.equal(code(pickItem('ACDB', SHOP, [5])), 'AO-ACDB-5.0');
  assert.equal(code(pickItem('grommet', SHOP)), 'LiBRM-GROMMET');
  assert.equal(code(pickItem('QA-PP5', qa)), 'QA-PP5', 'a code said is still that item');
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
  // The accented pair uses a surname the public mirror does not rename: it renames real names written plainly
  // ("Kireteso"), not their accented spelling ("Kulkarnī"), so that pair stopped matching there (hosted run 44147397679).
  const team = [{ name: 'Rifob Dorugohum' }, { name: 'Meera Wanikarī' }, { name: 'Ira' }];
  assert.equal(colleagueNamed('Rifob Dorugohum', team), 'Rifob Dorugohum');
  assert.equal(colleagueNamed('  rifob   DORUGOHUM ', team), 'Rifob Dorugohum');
  assert.equal(colleagueNamed('Meera Wanikari', team), 'Meera Wanikarī');
  assert.equal(colleagueNamed('Dorugohum Rifob', team), 'Rifob Dorugohum');
  assert.equal(colleagueNamed('ira', team), 'Ira');
  // One shared first name, or a real client with a colleague's surname, is not a colleague.
  assert.equal(colleagueNamed('Rifob', team), null);
  assert.equal(colleagueNamed('Dorugohum Dairy', team), null);
  assert.equal(colleagueNamed('Rifob Dorugohum Traders Pvt Ltd', team), null);
  assert.equal(colleagueNamed('', team), null);
  for (const l of ['en', 'hi', 'mr']) assert.match(words(l).colleague('Rifob Dorugohum'), /Rifob Dorugohum.*(task|टास्क)/s);
});

// QUOTE-FAST (18 Nov 2026): a seller asked bhrātā for a 5 kW quotation and had the PDF 24 minutes later. An AI employee's
// quotation for a known client at catalogue prices goes for approval in the same call (no "Submit it for approval?"),
// the answer says the PDF comes to the chat, and the PDF's own line names who approved it. Invented names only.
test('an AI employee submits a plain catalogue quotation at once and says the PDF comes to the chat', async () => {
  const { submitsAtOnce, readyLines } = await import('../dist/quote-words.js');
  const cat = [{ itemId: 'a', qty: 1 }, { itemId: 'b', qty: 2 }];
  assert.equal(submitsAtOnce({ ai: true, submit: undefined, created: false, assumed: 0, lines: cat }), true);
  assert.equal(submitsAtOnce({ ai: true, submit: false, created: false, assumed: 0, lines: cat }), false, 'only a draft was asked for');
  assert.equal(submitsAtOnce({ ai: false, submit: undefined, created: false, assumed: 0, lines: cat }), false, 'a person decides themselves');
  assert.equal(submitsAtOnce({ ai: false, submit: true, created: false, assumed: 0, lines: null }), true);
  assert.equal(submitsAtOnce({ ai: true, submit: undefined, created: true, assumed: 0, lines: cat }), false, 'a client just added is checked first');
  assert.equal(submitsAtOnce({ ai: true, submit: undefined, created: false, assumed: 1, lines: cat }), false, 'a sound-alike or a heard size is checked first');
  assert.equal(submitsAtOnce({ ai: true, submit: undefined, created: false, assumed: 0, lines: [...cat, { itemId: 'c', rate: 5000 }] }), false, 'a price away from the catalogue');
  assert.equal(submitsAtOnce({ ai: true, submit: undefined, created: false, assumed: 0, lines: [{ itemId: 'a', discountPercent: 4 }] }), false, 'a discount');
  assert.equal(submitsAtOnce({ ai: true, submit: undefined, created: false, assumed: 0, lines: [{ description: 'diesel generator', rate: 4500000 }] }), false, 'a line not in the catalogue');
  assert.equal(submitsAtOnce({ ai: true, submit: undefined, created: false, assumed: 0, lines: [] }), false);

  const d = { id: 'x', url: 'https://app.example/erp/documents/x', status: 'draft', number: null, buyer: 'TEST Fagare Farms', total: 14999900, roundOff: 0,
    lines: [{ description: 'TEST Sunbox 5.0', qty: 1, rate: 14285619, gstRate: 5, total: 14999900 }] };
  const sent = draftReply('en', { ...d, waitingFor: 'TEST Owner' }, { status: 'drafted', submittedTo: 'TEST Owner', pdfLater: true });
  assert.match(sent, /Submitted to TEST Owner for approval\. I will post the PDF here as soon as it is approved\.$/);
  assert.doesNotMatch(sent, /Submit it for approval\?/);
  assert.match(draftReply('hi', { ...d, waitingFor: 'TEST Owner' }, { status: 'existing', pdfLater: true }), /मंज़ूर होते ही PDF यहीं भेज दूँगा।$/);
  const ruled = draftReply('en', { ...d, status: 'issued', number: 'QT/26-27/0009' }, { status: 'drafted', byRule: 20000000, pdfHere: true });
  assert.match(ruled, /^Quotation QT\/26-27\/0009 for TEST Fagare Farms:/);
  assert.match(ruled, /Approved at once by the company's rule \(catalogue prices, no discount, up to ₹2,00,000\)\. The PDF is in this chat\.$/);
  assert.doesNotMatch(draftReply('en', { ...d, status: 'issued', number: 'QT/26-27/0009' }, { status: 'drafted', byRule: 20000000 }), /PDF/);

  const line = readyLines({ number: 'QT/26-27/0002', buyer: 'TEST Fagare Farms', total: 14999900, by: 'TEST Owner' });
  assert.equal(line.en, 'QT/26-27/0002 for TEST Fagare Farms is approved by TEST Owner: ₹1,49,999 incl. GST. Here is the PDF.');
  assert.match(line.hi, /TEST Owner ने मंज़ूर/); assert.match(line.mr, /TEST Owner यांनी मंजूर/);
  assert.equal(readyLines({ number: 'QT/26-27/0003', buyer: '', total: 100, by: null }).en, 'QT/26-27/0003 for the client is approved: ₹1 incl. GST. Here is the PDF.');
});

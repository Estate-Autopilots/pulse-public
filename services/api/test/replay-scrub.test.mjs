// DITASU-FIX (owner, 17 Nov 2026): in production every one of Datup's replays stopped within 1-3 minutes, each time he
// opened a task or a deal: the API refused a chunk as "typed text" (replay-model.ts unmaskedText) and the recorder then
// gave up for the rest of the page. The device now masks, before sending, everything the API would refuse
// (apps/web/app/lib/friction.mjs scrubReplay), and text in boxes people type in (contentEditable comment and chat
// composers, which rrweb's input masking never saw) is masked letter for letter. This checks the two sides agree.
import assert from 'node:assert/strict';
import test from 'node:test';
import { unmaskedText } from '../dist/replay-model.js';
import { replayText, scrubReplay, TYPED_SELECTOR } from '../../../apps/web/app/lib/friction.mjs';

const at = Date.UTC(2026, 10, 17, 9, 24);
const el = (tagName, attributes = {}, childNodes = []) => ({ type: 2, tagName, attributes, childNodes, id: Math.floor(Math.random() * 1e6) });
const text = (textContent) => ({ type: 3, textContent, id: Math.floor(Math.random() * 1e6) });

/** A task page as rrweb saw it: a textarea React filled with its default text, an input whose value attribute was
 *  synced, a select, an input event, and the comment box (contentEditable) with words in it. */
function taskPage() {
  return [
    { type: 2, timestamp: at, data: { node: { type: 0, childNodes: [el('html', {}, [el('body', {}, [
      el('h1', {}, [text('Collect all past finance records')]),
      el('textarea', { name: 'notes' }, [text('Ask the CA for the March bank file')]),
      el('input', { type: 'text', value: 'Invoices and receipts' }),
      el('select', { value: 'in_progress' }, [el('option', { value: 'in_progress' }, [text('Doing')])]),
      el('input', { type: 'checkbox', value: 'on' }),
    ])])] } } },
    { type: 3, timestamp: at + 500, data: { source: 0, texts: [], removes: [], attributes: [{ id: 7, attributes: { value: 'Due Friday' } }],
      adds: [{ parentId: 3, nextId: null, node: el('textarea', {}, [text('A second note typed here')]) }] } },
    { type: 3, timestamp: at + 900, data: { source: 5, id: 9, text: 'call the bank', isChecked: false } },
  ];
}

test('the API refuses the raw page (what stopped the recorder in production)', () => {
  assert.ok(unmaskedText(taskPage()));
});

test('after the device scrubs it, the API stores it: nothing typed is readable and the page text stays', () => {
  const events = taskPage();
  const fixed = scrubReplay(events);
  assert.ok(fixed >= 5, `masked ${fixed}`);
  assert.equal(unmaskedText(events), null, 'the server check passes');
  const json = JSON.stringify(events);
  for (const typed of ['Ask the CA', 'Invoices and receipts', 'Due Friday', 'A second note', 'call the bank'])
    assert.ok(!json.includes(typed), `${typed} is gone`);
  const select = events[0].data.node.childNodes[0].childNodes[0].childNodes[3];
  assert.match(select.attributes.value, /^\*+$/, "the select's chosen value is masked (its option list is not typed text)");
  assert.ok(json.includes('Collect all past finance records'), 'a heading is not typed text and stays readable');
  assert.ok(json.includes('"value":"on"'), 'a checkbox is not typed text');
  assert.equal(scrubReplay(events), 0, 'a second pass finds nothing');
});

test('text in a box people type in is masked on every screen; other text keeps its words', () => {
  assert.equal(replayText('Please send the GST file', { typed: true }), '****** **** *** *** ****');
  assert.equal(replayText('Please send the GST file', {}), 'Please send the GST file');
  for (const sel of ['[contenteditable]', 'textarea', '[role="textbox"]']) assert.ok(TYPED_SELECTOR.includes(sel), sel);
  assert.ok(TYPED_SELECTOR.includes(':not([contenteditable="false"])'), 'a mention chip inside the box is still inside the box');
});

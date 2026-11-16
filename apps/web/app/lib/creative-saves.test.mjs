// EST-1792: the creative sprint page's saves against a fake API that, like services/api/src/creative.ts, keeps an item's
// newest edit and answers with the whole view. Synthetic ids only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sprintSaves } from './creative-saves.mjs';

const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002';

function harness({ refuse = () => null } = {}) {
  const items = new Map([['input:brochure', { ownerPersonId: A, doneOn: null, note: null, editedAt: '' }],
    ['milestone:research_meet', { ownerPersonId: A, doneOn: null, note: null, editedAt: '' }]]);
  const sent = [], held = [], shown = [], states = [], notes = [];
  const sprint = { package: 'core', gsPersonId: A, csPersonId: A, approver: 'Synthetic Approver' };
  let t = Date.parse('2026-10-19T10:00:00Z'), hold = false;
  const view = () => ({ sprint: { ...sprint }, items: Object.fromEntries([...items].map(([k, v]) => [k, { ...v }])) });
  const answer = (path, body) => {
    const no = refuse(path, body); if (no) throw new Error(no);
    if (path.endsWith('/items')) { const k = `${body.kind}:${body.key}`, was = items.get(k);
      if (was.editedAt < body.editedAt) items.set(k, { ownerPersonId: body.ownerPersonId, doneOn: body.doneOn, note: body.note, editedAt: body.editedAt }); }
    else { Object.assign(sprint, Object.fromEntries(Object.entries(body).filter(([field]) => field !== 'editedAt'))); }
    return view();
  };
  const post = (path, body) => { sent.push({ path, body });
    if (!hold) return Promise.resolve().then(() => answer(path, body));
    return new Promise((resolve, reject) => held.push(() => { try { resolve(answer(path, body)); } catch (e) { reject(e); } })); };
  const saves = sprintSaves({ base: 'creative/sprints/s1', post, show: (v) => shown.push(v), change: (s) => states.push(s),
    saved: (x) => notes.push(['saved', x]), failed: (x) => notes.push(['failed', x]), now: () => new Date(t += 1000).toISOString() });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { saves, items, sprint, sent, held, shown, states, notes, settle, delay: (on) => { hold = on; },
    release: async () => { await settle(); while (held.length) { held.shift()(); await settle(); } } };
}
const shown = (h, k) => h.items.get(k);
const page = { ownerPersonId: A, doneOn: null, note: null };   // what the page showed before either edit

test('an input: owner A → B, then a received date before the first reply; both edits are saved', async () => {
  const h = harness(); h.delay(true);
  void h.saves.item('input', 'brochure', page, { ownerPersonId: B });
  void h.saves.item('input', 'brochure', page, { doneOn: '2026-10-18' });   // the page still shows A: no reply yet
  assert.equal(h.states.at(-1).saving, true);
  assert.deepEqual(h.states.at(-1).drafts['input:brochure'], { ownerPersonId: B, doneOn: '2026-10-18', note: null }, 'the page shows both edits at once');
  await h.settle(); assert.equal(h.sent.length, 1, 'one save at a time');
  await h.release();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].body.ownerPersonId, B, 'the second save carries the new owner, not the stale A');
  assert.ok(h.sent[0].body.editedAt < h.sent[1].body.editedAt);
  assert.deepEqual({ ...shown(h, 'input:brochure'), editedAt: undefined }, { ownerPersonId: B, doneOn: '2026-10-18', note: null, editedAt: undefined });
  assert.equal(h.shown.length, 1, 'only the last reply is shown, once nothing is in flight');
  assert.equal(h.shown[0].items['input:brochure'].ownerPersonId, B);
  assert.deepEqual(h.states.at(-1), { saving: false, failed: 0, drafts: {}, intake: {} }, 'Saved, and the next edit starts from the server view');
});

test('a deliverable: owner then done, quickly; both survive', async () => {
  const h = harness(); h.delay(true);
  void h.saves.item('milestone', 'research_meet', page, { ownerPersonId: B });
  void h.saves.item('milestone', 'research_meet', page, { doneOn: '2026-10-19' }, 'Research meet done');
  await h.release();
  assert.equal(shown(h, 'milestone:research_meet').ownerPersonId, B);
  assert.equal(shown(h, 'milestone:research_meet').doneOn, '2026-10-19');
  assert.deepEqual(h.notes, [['saved', 'Research meet done']]);
});

test('a refused save stays "Not saved" with its value until Retry saves it', async () => {
  let down = true;
  const h = harness({ refuse: () => down ? 'Choose an active colleague' : null });
  await h.saves.item('input', 'brochure', page, { ownerPersonId: B });
  assert.deepEqual(h.notes, [['failed', 'Choose an active colleague']]);
  assert.equal(h.states.at(-1).saving, false);
  assert.equal(h.states.at(-1).failed, 1, 'the header says Not saved, not Saved');
  assert.equal(h.states.at(-1).drafts['input:brochure'].ownerPersonId, B, 'the picker keeps what was chosen');
  assert.equal(h.shown.length, 0);
  down = false; await h.saves.retry(); await h.settle();
  assert.equal(shown(h, 'input:brochure').ownerPersonId, B);
  assert.deepEqual(h.states.at(-1), { saving: false, failed: 0, drafts: {}, intake: {} });
});

test('a later good save of the same item clears "Not saved"; another field\'s failure stays', async () => {
  let refuse = (path) => path.endsWith('/items') ? 'Could not save' : null;
  const h = harness({ refuse: (...a) => refuse(...a) });
  await h.saves.item('input', 'brochure', page, { ownerPersonId: B });
  await h.saves.sprint('approver', '');
  assert.equal(h.states.at(-1).failed, 1, 'the intake save went through');
  refuse = (path, body) => path.endsWith('/items') ? null : body.approver === '' ? 'Name the client approver' : null;
  await h.saves.sprint('approver', '');
  await h.saves.item('input', 'brochure', page, { doneOn: '2026-10-18' });
  await h.settle();
  assert.equal(shown(h, 'input:brochure').ownerPersonId, B, 'the earlier unsaved owner went with the later save');
  assert.equal(h.states.at(-1).failed, 1, 'the cleared approver is still not saved');
  assert.equal(h.sent.at(-2).body.approver, '');
  assert.deepEqual(Object.keys(h.sent.at(-2).body).sort(), ['approver', 'editedAt'], 'an intake save sends only its field');
});

for (const [field, first, newest] of [['package', 'plus', 'complete'], ['gsPersonId', B, A], ['csPersonId', B, A]]) {
  test(`intake ${field}: newest selection survives refusal and another field's reply; Retry sends it`, async () => {
    let down = true;
    const h = harness({ refuse: (_path, body) => down && field in body ? 'Could not save' : null });
    h.delay(true);
    void h.saves.sprint(field, first);
    void h.saves.sprint(field, newest);
    assert.equal(h.states.at(-1).intake[field], newest, 'newest selection is visible while saving');
    await h.release();
    assert.equal(h.states.at(-1).failed, 1);
    void h.saves.sprint('approver', 'Another Synthetic Approver');
    await h.release();
    assert.equal(h.states.at(-1).intake[field], newest, 'another field cannot replace the unsaved control');
    const visible = { ...h.shown.at(-1).sprint, ...h.states.at(-1).intake };
    assert.equal(visible[field], newest);
    down = false; h.delay(false);
    await h.saves.retry();
    assert.equal(h.sent.at(-1).body[field], visible[field], 'Retry sends what the controls show');
    assert.equal(h.shown.at(-1).sprint[field], newest);
    assert.equal(h.states.at(-1).failed, 0);
    assert.deepEqual(h.states.at(-1).intake, {});
  });
}

test('a later successful intake edit clears its failed draft', async () => {
  let down = true;
  const h = harness({ refuse: () => down ? 'Could not save' : null });
  await h.saves.sprint('package', 'plus');
  down = false;
  await h.saves.sprint('package', 'complete');
  assert.equal(h.shown.at(-1).sprint.package, 'complete');
  assert.equal(h.states.at(-1).failed, 0);
  assert.deepEqual(h.states.at(-1).intake, {});
});

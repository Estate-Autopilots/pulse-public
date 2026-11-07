import test from 'node:test';
import assert from 'node:assert/strict';
import { hiddenFor, homeFor, HOME_ROLES, SCREENS, SCREEN_ROLES, validateScreenChoice, viewFrom } from '../dist/screens.js';

// EST-1419: which screens a role does not see. Synthetic choices only.
const KEYS = SCREENS.map((s) => s.key);

test('the registry has one stable key per rail entry, with unique page bases, and four fixed screens', () => {
  assert.equal(new Set(KEYS).size, KEYS.length);
  const paths = SCREENS.flatMap((s) => s.paths);
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(paths.every((p) => /^\/[a-z-]+(\/[a-z-]+)?$/.test(p)), 'page bases are plain paths');
  assert.deepEqual(SCREENS.filter((s) => s.fixed).map((s) => s.key), ['dashboard', 'chats', 'me', 'hr']);
  assert.ok(!paths.includes('/settings'), 'Settings is never hideable, so an admin can always undo');
});

test('no saved choice hides nothing; a saved list hides only for its role', () => {
  for (const role of SCREEN_ROLES) assert.deepEqual(hiddenFor(viewFrom({}), role), []);
  const view = viewFrom({ newScreensHidden: false, known: KEYS, hidden: { person: ['map', 'acquisition'], finance: ['erp'] } });
  assert.deepEqual(hiddenFor(view, 'person'), ['acquisition', 'map'], 'registry order');
  assert.deepEqual(hiddenFor(view, 'finance'), ['erp']);
  assert.deepEqual(hiddenFor(view, 'admin'), []);
  assert.deepEqual(hiddenFor(view, 'accountant'), [], 'the Accountant keeps its own pages');
});

test('new screens start hidden only while the switch is on, and explicit choices survive an update', () => {
  const known = KEYS.filter((k) => k !== 'sops' && k !== 'network');           // an older registry
  const on = viewFrom({ newScreensHidden: true, known, hidden: { person: ['map'] } });
  assert.deepEqual(hiddenFor(on, 'person'), ['map', 'sops', 'network']);
  assert.deepEqual(hiddenFor(on, 'admin'), ['sops', 'network']);
  const off = viewFrom({ newScreensHidden: false, known, hidden: { person: ['map'] } });
  assert.deepEqual(hiddenFor(off, 'person'), ['map']);
});

test('the fixed screens are never hidden, even by a stored row', () => {
  const view = viewFrom({ newScreensHidden: true, known: [], hidden: { person: ['chats', 'hr', 'me', 'dashboard', 'map'] } });
  const hidden = hiddenFor(view, 'person');
  for (const key of ['chats', 'hr', 'me', 'dashboard']) assert.ok(!hidden.includes(key), key);
  assert.ok(hidden.includes('map'));
});

test('a stored row is read leniently: unknown roles and keys are dropped', () => {
  const view = viewFrom({ newScreensHidden: 'yes', known: ['map', 'nope'], hidden: { person: ['map', 'nope'], owner: ['map'], hr: 'map' } });
  assert.deepEqual(view, { newScreensHidden: false, known: ['map'], hidden: { hr: [], person: ['map'] }, home: {} });
});

test('a save is the switch plus each role\'s list, strictly', () => {
  assert.equal(validateScreenChoice({ newScreensHidden: false, hidden: { person: ['map'] } }).valid, true);
  assert.equal(validateScreenChoice({ newScreensHidden: false, hidden: {} }).valid, true);
  for (const bad of [
    {}, { hidden: {} }, { newScreensHidden: 1, hidden: {} },
    { newScreensHidden: false, hidden: { owner: ['map'] } },              // unknown role
    { newScreensHidden: false, hidden: { person: ['nowhere'] } },         // unknown screen
    { newScreensHidden: false, hidden: { person: ['map', 'map'] } },
    { newScreensHidden: false, hidden: {}, known: KEYS },                 // the server sets known
  ]) assert.equal(validateScreenChoice(bad).valid, false, JSON.stringify(bad));
  const fixed = validateScreenChoice({ newScreensHidden: false, hidden: { person: ['chats'] } });
  assert.deepEqual(fixed, { valid: false, errors: ['Dashboard, Chats, My desk and the HR desk always stay visible'] });
});

test('EST-1240: each role lands on the Dashboard until an admin chooses the sales home for it', () => {
  for (const role of SCREEN_ROLES) assert.equal(homeFor(viewFrom({}), role), 'dashboard');
  const view = viewFrom({ newScreensHidden: false, known: KEYS, hidden: {}, home: { person: 'sales', manager: 'dashboard' } });
  assert.equal(homeFor(view, 'person'), 'sales');
  assert.equal(homeFor(view, 'manager'), 'dashboard');
  assert.equal(homeFor(view, 'leadership'), 'dashboard', 'a role nobody chose for keeps its home');
  assert.equal(homeFor(view, 'accountant'), 'dashboard');
  assert.ok(!HOME_ROLES.includes('hr'), 'an HR-only account keeps its own home');
  // Read leniently: an unknown home, an unknown role or HR is dropped, never guessed.
  assert.deepEqual(viewFrom({ home: { person: 'crm', owner: 'sales', hr: 'sales', pgs: 'sales' } }).home, { pgs: 'sales' });
  assert.equal(validateScreenChoice({ newScreensHidden: false, hidden: {}, home: { person: 'sales' } }).valid, true);
  for (const home of [{ person: 'crm' }, { hr: 'sales' }, { owner: 'sales' }, 'sales'])
    assert.equal(validateScreenChoice({ newScreensHidden: false, hidden: {}, home }).valid, false, JSON.stringify(home));
});

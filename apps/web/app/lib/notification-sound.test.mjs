import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const soundCode = compile('./notification-sound.ts'), pingsCode = compile('../browser-pings.tsx');

function browser({ muted = false, unsupported = false, blocked = false, native = false, privateMode = false } = {}) {
  const listeners = new Map(), storage = new Map(muted ? [['pulse.notify.sound', '0']] : []);
  const notes = [], arrivals = [], contexts = [], cleanups = [];
  let interval, responseRows = [];
  const events = {
    addEventListener(name, fn) { const list = listeners.get(name) ?? new Set(); list.add(fn); listeners.set(name, list); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) ?? []) fn(event); },
  };
  const window = { ...events, setInterval(fn) { interval = fn; return 1; } };
  const document = { ...events, visibilityState: 'visible' };
  class AudioContext {
    state = 'suspended'; currentTime = 1; destination = {};
    constructor() { contexts.push(this); }
    async resume() { if (blocked) throw Error('Autoplay blocked'); this.state = 'running'; }
    createGain() {
      const node = { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
      return node;
    }
    createOscillator() {
      const node = { frequency: {}, connect() {}, disconnect() {}, start(at) { this.startAt = at; }, stop(at) { this.stopAt = at; } };
      notes.push(node); return node;
    }
  }
  const localStorage = {
    getItem(key) { if (privateMode) throw Error('Storage blocked'); return storage.get(key) ?? null; },
    setItem(key, value) { if (privateMode) throw Error('Storage blocked'); storage.set(key, value); },
  };
  const location = { origin: 'https://pulse.example', pathname: '/chats', search: '?channel=current' };
  const globals = { window, document, location, localStorage, URL, URLSearchParams, Date,
    AudioContext: unsupported ? undefined : AudioContext,
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
  };
  const soundModule = { exports: {} };
  runInNewContext(soundCode, { ...globals, exports: soundModule.exports, module: soundModule });
  const sound = soundModule.exports.notificationSound;
  const pingsModule = { exports: {} };
  runInNewContext(pingsCode, { ...globals, exports: pingsModule.exports, module: pingsModule,
    navigator: { serviceWorker: events }, clearInterval() {},
    fetch: async () => ({ ok: true, json: async () => ({ rows: responseRows, cursor: 'cursor' }) }),
    require: name => ({
      react: { useEffect: effect => cleanups.push(effect()) },
      './lib/native-shell': { shell: () => native ? {} : null },
      './lib/shared-get.mjs': { sharedJson: async () => null },
      './lib/notification-sound': { notificationSound: sound },
      './lib/browser-ping-state.mjs': { browserPingStatus: () => null },
    })[name],
  });
  window.addEventListener('pulse:arrival', event => arrivals.push(event.detail));
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return {
    sound, notes, contexts, arrivals, document, window, storage,
    async mount() { pingsModule.exports.BrowserPings(); await settle(); },
    async gesture(type = 'click') { window.dispatchEvent({ type }); await settle(); },
    async poll(rows) { responseRows = rows; interval(); await settle(); },
    async push(row) { events.dispatchEvent({ type: 'message', data: { type: 'pulse-ping', row } }); await settle(); },
    unmount() { cleanups.forEach(fn => fn?.()); },
  };
}
const update = (id, fields = {}) => ({ id, title: 'New message', href: '/chats?channel=other', eventType: 'chat.message', pingAllowed: true, ...fields });

test('browser arrivals play a short rising chime after interaction; polling and push deduplicate', async () => {
  const b = browser(); await b.mount(); await b.gesture();
  await b.poll([update('one')]);
  assert.equal(b.arrivals.length, 1);
  assert.deepEqual(b.notes.map(n => n.frequency.value), [659.25, 987.77]);
  assert.ok(b.notes[1].startAt > b.notes[0].startAt);
  assert.ok(b.notes.every(n => n.stopAt - n.startAt <= 0.51));
  b.contexts[0].currentTime += 2;
  await b.push(update('one')); await b.poll([update('one')]);
  assert.equal(b.notes.length, 2);
  assert.equal(b.arrivals.length, 1);
  await b.push(update('two'));
  assert.equal(b.notes.length, 4);
});

test('muted kinds, quiet hours/DND, the open conversation and hidden pages stay silent', async () => {
  const b = browser(); await b.mount(); await b.gesture('keydown');
  await b.poll([update('quiet', { pingAllowed: false }), update('current', { href: '/chats?channel=current' })]);
  b.document.visibilityState = 'hidden';
  await b.push(update('hidden'));
  assert.equal(b.notes.length, 0);
  assert.equal(b.arrivals.length, 0);
});

test('native notifications and incoming call ringing do not acquire a second sound', async () => {
  const native = browser({ native: true }); await native.mount(); await native.gesture(); await native.poll([update('native')]);
  assert.equal(native.notes.length, 0); assert.equal(native.contexts.length, 0);
  const call = browser(); await call.mount(); await call.gesture(); await call.poll([update('call', { eventType: 'chat.call' })]);
  assert.equal(call.notes.length, 0);
});

test('sound defaults on, saves the browser preference and can be previewed while muted', async () => {
  const b = browser(); assert.equal(b.sound.enabled(), true);
  let changes = 0;
  const unsubscribe = b.sound.subscribe(() => changes++);
  b.sound.setEnabled(false);
  assert.equal(b.storage.get('pulse.notify.sound'), '0'); assert.equal(changes, 1);
  await b.sound.unlock(); assert.equal(await b.sound.play(), false);
  assert.equal(await b.sound.play(true), true); assert.equal(b.notes.length, 2);
  b.sound.setEnabled(true); assert.equal(b.sound.enabled(), true);
  unsubscribe(); b.sound.setEnabled(false); assert.equal(changes, 2);
  const muted = browser({ muted: true }); await muted.mount(); await muted.gesture(); await muted.poll([update('muted')]);
  assert.equal(muted.notes.length, 0); assert.equal(muted.arrivals.length, 1);
});

test('bursts chime once and locked, blocked or unsupported audio never prevents visual alerts', async () => {
  const b = browser(); await b.mount();
  await b.poll([update('locked')]); assert.equal(b.notes.length, 0); assert.equal(b.arrivals.length, 1);
  await b.gesture(); await b.poll([update('two'), update('three')]); assert.equal(b.notes.length, 2);
  for (const option of [{ blocked: true }, { unsupported: true }]) {
    const unavailable = browser(option); await unavailable.mount(); await unavailable.gesture(); await unavailable.poll([update('alert')]);
    assert.equal(unavailable.notes.length, 0); assert.equal(unavailable.arrivals.length, 1);
    assert.equal(await unavailable.sound.play(true), false);
  }
});

test('unmount removes the audio gesture listeners', async () => {
  const b = browser(); await b.mount(); b.unmount(); await b.gesture(); await b.gesture('keydown');
  assert.equal(b.contexts.length, 0);
});

test('a mute still takes effect when browser storage is blocked', async () => {
  const b = browser({ privateMode: true }); await b.sound.unlock();
  b.sound.setEnabled(false); assert.equal(b.sound.enabled(), false);
  assert.equal(await b.sound.play(), false); assert.equal(b.notes.length, 0);
  b.sound.setEnabled(true); assert.equal(await b.sound.play(), true);
});

test('a closed audio context can be recreated without inheriting its old burst timer', async () => {
  const b = browser(); await b.sound.unlock(); b.contexts[0].currentTime = 1000;
  assert.equal(await b.sound.play(), true); b.contexts[0].state = 'closed';
  await b.sound.unlock(); assert.equal(b.contexts.length, 2);
  assert.equal(await b.sound.play(), true); assert.equal(b.notes.length, 4);
});

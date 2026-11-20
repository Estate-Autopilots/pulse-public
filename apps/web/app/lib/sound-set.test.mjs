// SOUNDS-5: the sound set (lib/sound-set.ts). Classic stays the default; a picked set plays its mastered file per cue
// (the notification chime in lib/notification-sound.ts, the call ring in calls/tones.ts) and falls back to the classic
// sound when the file cannot load; every picked file ships in public/sounds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const setCode = compile('./sound-set.ts'), chimeCode = compile('./notification-sound.ts'), tonesCode = compile('../calls/tones.ts');
const PUBLIC = new URL('../../public/sounds/', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function browser({ tryLine = null, missing = false, offline = false, opus = false } = {}) {
  const storage = new Map(tryLine === null ? [] : [['pulse.sounds', tryLine]]);
  const fetched = [], sources = [], oscillators = [], envelopes = [], contexts = [], vibrations = [];
  class AudioContext {
    state = 'running'; currentTime = 5; destination = {};
    constructor() { contexts.push(this); }
    async resume() { this.state = 'running'; }
    createGain() {
      const calls = [], node = { calls, connect() {}, disconnect() {}, gain: { value: 1,
        setValueAtTime: (v, t) => calls.push(['set', v, t]), linearRampToValueAtTime: (v, t) => calls.push(['ramp', v, t]),
        exponentialRampToValueAtTime() {}, cancelScheduledValues: (t) => calls.push(['cancel', t]) } };
      envelopes.push(node); return node;
    }
    createOscillator() { const node = { frequency: {}, connect() {}, disconnect() {}, start() {}, stop() {} }; oscillators.push(node); return node; }
    createBufferSource() { const node = { connect() {}, disconnect() {}, start(at) { this.startAt = at; }, stop(at) { this.stopAt = at; } }; sources.push(node); return node; }
    async decodeAudioData(bytes) { return { from: bytes }; }
  }
  const fetch = async (url) => {
    fetched.push(url); if (offline) throw TypeError('Failed to fetch');
    return missing ? { ok: false, status: 404 } : { ok: true, arrayBuffer: async () => url };
  };
  const globals = { AudioContext, fetch,
    Audio: opus ? class { canPlayType(type) { return type.includes('opus') ? 'probably' : ''; } } : undefined,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} }, navigator: { vibrate: (p) => vibrations.push(p) },
    setInterval: () => 1, clearInterval() {}, Event: class {} };
  const load = (code, require) => { const mod = { exports: {} }; runInNewContext(code, { ...globals, exports: mod.exports, module: mod, require }); return mod.exports; };
  const set = load(setCode);
  const require = (name) => ({ './sound-set': set, '../lib/sound-set': set })[name];
  return { set, chime: load(chimeCode, require).notificationSound, tones: load(tonesCode, require).tones,
    fetched, sources, oscillators, envelopes, contexts, vibrations };
}

test("the preview page's PULSE_SOUNDS line picks a set per cue; classic, unpicked and odd values stay classic", () => {
  const { set } = browser();
  assert.deepEqual({ ...set.parsePicks('PULSE_SOUNDS ringtone=glass-v3 message=A mention=? reminder=classic success=../x error=B volume=C') },
    { ringtone: 'glass-v3', message: 'A', error: 'B' });
  assert.deepEqual({ ...set.parsePicks('') }, {});
  assert.equal(set.soundSet('ringtone'), null, 'nothing picked: the classic sounds');
  assert.equal(browser({ tryLine: 'PULSE_SOUNDS ringtone=C' }).set.soundSet('ringtone'), 'C', 'a browser can try a line before the pick');
});

test('each kind of notification has its cue', () => {
  const { set } = browser();
  const cues = { 'chat.message': 'message', 'chat.voice': 'message', 'leave.decision': 'message', 'update.test': 'message', [undefined]: 'message',
    'chat.mention': 'mention', 'task.mention': 'mention', 'chat.reply': 'mention', 'task.ask': 'mention', 'task.help': 'mention',
    'task.due_soon': 'reminder', 'approval.reminder': 'reminder', 'task.review_nudge': 'reminder', 'workflow.late': 'reminder',
    'chat.missed_call': 'reminder', 'attendance.ask': 'reminder', 'attendance.break': 'reminder',
    'billing.approved': 'success', 'payroll.processed': 'success', 'task.done': 'success', 'pack.ready': 'success',
    'flow.alert': 'error', 'task.blocked': 'error', 'expense.rejected': 'error', 'turn.failed': 'error' };
  for (const [eventType, cue] of Object.entries(cues)) assert.equal(set.cueFor(eventType === 'undefined' ? undefined : eventType), cue, eventType);
});

test('a picked set plays its file for that kind of notification, at its mastered level after a 3 ms rise', async () => {
  const classic = browser(); await classic.chime.unlock();
  assert.equal(await classic.chime.play(false, 'chat.mention'), true);
  assert.equal(classic.oscillators.length, 2); assert.equal(classic.sources.length, 0); assert.equal(classic.fetched.length, 0);

  const b = browser({ tryLine: 'PULSE_SOUNDS ringtone=glass-v3 message=A mention=B reminder=classic' });
  await b.chime.unlock(); await settle();
  assert.deepEqual([...b.fetched].sort(), ['/sounds/A/message.mp3', '/sounds/B/mention.mp3'], 'the first touch loads the picked notification sounds');
  assert.equal(await b.chime.play(false, 'chat.mention'), true);
  assert.equal(b.sources.length, 1); assert.equal(b.oscillators.length, 0); assert.equal(b.fetched.length, 2, 'loaded once');
  assert.equal(b.sources[0].buffer.from, '/sounds/B/mention.mp3'); assert.equal(b.sources[0].loop, false);
  const [rise, top] = b.envelopes.at(-1).calls;
  assert.deepEqual([rise[0], rise[1], top[0], top[1]], ['set', 0, 'ramp', 1]); assert.ok(Math.abs(top[2] - rise[2] - 0.003) < 1e-9);
  assert.equal(await b.chime.play(false, 'chat.message'), false, 'a burst still sounds once');
  b.contexts[0].currentTime += 2;
  assert.equal(await b.chime.play(false, 'task.due_soon'), true); assert.equal(b.oscillators.length, 2, 'reminder is classic: the chime');
  b.contexts[0].currentTime += 2;
  assert.equal(await b.chime.play(true), true); assert.equal(b.sources.at(-1).buffer.from, '/sounds/A/message.mp3', 'the preview plays the message sound');
});

test('Opus first where the browser plays it; a file that cannot load plays the classic chime', async () => {
  const b = browser({ tryLine: 'message=A', missing: true, opus: true });
  await b.chime.unlock(); await settle();
  assert.deepEqual(plain(b.fetched), ['/sounds/A/message.webm', '/sounds/A/message.mp3']);
  assert.equal(await b.chime.play(false, 'chat.message'), true);
  assert.equal(b.sources.length, 0); assert.equal(b.oscillators.length, 2);
  await b.chime.unlock(); await settle();
  assert.equal(b.fetched.length, 2, 'a file the server does not have is not asked for again on every click');
  const offline = browser({ tryLine: 'message=A', offline: true });
  await offline.chime.unlock(); await settle();
  assert.equal(await offline.chime.play(false, 'chat.message'), true); assert.equal(offline.oscillators.length, 2);
  assert.equal(offline.fetched.length, 2, 'after a network error the next arrival tries the file again');
});

test('a picked ringtone loops its file until the call is answered, and the phone still vibrates', async () => {
  const b = browser({ tryLine: 'ringtone=glass-v3' });
  b.tones.set('ring'); await settle();
  assert.equal(b.sources.length, 1); assert.equal(b.sources[0].loop, true); assert.equal(b.oscillators.length, 0);
  assert.equal(b.sources[0].buffer.from, '/sounds/glass-v3/ringtone.mp3');
  assert.deepEqual(plain(b.vibrations), [0, [450, 200, 450]]);
  b.tones.set(null);
  assert.ok(b.sources[0].stopAt > b.sources[0].startAt);
  assert.deepEqual(b.envelopes.at(-1).calls.at(-1).slice(0, 2), ['ramp', 0], 'it fades out instead of cutting');

  const quick = browser({ tryLine: 'ringtone=A' });
  quick.tones.set('ring'); quick.tones.set(null); await settle();
  assert.equal(quick.sources.length, 0, 'answered while the file loaded: it never starts');
});

test('the classic ring stays the default, and a ringtone that cannot load rings the classic way', async () => {
  for (const b of [browser(), browser({ tryLine: 'ringtone=A', missing: true })]) {
    b.tones.set('ring'); await settle();
    assert.equal(b.sources.length, 0); assert.equal(b.oscillators.length, 8);
    b.tones.set(null);
  }
});

test('public/sounds ships whole cues (webm + mp3) and every picked one', () => {
  const { set } = browser(), cues = new Set(set.CUES);
  for (const id of readdirSync(PUBLIC)) {
    assert.match(id, /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/);
    const files = readdirSync(new URL(`${id}/`, PUBLIC));
    for (const file of files) {
      const [, cue, ext] = /^([a-z]+)\.(webm|mp3)$/.exec(file) ?? [];
      assert.ok(cues.has(cue) && ext, `${id}/${file} is <cue>.webm or <cue>.mp3`);
      assert.ok(files.includes(`${cue}.${ext === 'webm' ? 'mp3' : 'webm'}`), `${id}/${file} has its other format`);
    }
  }
  for (const [cue, id] of Object.entries(set.parsePicks(set.PICKS)))
    for (const ext of ['webm', 'mp3']) assert.ok(existsSync(new URL(`${id}/${cue}.${ext}`, PUBLIC)), `PICKS ${cue}=${id}: public/sounds/${id}/${cue}.${ext}`);
});

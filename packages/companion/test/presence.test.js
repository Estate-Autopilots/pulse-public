import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePresence, distanceMeters, placeAt, presenceBody, regionsToMonitor, wifiMatch, demoPayload, applyLocal } from '../src/index.js';

const IST = (hhmm) => Date.parse(`2026-10-08T${hhmm}:00+05:30`);
const office = { id: 'o1', name: 'Demo office', lat: 0.5, lng: 0.5, radius: 150, wifi: [{ ssid: 'Demo-WiFi', bssids: ['A4-2B-B0-11-22-33'] }] };
const presence = { autoCheckIn: true, offices: [office], sites: [
  { id: 's1', name: 'Tower A shoot', lat: 28.5, lng: 77.1, radius: 120, precision: 'building' },
  { id: 's2', name: 'Locality only', lat: 28.6, lng: 77.2, radius: 120, precision: 'locality' },
] };
const payload = (state = 'out', at = IST('09:50')) => ({ ...demoPayload(state, at), presence });
const prefs = { presence: true, autoCheckIn: false };
const enter = (r = regionsToMonitor(presence)[0], trigger = 'enter') => ({ trigger, place: r });

test('distance is haversine metres', () => {
  assert.ok(Math.abs(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 111195) < 50);
  assert.equal(distanceMeters(office, office), 0);
});

test('regions: offices first, only exact/building sites, capped for iOS', () => {
  const r = regionsToMonitor(presence);
  assert.deepEqual(r.map((x) => x.id), ['office:o1', 'site:s1']);
  const many = { offices: [office], sites: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, name: 's', lat: 28 + i / 100, lng: 77, radius: 100, precision: 'exact' })) };
  assert.equal(regionsToMonitor(many).length, 20);
  assert.equal(regionsToMonitor(many, 100).length, 41);
  assert.equal(regionsToMonitor(null).length, 0);
});

test('a one-off position: inside, outside, or too imprecise to say (then Wi-Fi decides)', () => {
  assert.equal(placeAt({ lat: 0.5001, lng: 0.5001, accuracy: 20 }, presence).place.placeId, 'o1');
  assert.equal(placeAt({ lat: 28.47, lng: 0.5, accuracy: 20 }, presence).reason, 'outside');
  assert.equal(placeAt({ lat: 0.5001, lng: 0.5001, accuracy: 400 }, presence).reason, 'weak-gps');
  assert.equal(placeAt(null, presence).reason, 'no-fix');
  // At the edge, half the accuracy counts against you.
  assert.equal(placeAt({ lat: 0.5 + 140 / 111195, lng: 0.5, accuracy: 40 }, presence).reason, 'outside');
});

test('office Wi-Fi: BSSID is strong, the network name alone is weak, other networks nothing', () => {
  assert.equal(wifiMatch({ ssid: 'Demo-WiFi', bssid: 'a4:2b:b0:11:22:33' }, presence).strength, 'strong');
  assert.equal(wifiMatch({ ssid: 'Demo-WiFi', bssid: '00:00:00:00:00:01' }, presence).strength, 'weak');
  assert.equal(wifiMatch({ ssid: 'Demo-WiFi', bssid: null }, presence).strength, 'weak');
  assert.equal(wifiMatch({ ssid: 'Cafe', bssid: 'a4:2b:b0:11:22:33' }, presence), null);
  assert.equal(wifiMatch(null, presence), null);
});

test('arriving at the office suggests a check-in with one tap', () => {
  const d = decidePresence({ signal: enter(), payload: payload(), prefs, at: IST('09:50') });
  assert.equal(d.kind, 'suggest-check-in');
  assert.equal(d.mode, 'office');
  assert.match(d.title, /You’re at Demo office — check in\?/);
  assert.deepEqual(d.actions, ['check-in']);
});

test('arriving at a confirmed shoot site suggests checking in on duty', () => {
  const site = regionsToMonitor(presence)[1];
  const d = decidePresence({ signal: enter(site), payload: payload(), prefs, at: IST('09:50') });
  assert.equal(d.kind, 'suggest-check-in');
  assert.equal(d.mode, 'field');
});

test('automatic check-in needs HR policy AND the person, a strong office signal and a working day', () => {
  const both = { ...prefs, autoCheckIn: true };
  assert.equal(decidePresence({ signal: enter(), payload: payload(), prefs: both, at: IST('09:50') }).kind, 'auto-check-in');
  assert.equal(decidePresence({ signal: enter(), payload: { ...payload(), presence: { ...presence, autoCheckIn: false } }, prefs: both, at: IST('09:50') }).kind, 'suggest-check-in', 'HR off');
  assert.equal(decidePresence({ signal: enter(), payload: payload(), prefs, at: IST('09:50') }).kind, 'suggest-check-in', 'person off');
  const weakWifi = { trigger: 'wifi', place: wifiMatch({ ssid: 'Demo-WiFi' }, presence) };
  assert.equal(decidePresence({ signal: weakWifi, payload: payload(), prefs: both, at: IST('09:50') }).kind, 'suggest-check-in', 'SSID alone never auto');
  const strongWifi = { trigger: 'wifi', place: wifiMatch({ ssid: 'Demo-WiFi', bssid: 'a4:2b:b0:11:22:33' }, presence) };
  assert.equal(decidePresence({ signal: strongWifi, payload: payload(), prefs: both, at: IST('09:50') }).kind, 'auto-check-in');
  const site = regionsToMonitor(presence)[1];
  assert.equal(decidePresence({ signal: enter(site), payload: payload(), prefs: both, at: IST('09:50') }).kind, 'suggest-check-in', 'sites never auto');
  assert.equal(decidePresence({ signal: enter(), payload: { ...payload('off'), presence }, prefs: both, at: IST('09:50') }).kind, 'suggest-check-in', 'day off: ask, never auto');
  assert.equal(decidePresence({ signal: enter(), payload: payload(), prefs: both, at: IST('08:30') }).kind, 'suggest-check-in', 'too early for auto');
});

test('attendance gate prevents location check-in suggestions when false or missing', () => {
  for (const attendanceEnabled of [false, undefined]) {
    const off = { ...payload(), attendanceEnabled };
    assert.equal(decidePresence({ signal: enter(), payload: off, prefs: { ...prefs, presence: true, autoCheckIn: true }, at: IST('09:50') }).reason, 'attendance-off');
  }
});

test('no suggestion when presence is off, already in, on leave, at night, or repeated within 30 minutes', () => {
  assert.equal(decidePresence({ signal: enter(), payload: payload(), prefs: { presence: false }, at: IST('09:50') }).kind, 'none');
  const inP = { ...applyLocal(payload(), 'check-in', IST('09:51')), presence };
  assert.equal(decidePresence({ signal: enter(), payload: inP, prefs, at: IST('10:00') }).reason, 'state-in');
  assert.equal(decidePresence({ signal: enter(), payload: { ...payload('leave'), presence }, prefs, at: IST('09:50') }).reason, 'state-leave');
  assert.equal(decidePresence({ signal: enter(), payload: payload(), prefs, at: IST('22:30') }).reason, 'outside-shift-window');
  assert.equal(decidePresence({ signal: enter(), payload: payload(), prefs, at: IST('09:50'), recent: [{ key: 'arrive:office:o1', at: IST('09:30') }] }).reason, 'repeat');
  assert.equal(decidePresence({ signal: enter(), payload: payload(), prefs, at: IST('10:10'), recent: [{ key: 'arrive:office:o1', at: IST('09:30') }] }).kind, 'suggest-check-in');
});

test('leaving: break or check-out during the day, check-out near the end, never automatic', () => {
  const inP = { ...applyLocal(payload(), 'check-in', IST('09:51')), presence };
  const lunch = decidePresence({ signal: enter(undefined, 'exit'), payload: inP, prefs: { ...prefs, autoCheckIn: true }, at: IST('13:00') });
  assert.equal(lunch.kind, 'suggest-leave');
  assert.deepEqual(lunch.actions, ['break-start', 'check-out']);
  const evening = decidePresence({ signal: enter(undefined, 'exit'), payload: inP, prefs, at: IST('18:45') });
  assert.deepEqual(evening.actions, ['check-out']);
  assert.equal(decidePresence({ signal: enter(undefined, 'exit'), payload: payload(), prefs, at: IST('13:00') }).kind, 'none');
});

test('back at the office after checking out: suggest checking in again', () => {
  const done = { ...demoPayload('done', IST('15:00')), presence };
  const d = decidePresence({ signal: enter(), payload: done, prefs, at: IST('15:30') });
  assert.equal(d.kind, 'suggest-check-in');
  assert.match(d.body, /counts as a break/);
});

test('the check-in body names the place and signal, never coordinates', () => {
  const signal = enter();
  const d = decidePresence({ signal, payload: payload(), prefs, at: IST('09:50') });
  const body = presenceBody(d, signal);
  assert.deepEqual(body, { mode: 'office', via: 'mobile', trigger: 'suggested', place: { kind: 'office', id: 'o1', signal: 'region' } });
  assert.equal(JSON.stringify(body).includes('28.'), false);
  assert.equal(presenceBody(d, { trigger: 'wifi', place: wifiMatch({ ssid: 'Demo-WiFi', bssid: 'a4:2b:b0:11:22:33' }, presence) }, true).place.signal, 'wifi');
});

test('ATT: with automatic check-out on, leaving a geofence asks nothing on the phone (the server judges every signal)', () => {
  const at = IST('18:45');
  const inDay = { ...applyLocal(payload('out', IST('09:50')), 'check-in', IST('09:55')), presence: { ...presence, autoCheckOut: true } };
  const exit = { trigger: 'exit', place: { kind: 'office', placeId: 'o1', id: 'office:o1', name: 'Demo office' } };
  assert.equal(decidePresence({ signal: exit, payload: inDay, prefs, at }).kind, 'none');
  assert.equal(decidePresence({ signal: exit, payload: inDay, prefs, at }).reason, 'server-decides');
  // A company without automatic check-out keeps the phone's own suggestion.
  const manual = { ...inDay, presence: { ...presence, autoCheckOut: false } };
  assert.equal(decidePresence({ signal: exit, payload: manual, prefs, at }).kind, 'suggest-leave');
});

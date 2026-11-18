// WL-CALLS-STREAM (17 Nov 2026): a live stream woken by its hub (one LISTEN connection per API process) reads in the
// company of the request that subscribed, never in the company of whichever request opened the LISTEN connection.
// Before: a call's offer and candidates woke the callee's stream in another company, its session was "not found", the
// stream ended and the call stayed on "Connecting". Invented companies only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepRequest, requestCompany, runWithCompany } from '../dist/tenant-context.js';
import { CallHub } from '../dist/calls.js';
import { ChatHub } from '../dist/chats.js';
import { UiHub } from '../dist/agent-ui.js';

const company = (org) => ({ host: `${org}.example.test`, company: { org, signIn: 'password', status: 'active', rehearsal: false } });
const seen = () => requestCompany()?.company?.org ?? null;

test('keepRequest runs a callback in the company it was made in', () => {
  let f; runWithCompany(company('org-a'), () => { f = keepRequest(() => seen()); });
  let got; runWithCompany(company('org-b'), () => { got = f(); });
  assert.equal(got, 'org-a');
  assert.equal(f(), 'org-a');
});

test('a call stream woken by the hub reads in its own company, whoever opened the LISTEN connection', () => {
  const hub = new CallHub(); const got = [];
  runWithCompany(company('org-a'), () => { hub.on('org-a:person-1', () => got.push(['a', seen()])); });
  runWithCompany(company('org-b'), () => { hub.on('org-b:person-2', () => got.push(['b', seen()])); });
  // The NOTIFY arrives in a third context (the LISTEN connection's), or none at all.
  runWithCompany(company('org-c'), () => { hub.wake('org-a:person-1'); hub.wake('org-b:person-2'); });
  hub.wake('org-a:person-1');
  assert.deepEqual(got, [['a', 'org-a'], ['b', 'org-b'], ['a', 'org-a']]);
});

test('a chat stream and an AI screen stream woken by their hubs keep their own company too', () => {
  const chats = new ChatHub(); const ui = new UiHub(); const got = [];
  runWithCompany(company('org-a'), () => { chats.on('org-a', (w) => got.push(['chat', w.channel, seen()])); ui.on('org-a', (who) => got.push(['ui', who, seen()])); });
  runWithCompany(company('org-c'), () => {
    chats.subs.get('org-a').forEach((f) => f({ channel: 'channel-1' }));
    ui.subs.get('org-a').forEach((f) => f('person-1', false));
  });
  assert.deepEqual(got, [['chat', 'channel-1', 'org-a'], ['ui', 'person-1', 'org-a']]);
});

test('unsubscribing still removes the woken callback', () => {
  const hub = new CallHub(); let n = 0;
  const off = runWithCompanyValue(() => hub.on('k', () => { n++; }));
  hub.wake('k'); off(); hub.wake('k');
  assert.equal(n, 1);
});
function runWithCompanyValue(f) { let v; runWithCompany(company('org-a'), () => { v = f(); }); return v; }

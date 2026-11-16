import assert from 'node:assert/strict';
import test from 'node:test';
import {openWithRetry} from './page-goto.mjs';

test('retries a renderer crash on a new page and closes the first page', async () => {
  const pages = [];
  const context = {newPage: async () => {
    const page = {closed: false, close: async () => {page.closed = true;}, goto: async () => {
      if (pages.length === 1) throw new Error('page.goto: Page crashed');
      return 'ok';
    }};
    pages.push(page);
    return page;
  }};
  const retries = [];
  const page = await openWithRetry(context, 'http://localhost/hr?tab=attendance', {waitUntil: 'domcontentloaded'}, retries);
  assert.equal(page, pages[1]);
  assert.equal(pages[0].closed, true);
  assert.deepEqual(retries, ['/hr']);
});

test('throws when the one retry also crashes', async () => {
  let calls = 0;
  const context = {newPage: async () => ({close: async () => {}, goto: async () => {calls++; throw new Error('Target crashed');}})};
  const retries = [];
  await assert.rejects(openWithRetry(context, 'http://localhost/notifications', {}, retries), /Target crashed/);
  assert.deepEqual(retries, ['/notifications']);
  assert.equal(calls, 2);
});

test('does not retry other navigation errors', async () => {
  let calls = 0;
  const context = {newPage: async () => ({close: async () => {}, goto: async () => {calls++; throw new Error('net::ERR_CONNECTION_REFUSED');}})};
  const retries = [];
  await assert.rejects(openWithRetry(context, 'http://localhost/chats?channel=abc', {}, retries), /net::ERR_CONNECTION_REFUSED/);
  assert.deepEqual(retries, []);
  assert.equal(calls, 1);
});

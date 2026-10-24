import assert from 'node:assert/strict';
import test from 'node:test';
import { MOBILE_TABS, mobileTabs } from '../../../../packages/ui-shell/src/mobile-tabs.ts';

const pages = (...hrefs) => hrefs.map((href) => ({ href }));
const tabs = (...hrefs) => mobileTabs(pages(...hrefs)).map((page) => page.href);

test('EST-1198: staff get Home, Work, Chats and Me on the phone bar; Clients and the rest move to More', () => {
  assert.equal(MOBILE_TABS, 4);
  assert.deepEqual(tabs('/dashboard', '/tasks', '/chats', '/clients', '/acquisition', '/contacts', '/map', '/sops', '/people', '/me'), ['/dashboard', '/tasks', '/chats', '/me']);
});

test('EST-1198: a role without Work fills the bar with its own next page, in rail order', () => {
  assert.deepEqual(tabs('/dashboard', '/chats', '/hr', '/me', '/people', '/review-data'), ['/dashboard', '/chats', '/hr', '/me']);
});

test('EST-1198: a role with few pages keeps them all; a renamed or hidden page is simply absent', () => {
  assert.deepEqual(tabs('/finance/desk', '/erp'), ['/finance/desk', '/erp']);
  assert.deepEqual(tabs('/dashboard', '/tasks', '/chats', '/acquisition', '/me'), ['/dashboard', '/tasks', '/chats', '/me']);
});

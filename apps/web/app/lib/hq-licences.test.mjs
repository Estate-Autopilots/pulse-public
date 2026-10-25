import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { element, load, ui } from '../../../../tools/qa/updates-fixture.mjs';

test('only Pulse HQ exposes the licence navigation entry', () => {
  const { navFor } = load('lib/nav.ts', { './screens.mjs': { hiddenRename: () => ({}) } });
  for (const orgHandle of ['acme', null, undefined]) {
    assert.equal(navFor({ role: 'admin', orgHandle }).rename['/hq/licences'], null);
  }
  assert.notEqual(navFor({ role: 'admin', orgHandle: 'pulsehq' }).rename?.['/hq/licences'], null);
});

test('a direct link outside Pulse HQ renders a neutral notice without rendering the API reader', async () => {
  for (const me of [{ orgHandle: 'acme' }, { orgHandle: null }, undefined]) {
    let reads = 0;
    const page = load('hq/licences/page.tsx', {
      '../../lib/api': { getMe: async () => ({ data: me }) },
      '../../orgs/licences/page': { __esModule: true, default: () => { reads++; throw Error('Licence API must not run'); } },
      '../../ui': ui,
    }).default;
    const html = renderToStaticMarkup(await page());
    assert.match(html, /Licences are managed in Pulse HQ/);
    assert.match(html, /href="\/hq\/features"/);
    assert.doesNotMatch(html, /403|Forbidden/);
    assert.equal(reads, 0);
  }
});

test('Pulse HQ still renders the existing licence register and the frame enables its shortcut', async () => {
  for (const orgHandle of ['acme', 'pulsehq']) {
    const getMe = async () => ({ data: { orgHandle } });
    const page = load('hq/licences/page.tsx', {
      '../../lib/api': { getMe }, '../../ui': ui,
      '../../orgs/licences/page': { __esModule: true, default: () => element('h1', null, 'Synthetic licence register') },
    }).default;
    assert.equal(renderToStaticMarkup(await page()).includes('Synthetic licence register'), orgHandle === 'pulsehq');
    const { HqFrame } = load('hq/frame.tsx', {
      '../lib/api': { getMe }, './shortcuts': { Shortcuts: ({ licences }) => element('span', null, licences ? 'Licence shortcut' : 'Other shortcuts') },
    });
    assert.equal(renderToStaticMarkup(await HqFrame({ children: 'HQ' })).includes('Licence shortcut'), orgHandle === 'pulsehq');
  }
});

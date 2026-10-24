import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { load, render, ui, views, update } from '../../../../tools/qa/updates-fixture.mjs';
const zone = 'Asia/Kolkata';
test('Home is absent without an update, and chips prioritize action with a three-chip limit', () => {
  assert.equal(render(views.HomeUpdate, { update: null, zone }), '');
  assert.deepEqual([...views.updateChips(update.counts)], ['1 Needs you', '1 Live', '1 Ready to try']);
  assert.deepEqual([...views.updateChips({ live: 0, needsYou: 0, readyToTry: 0, requests: 2 })], ['2 Requests']);
  assert.deepEqual([...views.updateChips({ live: 0, needsYou: 0, readyToTry: 0, requests: 0, ideas: 2 })], []);
  const html = render(views.HomeUpdate, { update, zone });
  assert.match(html, /aria-label="Unread"/);
  assert.doesNotMatch(render(views.HomeUpdate, { update: { ...update, openedAt: update.createdAt }, zone }), /aria-label="Unread"/);
});
test('all known request statuses have tones; unknown text remains visible and neutral', () => {
  for (const [tone, statuses] of Object.entries({ neutral: ['New','Planned','Awaiting feedback'], progress: ['Started','In progress','Test site'], warn: ['Waiting'], good: ['Live','Done'] }))
    for (const status of statuses) assert.equal(views.statusTone(status), tone);
  const html = render(views.UpdateCard, { update: { ...update, sections: { requests: [{ title: 'Review', status: 'Awaiting feedback', progress: 65 }] } }, zone });
  assert.match(html, /data-tone="neutral">Awaiting feedback/);
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="65"/);
  assert.doesNotMatch(html, /Live for everyone|Needs you|Tomorrow/);
});
test('only the sender sees audience receipts, in the company zone; the reply slot stays hidden', () => {
  const html = render(views.UpdateCard, { update, zone });
  assert.match(html, /Opened by Dev Kalah · <time[^>]*>09:14<\/time>/);
  assert.match(html, /data-slot="update-reply" hidden=""/);
  assert.match(html, /Prepared by Studio Chief of Staff \(AI\) for Asha Rao/);
  assert.doesNotMatch(html, /\(AI\) \(AI\)/);
  for (const variant of [{ ...update, openedBy: undefined }, { ...update, isSender: false }])
    assert.doesNotMatch(render(views.UpdateCard, { update: variant, zone }), /Opened by|Not opened yet|Dev Kalah/);
  assert.match(render(views.UpdateCard, { update: { ...update, openedBy: [{ personId: 'recipient', name: 'Dev Kalah', openedAt: null }] }, zone }), /Dev Kalah · Not opened yet/);
  assert.doesNotMatch(render(views.UpdateCard, { update: { ...update, openedBy: [] }, zone }), /Opened by|Not opened yet/);
});
test('the AI author wears the shared badge and AI avatar without an employee ID; the footer keeps the label', () => {
  assert.equal(views.authorName('Studio Chief of Staff (AI)'), 'Studio Chief of Staff');
  assert.equal(views.authorName('Studio Chief of Staff'), 'Studio Chief of Staff');
  const card = render(views.UpdateCard, { update, zone });
  assert.match(card, /data-shape="square"[^>]*>SC<\/span><span class="avatarAi" aria-hidden="true">AI<\/span>/);
  assert.match(card, /<span>Studio Chief of Staff<\/span><span class="aiBadge"[^>]*aria-label="AI employee"/);
  assert.match(card, /Prepared by Studio Chief of Staff \(AI\) for Asha Rao/);
  const list = render(views.UpdatesList, { data: { items: [update], nextCursor: null }, zone });
  assert.match(list, /Studio Chief of Staff<span class="aiBadge"[^>]*aria-label="AI employee"[^>]*>.*?AI<\/span> for Asha Rao/);
  for (const markup of [card, list]) assert.doesNotMatch(markup, /AI employee ·|\/photo\/|Staff \(AI\)<\/span>/);
});
test('the sender sees both read and unread recipients, never their own receipt', () => {
  const mixed = { ...update, openedBy: [...update.openedBy,
    { personId: 'unread-recipient', name: 'Mira Sen', openedAt: null },
    { personId: update.onBehalf.id, name: update.onBehalf.name, openedAt: update.createdAt },
  ] };
  const html = render(views.UpdateCard, { update: mixed, zone });
  assert.match(html, /Opened by Dev Kalah · <time[^>]*>09:14<\/time>/);
  assert.match(html, /Mira Sen · Not opened yet/);
  assert.doesNotMatch(html, /Opened by Asha Rao|Asha Rao · Not opened yet/);
  assert.doesNotMatch(render(views.UpdateCard, { update: { ...mixed, isSender: false }, zone }), /Opened by|Not opened yet|Dev Kalah|Mira Sen/);
  assert.doesNotMatch(render(views.UpdateCard, { update: { ...update, openedBy: [mixed.openedBy[2]] }, zone }), /Opened by|Not opened yet/);
});
test('detail links disable prefetch, and the list has paging and an empty state', () => {
  const home = render(views.HomeUpdate, { update, zone });
  const html = render(views.UpdatesList, { data: { items: [update], nextCursor: update.id }, zone });
  for (const markup of [home, html]) assert.match(markup, new RegExp(`href="/updates/${update.id}"[^>]*data-prefetch="false"`));
  assert.match(html, /Show older/);
  assert.match(render(views.UpdatesList, { data: { items: [], nextCursor: null }, zone }), /No updates yet/);
});
test('newest read fails closed and Home does not fetch the zone without updates', async () => {
  for (const result of [{ data: { items: [] } }, { error: 'Unavailable' }]) {
    const data = load('updates/data.ts', { react: { cache: fn => fn }, '../lib/api': { apiV1: async path => { assert.equal(path, '/api/v1/updates?limit=1'); return result; } } });
    assert.equal(await data.newestUpdate(), null);
    const home = load('updates/home-card.tsx', { './data': data, './views': views, '../lib/brand-server': { orgZone: () => { throw Error('unneeded read'); } } });
    assert.equal(await home.UpdatesHomeCard(), null);
  }
});
test('navigation exposes Updates only to eligible viewers with updates and preserves hidden screens', () => {
  const { navFor } = load('lib/nav.ts', { './screens.mjs': { hiddenRename: paths => Object.fromEntries((paths ?? []).map(path => [path, null])) } });
  const me = { person: 'sender', role: 'leadership', hiddenScreens: { paths: ['/contacts'] } };
  assert.equal(navFor(me).rename['/updates'], null);
  assert.equal(navFor(me, true).rename['/updates'], undefined);
  assert.equal(navFor(me, true).rename['/contacts'], null);
  for (const viewer of [undefined, { ...me, person: null }, { ...me, role: 'accountant' }, { ...me, mustChange: true }])
    assert.equal(navFor(viewer, true).rename['/updates'], null);
  assert.equal(navFor({ ...me, hiddenScreens: { paths: ['/updates'] } }, true).rename['/updates'], null);
});
test('detail opens with a POST, renders 404 as not found and offers retry on service failure', async () => {
  for (const result of [{ data: update }, { status: 404, error: 'No' }, { status: 503, error: 'Unavailable' }]) {
    const page = load('updates/[id]/page.tsx', { '../../lib/api': { apiV1: async (path, opts) => { assert.equal(path, `/api/v1/updates/${update.id}/open`); assert.equal(opts.method, 'POST'); return result; } }, '../../lib/brand-server': { orgZone: async () => zone }, '../../ui': ui, '../views': views, 'next/navigation': { notFound: () => { throw Error('NOT_FOUND'); } } }).default;
    if (result.status === 404) await assert.rejects(page({ params: Promise.resolve({ id: update.id }) }), /NOT_FOUND/);
    else {
      const html = renderToStaticMarkup(await page({ params: Promise.resolve({ id: update.id }) }));
      assert.match(html, result.data ? /Creative review workflow/ : /Try again/);
      if (result.data) {
        assert.match(html, /class="page"><header[^>]*data-page-header/);
        assert.match(html, /href="\/updates"[^>]*>.*?All updates<\/a><h2[^>]*>Update<\/h2>/);
      }
    }
  }
});
test('list page keeps the kit header on empty results and uses the safe service error with retry', async () => {
  for (const result of [{ data: { items: [], nextCursor: null } }, { status: 503, error: 'Private upstream diagnostic' }]) {
    const page = load('updates/page.tsx', { '../lib/api': { apiV1: async () => result }, '../lib/brand-server': { orgZone: async () => zone }, '../ui': ui, './views': views }).default;
    const html = renderToStaticMarkup(await page({ searchParams: Promise.resolve({}) }));
    if (result.data) {
      assert.match(html, /class="page"><header[^>]*data-page-header/);
      assert.match(html, /The latest hand-offs, shared with you\./);
      assert.match(html, /No updates yet/);
    } else {
      assert.match(html, /Try again/);
      assert.doesNotMatch(html, /Private upstream diagnostic/);
    }
  }
});
test('the open POST forwards the signed-in session and keeps reads uncached', async () => {
  const calls = [];
  const api = load('lib/api.ts', { 'next/headers': { headers: async () => new Map(), cookies: async () => new Map([['pulse_session', { value: 'synthetic-session' }]]) }, './host-mode.mjs': { passwordHost: async () => false, requestHost: () => 'studio.example', hostHeader: () => ({ 'x-pulse-host': 'studio.example' }) }, './load-error.mjs': { apiFailure: () => 'Unavailable' }, globals: { fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => update }; } } });
  await api.apiV1('/api/v1/updates?limit=1');
  await api.apiV1(`/api/v1/updates/${update.id}/open`, { method: 'POST' });
  assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[1].options.method, 'POST');
  for (const { options } of calls) {
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['x-pulse-session'], 'synthetic-session');
  }
});

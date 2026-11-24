// USER-INSIGHT (22 Nov 2026): the design system's link tabs (My desk, Work, HR) move at once and ignore a second press
// on a tab that is already loading. Production telemetry, 18 Nov 17:04:20-24 (Bevit, My desk): Policies pressed 5
// times and Performance 6 times in four seconds; every press restarted the slow server page ("cut: interrupted"), so
// the screen never changed and the presses showed as dead and angry clicks (ui.dead, ui.rage). Same rows on /tasks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const css = new Proxy({}, { get: (_, key) => key });
function load(path) {
  const mod = { exports: {} };
  const out = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(out, { module: mod, exports: mod.exports, setTimeout, clearTimeout,
    require: (name) => (name.endsWith('.css') ? { __esModule: true, default: css } : require(name)) });
  return mod.exports;
}
const ds = load('../../../../packages/design-system/src/ui/index.tsx');
// The module runs in its own VM context: copy its answers so deepEqual compares plain objects of this realm.
const press = (p) => ({ ...ds.tabPress(p) });
const plain = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0 };

test('a press on another tab follows the link and marks that tab as on its way', () => {
  assert.deepEqual(press({ key: 'growth', current: 'time', chosen: null, ...plain }), { follow: true, chosen: 'growth' });
});

test('a second press on the tab that is already loading does nothing (no restarted page)', () => {
  assert.deepEqual(press({ key: 'growth', current: 'time', chosen: 'growth', ...plain }), { follow: false, chosen: 'growth' });
});

test('a press on a third tab while one loads goes to the third (the person changed their mind)', () => {
  assert.deepEqual(press({ key: 'about', current: 'time', chosen: 'growth', ...plain }), { follow: true, chosen: 'about' });
});

test('a press on the open tab while another loads goes back to it, with nothing left loading', () => {
  assert.deepEqual(press({ key: 'time', current: 'time', chosen: 'growth', ...plain }), { follow: true, chosen: null });
});

test('the open tab and modified clicks keep the browser and Next defaults', () => {
  assert.deepEqual(press({ key: 'time', current: 'time', chosen: null, ...plain }), { follow: true, chosen: null });
  for (const mod of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    assert.deepEqual(press({ key: 'growth', current: 'time', chosen: null, ...plain, ...mod }), { follow: true, chosen: null });
  }
});

test("Bevit's 18 Nov presses start two page loads, not eleven", () => {
  // The tab row's own order of presses at 17:04:20-24 (policies x5, then performance x6); current stayed "requests".
  const presses = ['about', 'about', 'about', 'about', 'about', 'growth', 'growth', 'growth', 'growth', 'growth', 'growth'];
  let chosen = null, loads = 0;
  for (const key of presses) {
    const r = press({ key, current: 'requests', chosen, ...plain });
    if (r.follow) loads += 1;
    chosen = r.chosen;
  }
  assert.equal(loads, 2);
  assert.equal(chosen, 'growth');
});

test('link tabs render the open tab as current and nothing as loading', () => {
  const html = renderToStaticMarkup(createElement(ds.Tabs, { label: 'My desk', current: 'time', items: [
    { key: 'overview', label: 'Overview', href: '/me' },
    { key: 'time', label: 'Time', href: '/me?tab=attendance' },
    { key: 'growth', label: 'Growth', href: '/me?tab=performance' }] }));
  assert.match(html, /<a href="\/me\?tab=attendance" class="tab" aria-current="page"/);
  assert.equal((html.match(/aria-current=/g) ?? []).length, 1);
  assert.doesNotMatch(html, /data-pending|aria-busy/);
});

test('button tabs are unchanged', () => {
  const html = renderToStaticMarkup(createElement(ds.Tabs, { current: 'a', items: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }));
  assert.match(html, /<button type="button" class="tab" aria-selected="true">A<\/button>/);
  assert.match(html, /<button type="button" class="tab" aria-selected="false">B<\/button>/);
});

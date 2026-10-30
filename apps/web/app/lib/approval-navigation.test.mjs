import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const blank = () => null;
const styles = new Proxy({}, { get: (_, key) => key });
const ui = {
  styles, Avatar: blank, Why: blank, Empty: blank,
  Badge: ({ children }) => createElement('span', null, children),
  Panel: ({ tools, children }) => createElement('section', null, tools, children),
  Page: ({ children }) => createElement('main', null, children),
  PageHeader: ({ actions }) => createElement('header', null, actions),
  Message: ({ text }) => createElement('p', null, text),
};
function load(path, mocks) {
  const fixtureModule = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, { module: fixtureModule, exports: fixtureModule.exports, encodeURIComponent, require: name =>
    name.endsWith('.css') ? { __esModule: true, default: styles } : mocks[name] ?? require(name) });
  return fixtureModule.exports;
}
const { FlowQueue } = load('../hr/flow-actions.tsx', {
  '@pulse/ui-shell': {}, '../kit': {}, '../lib/do-param': {}, '../destinations/registry.mjs': {},
  'next/navigation': { useRouter: () => ({ refresh: blank }) }, '../records': {}, '../ui': ui,
  '../lib/format': { ago: () => 'just now', dayTime: () => '28 Oct' },
  './desk/clamp': {}, './desk/parts': { shortRange: () => '28 Oct' },
  './types': { REG_KIND: {}, dayCount: days => `${days} days` }, './pods': {},
  '../kit/date-field': {}, '../kit/select-field': {},
  '../org-code': { useWords: () => ({ team: 'Team', teams: 'Teams', client: 'Client', clients: 'Clients', project: 'Project', projects: 'Projects' }) },
});
const rows = ['pending', 'approved'].map((status, i) => ({
  id: `flow-${i}`, personId: `synthetic-person-${i}`, name: `Synthetic Person ${i}`, status,
  kind: 'leave', subject: 'annual leave', stage: 'hr', canDecide: true,
  details: {}, needsHr: [], history: [], fromDate: '2026-10-28', toDate: '2026-10-28',
}));
const data = staff => ({ rows, me: 'synthetic-reviewer', staff, cofounder: false });
const renderQueue = (staff, selected = rows[0].id) => renderToStaticMarkup(createElement(FlowQueue, { data: data(staff), selected }));

test('approval cards link each requester to their own profile, including decided requests', () => {
  const html = renderQueue(true);
  for (const row of rows) assert.match(html, new RegExp(`href="/people/${row.personId}"[^>]*>${row.name}</a>`));
});

test('open requests link to the exact person and the Leave & requests part of their attendance tab', () => {
  for (const row of rows) {
    const html = renderQueue(true, row.id);
    const href = html.match(/href="([^"]+)"[^>]*>Leave &amp; requests<\/a>/)?.[1];
    assert.ok(href, 'the expanded request has a Leave & requests link');
    const destination = new URL(href.replaceAll('&amp;', '&'), 'https://pulse.example.test');
    assert.equal(destination.pathname, `/people/${row.personId}`);
    assert.equal(destination.searchParams.get('tab'), 'attendance');
    assert.equal(destination.searchParams.get('detail'), 'Leave & requests');
    assert.match(html, new RegExp(`href="/people/${row.personId}\\?tab=hr"[^>]*>HR record</a>`));
  }
});

test('pod heads retain person and request navigation without HR record shortcuts', () => {
  const html = renderQueue(false);
  assert.match(html, /href="\/people\/synthetic-person-0"/);
  assert.match(html, />Leave &amp; requests<\/a>/);
  assert.doesNotMatch(html, /HR record|tab=hr/);
});

test('Approvals offers the HR desk only to HR viewers and preserves My desk and selected requests', async () => {
  for (const staff of [true, false]) {
    let queueProps;
    const { default: Approvals } = load('../me/approvals/page.tsx', {
      '../../lib/api': { api: async path => { assert.equal(path, 'hr/flows'); return { data: data(staff) }; } },
      '../../module-off': {}, '../../ui': ui,
      '../../hr/flow-actions': { FlowQueue: props => { queueProps = props; return null; } },
    });
    const html = renderToStaticMarkup(await Approvals({ searchParams: Promise.resolve({ request: rows[1].id }) }));
    assert.match(html, /href="\/me"[^>]*>My desk<\/a>/);
    assert.equal(/href="\/hr"[^>]*>HR desk<\/a>/.test(html), staff);
    assert.equal(queueProps.selected, rows[1].id);
  }
});

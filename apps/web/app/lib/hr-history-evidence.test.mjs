import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const styles = new Proxy({}, { get: (_, key) => key });
function load(path, mocks = {}) {
  const mod = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, { module: mod, exports: mod.exports, URL, URLSearchParams, require: name =>
    name.endsWith('.css') ? { __esModule: true, default: styles } : mocks[name] ?? require(name) });
  return mod.exports;
}
const evidenceModule = load('../hr-history/evidence.tsx');
const render = value => renderToStaticMarkup(createElement(evidenceModule.HistoryEvidence, { value }));
const imported = {
  row: 12, url: 'https://drive.google.com/open?id=synthetic-report', sheet: 'December 2026',
  method: 'reported numeric count', source: 'drive_sheet', columns: ['Employee Name', 'Leaves', 'Work From Home'],
  source_id: 'internal-source-id', confidence: 1,
};

test('HR history renders readable source details instead of the import JSON', async () => {
  const passthrough = ({ children }) => createElement('div', null, children);
  const common = load('../company/common.tsx', { '../ui': { styles } });
  const { default: History } = load('../hr-history/page.tsx', {
    './evidence': evidenceModule,
    '../records': { RecordForm: () => null },
    '../company/common': common,
    '../ui': { styles, Page: passthrough, PageHeader: () => null, Pager: passthrough },
    '../lib/api': { api: async () => ({ data: {
      rows: [{ source_key: 'synthetic-row', person_label: 'Synthetic Person', month: '2026-12-01', evidence: [imported] }],
      total: 1, page: 0, detail: '', canEdit: false, people: [],
    } }) },
  });
  const html = renderToStaticMarkup(await History({ searchParams: Promise.resolve({}) }));
  assert.match(html, /<summary>Source details<\/summary>/);
  assert.match(html, /<dt>Sheet<\/dt><dd>December 2026<\/dd>/);
  assert.match(html, /<dt>Row<\/dt><dd>12<\/dd>/);
  assert.match(html, /<dt>Method<\/dt><dd>reported numeric count<\/dd>/);
  assert.match(html, /<dt>Columns<\/dt><dd>Employee Name, Leaves, Work From Home<\/dd>/);
  assert.match(html, /href="https:\/\/drive.google.com\/open\?id=synthetic-report" target="_blank" rel="noopener noreferrer">Open source report<\/a>/);
  assert.doesNotMatch(html, /<pre|source_id|internal-source-id|confidence|drive_sheet|\[\{/);
  assert.match(html, /title="Not in the report">—<\/span>/, 'missing counts remain unknown');
});

test('manual HR evidence names its source and reason without exposing the author ID', () => {
  const html = render({ source: 'manual_hr_history', enteredBy: 'internal-person-id', enteredAt: '2026-10-01T10:00:00Z', reason: 'Confirmed against the archived report' });
  assert.match(html, /Recorded by HR in Pulse/);
  assert.match(html, /<dt>Reason<\/dt><dd>Confirmed against the archived report<\/dd>/);
  assert.doesNotMatch(html, /enteredBy|internal-person-id|manual_hr_history/);
});

test('multiple sources stay separate and empty or malformed evidence has a readable fallback', () => {
  const html = render([imported, { sheet: 'November 2026', row: 3 }]);
  assert.equal((html.match(/Imported report/g) ?? []).length, 2);
  assert.match(html, /November 2026/);
  for (const value of [null, [], {}, [null, 42, 'invalid'], 'invalid']) {
    assert.match(render(value), /No source details available/);
    assert.doesNotMatch(render(value), /Unknown|\[object Object\]/);
  }
});

test('source links reject executable URLs and source text is escaped', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,unsafe', '/relative', 'not a URL']) {
    assert.doesNotMatch(render({ ...imported, url }), /<a /);
  }
  const html = render({ sheet: '<script>alert(1)</script>', columns: [{ internal: 'hidden' }, 'Leaves'] });
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|\[object Object\]|internal/);
});

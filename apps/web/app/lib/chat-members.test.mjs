import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as format from './chat-format.mjs';

const blank = () => null, require = createRequire(import.meta.url);
async function component(path, mocks = {}) {
  const fixtureModule = { exports: {} };
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled, { module: fixtureModule, exports: fixtureModule.exports, require: name => name.endsWith('.css')
    ? { __esModule: true, default: new Proxy({}, { get: (_, k) => k }) } : mocks[name] ?? require(name) });
  return fixtureModule.exports;
}
const { AiBadge } = await component('../kit/ai-badge.tsx', { './popover': { Tooltip: ({ children }) => children } });

test('AI badge labels and tooltip use only the supplied employee ID', () => {
  for (const employeeId of [undefined, null, 'DEMO-AI-001']) {
    const badge = AiBadge({ employeeId });
    const expected = employeeId ? `AI employee · ${employeeId}` : 'AI employee';
    assert.equal(badge.props.content, expected);
    assert.match(renderToStaticMarkup(badge), new RegExp(`role="img" aria-label="${expected}"`));
  }
});

test('group info labels an AI member for a non-leader, links its profile, and never labels a human', async () => {
  const members = [{ id: 'ai', name: 'Studio Assistant', agent: true, employeeId: 'DEMO-AI-001' }, { id: 'human', name: 'Studio Member', agent: false }];
  const { InfoPanel } = await component('../chats/panels.tsx', {
    '../ui': { Avatar: blank }, '../kit/ai-badge': { AiBadge }, '../presence': { PresenceLine: blank }, '../lib/chat-format.mjs': format,
    './store': { cachedThread: () => ({ members }), storeVersion: () => 0, subscribe: () => () => {} }, './parts': { GroupAvatar: blank },
    './conversation': { Confirm: blank }, './net': { send: blank },
    './aside': { ChatAside: ({ className, label, children }) => createElement('aside', { className, 'aria-label': label }, children), MEDIA_EVENT: 'media' }, './v3': { Gallery: blank },
  });
  const html = renderToStaticMarkup(createElement(InfoPanel, { channel: { id: 'chat', name: 'Updates', kind: 'custom' },
    data: { viewer: 'human', people: [], canLead: false }, onClose: blank, onChanged: blank, onMessage: blank, onLeft: blank, onPin: blank }));
  assert.match(html, /href="\/people\/ai\/ai">Studio Assistant<\/a>/);
  assert.equal((html.match(/aria-label="AI employee · DEMO-AI-001"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /You[^<]*<span[^>]*aria-label="AI employee/);
});

test('mention row options preserve the server list and mark only agent rows', async () => {
  const { personOptions } = await component('../kit/combobox.tsx', {
    './ai-badge': { AiBadge }, './popover': { Popover: blank }, './person': { Avatar: blank, PersonChip: blank },
  });
  const people = [{ id: 'ai', name: 'Studio Assistant', agent: true }, { id: 'human', name: 'Studio Member', agent: false }];
  const options = personOptions(people);
  assert.equal(options.length, people.length);
  assert.match(renderToStaticMarkup(options[0].tag), /aria-label="AI employee"/);
  assert.equal(renderToStaticMarkup(options[1].tag), '');
  assert.equal(personOptions([]).length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../create.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

function mount() {
  const listeners = new Map(), opened = [], cleanups = [];
  const document = {
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name, handler) => { if (listeners.get(name) === handler) listeners.delete(name); },
    querySelector: () => null,
  };
  class HTMLElement { constructor(tagName) { this.tagName = tagName; } }
  const fixtureModule = { exports: {} };
  // Only CreateHost runs: dialog and presentation imports are inert.
  runInNewContext(compiled, {
    module: fixtureModule, exports: fixtureModule.exports, document, HTMLElement,
    window: { addEventListener() {}, removeEventListener() {} },
    require: (name) => name === 'react' ? {
      useState: () => [null, (value) => opened.push(value)],
      useEffect: (effect) => cleanups.push(effect()),
    } : {},
  });
  fixtureModule.exports.CreateHost();
  return {
    opened, listeners, unmount: () => cleanups.forEach((cleanup) => cleanup()),
    key: (fields = {}) => {
      let prevented = false;
      listeners.get('keydown')({ target: new HTMLElement('BODY'), ...fields, preventDefault() { prevented = true; } });
      return prevented;
    },
    input: new HTMLElement('INPUT'),
  };
}

test('autofill keydown without a key does not throw, consume input or open Create', () => {
  const host = mount();
  for (const key of [undefined, null, '']) {
    assert.equal(host.key({ key, target: host.input }), false);
  }
  assert.equal(host.opened.length, 0);
});

test('C and N still open Create; typing and modified shortcuts leave it closed', () => {
  const host = mount();
  for (const fields of [{ target: host.input }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
    assert.equal(host.key({ key: 'n', ...fields }), false);
  }
  assert.equal(host.opened.length, 0);
  assert.equal(host.key({ key: 'c' }), true);
  assert.equal(host.key({ key: 'N' }), true);
  assert.deepEqual(JSON.parse(JSON.stringify(host.opened)), [{ n: 1, request: {} }, { n: 2, request: { kind: 'task' } }]);
  host.unmount();
  assert.equal(host.listeners.has('keydown'), false);
});

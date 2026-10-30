// Synthetic static render harness, shared by the focused tests and screenshot capture.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as loadError from '../../apps/web/app/lib/load-error.mjs';
import * as nextStep from '../../apps/web/app/lib/next-step.mjs';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const ts = require('typescript'), React = require('react');
export const element = React.createElement;
export const render = (component, props) => require('react-dom/server').renderToStaticMarkup(React.createElement(component, props));
export const link = ({ prefetch, children, ...props }) => React.createElement('a', { ...props, 'data-prefetch': String(prefetch) }, children);
export function load(file, mocks = {}) {
  const module = { exports: {} };
  const source = readFileSync(new URL(`../../apps/web/app/${file}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled, { module, exports: module.exports, require: name => Object.hasOwn(mocks, name) ? mocks[name] : name.endsWith('.css') ? { __esModule: true, default: new Proxy({}, { get: (_, key) => name.endsWith('updates.module.css') ? `updates_${key}` : key }) } : name === 'next/link' ? { __esModule: true, default: link } : require(name), URLSearchParams, encodeURIComponent, process, AbortSignal, ...mocks.globals });
  return module.exports;
}
// Real shared page chrome, states, Avatar and AiBadge; only unrelated imports are stubbed.
const stub = new Proxy({ __esModule: true }, { get: (target, key) => key in target ? target[key] : () => null });
const retry = { RetryButton: () => React.createElement('button', null, 'Try again') };
export const ui = load('ui.tsx', { ...Object.fromEntries(['./sections', './fit', './presence', '@pulse/ui-shell', './lib/editor-credit.mjs', './lib/sparse.mjs', './charts', './destinations/registry.mjs', './lib/format', './query-tabs'].map(name => [name, stub])), './header-actions': load('header-actions.tsx'), './lib/load-error.mjs': loadError, './lib/next-step.mjs': nextStep, './retry-button': retry });
export const aiBadge = load('kit/ai-badge.tsx', { './popover': { Tooltip: ({ children }) => children } });
export const views = load('updates/views.tsx', { '../retry-button': retry, '../ui': ui, '../kit/ai-badge': aiBadge });
export const update = {
  id: '11111111-1111-4111-8111-111111111111', slot: '2026-10-18-pm', period: 'night', headline: 'A new workspace is live. Your next requests are ready to try.', createdAt: '2026-10-18T15:30:00Z',
  poster: 'Studio Chief of Staff (AI)', onBehalf: { id: 'sender', name: 'Asha Rao' }, openedAt: null, isSender: true,
  counts: { live: 1, readyToTry: 1, requests: 2, ideas: 1, needsYou: 1 },
  sections: {
    live: [{ title: 'A clearer Home', note: 'See your work and the latest hand-off in one place.', tag: 'Live' }],
    readyToTry: [{ title: 'Project workspace', note: 'Try the first screens on the test site.', tag: 'Test site' }],
    requests: [{ title: 'Creative review workflow', note: 'The first review steps are connected.', status: 'In progress', progress: 35 }, { title: 'Import project history', note: 'A trial import is planned.', status: 'Planned', progress: 0 }],
    ideas: [{ title: 'A library for every team', note: 'Reusable tools, with the company’s own words.', tag: 'Planned' }],
    needsYou: [{ text: 'Try the project workspace and share your feedback.' }],
    plan: { label: 'Tomorrow', items: [{ title: 'Finish the first review flow', note: 'Test the hand-off from one person to the next.' }] },
  },
  openedBy: [{ personId: 'recipient', name: 'Dev Kalah', openedAt: '2026-10-18T03:44:00Z' }],
};

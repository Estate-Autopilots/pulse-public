import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as finishGate from './finish-gate.mjs';

const blank = () => null;
const styles = new Proxy({}, { get: (_, key) => key });
const task = { id: 'parent', title: 'Parent task', status: 'in_progress', assigneeId: 'viewer', subtasksOpen: 0 };
const child = { id: 'child', title: 'Open child', status: 'open' };
const refusal = 'Finish, move out or cancel its open subtask first';

// Load the real components and handlers, replacing only their browser/UI dependencies.
function screen(error = new Error(refusal)) {
  const pushes = [], notices = [], calls = [], states = new Map(), modules = new Map();
  let active, index, refreshes = 0;
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const react = {
    useState(initial) {
      const values = states.get(active), slot = index++;
      if (!(slot in values)) values[slot] = typeof initial === 'function' ? initial() : initial;
      return [values[slot], value => { values[slot] = typeof value === 'function' ? value(values[slot]) : value; }];
    },
    useEffect: blank, useMemo: fn => fn(), useRef: value => ({ current: value }),
  };
  function load(path) {
    if (modules.has(path)) return modules.get(path);
    const fixtureModule = { exports: {} };
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    const mocks = {
      react, 'react/jsx-runtime': { jsx, jsxs: jsx },
      'next/navigation': { useRouter: () => ({ push: href => pushes.push(href), refresh: () => refreshes++ }) },
      '@pulse/ui-shell': { notify: notice => notices.push(notice) },
      '../records': { Modal: blank, post: async (path, body) => { calls.push({ path, body }); throw error; } },
      '../ui': { styles, Avatar: blank },
      '../lib/finish-gate.mjs': finishGate,
      '../lib/task-states.mjs': { isClosed: status => ['done', 'in_review', 'accepted', 'cancelled', 'not_applicable'].includes(status) },
      './parts': { STATUS: { in_progress: { label: 'Doing' } }, dueText: blank, doneText: blank },
      './tick-done': { tickProps: title => ({ label: `Mark “${title}” done` }), tickDone: (_, run) => run() },
    };
    runInNewContext(code, {
      module: fixtureModule, exports: fixtureModule.exports, Error, Set, document: { activeElement: null, querySelector: blank },
      require: name => name === './finish-gate' ? load('../tasks/finish-gate.ts')
        : name === './life' ? load('../tasks/life.tsx')
        : name.endsWith('.css') ? { __esModule: true, default: styles }
        : mocks[name] ?? new Proxy({}, { get: () => blank }),
    });
    modules.set(path, fixtureModule.exports);
    return fixtureModule.exports;
  }
  return {
    load, pushes, notices, calls, get refreshes() { return refreshes; },
    render(component, props) {
      active = component; index = 0;
      if (!states.has(component)) states.set(component, []);
      return component(props);
    },
  };
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props?.children)];
}
const button = (tree, label) => nodes(tree).find(n => n.type === 'button' &&
  (n.props['aria-label'] === label || [].concat(n.props.children).includes(label)));
const settle = () => new Promise(resolve => setImmediate(resolve));
const detail = children => ({ task, children, me: 'viewer', proof: [], can: {}, members: [], blockedBy: [] });

for (const count of [undefined, 0]) test(`a task row recovers from a server refusal with subtask count ${count}`, async () => {
  const h = screen(), { TaskRow } = h.load('../tasks/client.tsx');
  const props = { task: { ...task, subtasksOpen: count }, today: '2026-01-01', me: 'viewer' };
  button(h.render(TaskRow, props), 'Mark “Parent task” done').props.onClick({ currentTarget: {} });
  await settle();
  assert.deepEqual(h.pushes, ['/tasks/parent?finish=1']);
  assert.equal(h.notices.some(n => n.tone === 'error'), false);
  assert.equal(button(h.render(TaskRow, props), 'Mark “Parent task” done').props.disabled, false);
});

test('a known open subtask opens the task without attempting completion', () => {
  const h = screen(), { TaskRow } = h.load('../tasks/client.tsx');
  const tree = h.render(TaskRow, { task: { ...task, subtasksOpen: 2 }, today: '2026-01-01', me: 'viewer' });
  button(tree, 'Mark “Parent task” done').props.onClick({ currentTarget: {} });
  assert.deepEqual(h.pushes, ['/tasks/parent?finish=1']);
  assert.equal(h.calls.length, 0);
});

test('other completion errors remain visible and do not open the finishing dialog', async () => {
  const h = screen(new Error('Task not found')), { TaskRow } = h.load('../tasks/client.tsx');
  button(h.render(TaskRow, { task, today: '2026-01-01', me: 'viewer' }), 'Mark “Parent task” done').props.onClick({ currentTarget: {} });
  await settle();
  assert.deepEqual(h.pushes, []);
  assert.equal(h.notices.at(-1).message, 'Task not found');
});

test('a stale task page refreshes and opens Mark done with each newly discovered child action', async () => {
  const h = screen(), { TaskActions } = h.load('../tasks/focus.tsx');
  button(h.render(TaskActions, { d: detail([]), options: null }), 'Mark done').props.onClick();
  await settle();
  const dialog = nodes(h.render(TaskActions, { d: detail([]), options: null })).find(n => n.type?.name === 'DoneDialog');
  assert.ok(dialog, 'the refused completion opens Mark done');
  assert.equal(h.refreshes, 1, 'refresh the stale children');
  assert.equal(h.notices.some(n => n.tone === 'error'), false);
  // The dialog may mount before the refresh arrives; newly loaded children must disable Mark done.
  h.render(dialog.type, dialog.props);
  const refreshed = h.render(dialog.type, { ...dialog.props, d: detail([child, { ...child, id: 'other', title: 'Another child' }]) });
  assert.equal(button(refreshed.props.foot, 'Mark done').props.disabled, true);
  const subs = nodes(refreshed).find(n => n.type?.name === 'OpenSubtasks');
  const rows = nodes(h.render(subs.type, subs.props)).filter(n => n.type === 'li');
  assert.equal(rows.length, 2);
  for (const row of rows) for (const label of ['Finish', 'Move out', 'Cancel…']) assert.ok(button(row, label), label);
  subs.props.onAllClosed();
  const resolved = h.render(dialog.type, { ...dialog.props, d: detail([child, { ...child, id: 'other' }]) });
  assert.equal(button(resolved.props.foot, 'Mark done').props.disabled, false, 'all resolved children enable completion immediately');
  const added = h.render(dialog.type, { ...dialog.props, d: detail([{ ...child, id: 'new-child' }]) });
  assert.equal(button(added.props.foot, 'Mark done').props.disabled, true, 'new children need to be resolved too');
});

test('Finish on a subtask with its own open children opens its finishing dialog', async () => {
  const h = screen(), { OpenSubtasks } = h.load('../tasks/life.tsx');
  let closed = false;
  const props = { items: [child], onAllClosed: () => { closed = true; } };
  button(h.render(OpenSubtasks, props), 'Finish').props.onClick();
  await settle();
  assert.deepEqual(h.pushes, ['/tasks/child?finish=1']);
  assert.equal(closed, false);
  assert.equal(h.notices.some(n => n.tone === 'error'), false);
  assert.ok(button(h.render(OpenSubtasks, props), 'Finish'), 'the child remains open');
});

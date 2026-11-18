import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const blank = () => null;
const styles = new Proxy({}, { get: (_, key) => key });
const task = (id, updatedAt) => ({
  id, title: `Task ${id}`, status: 'open', priority: 'normal', assigneeId: 'viewer',
  updatedAt, dueAt: null, dueOn: null, subtasksOpen: 0,
});
const first = task('a', '2026-01-01T12:00:00Z');
const second = task('b', '2026-01-01T11:00:00Z');

// Exercise the real table, parent view, filters and sorting; replace browser/UI dependencies only.
function screen({ fail = false, status = 'open', sort = 'due' } = {}) {
  const states = new Map(), modules = new Map(), calls = [], undos = [], notices = [];
  let active, index, refreshes = 0;
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const react = {
    useState(initial) {
      const values = states.get(active), slot = index++;
      if (!(slot in values)) values[slot] = typeof initial === 'function' ? initial() : initial;
      return [values[slot], value => { values[slot] = typeof value === 'function' ? value(values[slot]) : value; }];
    },
    useRef: value => ({ current: value }), useMemo: fn => fn(), useCallback: fn => fn, useEffect: blank,
    createElement: jsx,
  };
  function load(path) {
    if (modules.has(path)) return modules.get(path);
    const fixtureModule = { exports: {} };
    const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const mocks = {
      react, 'react/jsx-runtime': { jsx, jsxs: jsx },
      'next/navigation': { useRouter: () => ({ refresh: () => refreshes++ }) },
      '@pulse/ui-shell': { notify: notice => notices.push(notice) },
      '../../records': { post: async (path, body) => {
        calls.push({ path, body });
        if (fail) throw new Error('Could not save');
        return {};
      } },
      '../../create': { useWorkOptions: () => ({ data: null }) },
      '../client': { celebrate: (_result, _title, _unused, undo) => undos.push(undo) },
      '../parts': { STATUS: { open: { label: 'To do' }, done: { label: 'Done' } }, dueText: blank },
      '../tick-done': { tickProps: title => ({ label: `Mark “${title}” done` }), tickDone: (_id, run) => run() },
      '../priority': { PRIORITIES: [] },
    };
    runInNewContext(code, {
      module: fixtureModule, exports: fixtureModule.exports, Error, Set, Map, URLSearchParams,
      require: name => name === './model' ? load('../tasks/views/model.ts')
        : name === './table' ? load('../tasks/views/table.tsx')
        : name.endsWith('.css') ? { __esModule: true, default: styles }
        : mocks[name] ?? new Proxy({}, { get: () => blank }),
    });
    modules.set(path, fixtureModule.exports);
    return fixtureModule.exports;
  }
  const { TaskViews } = load('../tasks/views/task-views.tsx');
  const { TableView } = load('../tasks/views/table.tsx');
  const { NO_FILTERS } = load('../tasks/views/model.ts');
  function render(component, props) {
    active = component; index = 0;
    if (!states.has(component)) states.set(component, []);
    return component(props);
  }
  return {
    calls, undos, notices, get refreshes() { return refreshes; },
    render(rows) {
      const parent = render(TaskViews, {
        place: 'company', prefKey: 'company', rows, today: '2026-01-01', me: 'viewer', saved: [],
        initial: { layout: 'table', group: 'none', sort, filters: { ...NO_FILTERS, status } },
      });
      const table = nodes(parent).find(n => n.type === TableView);
      if (!table) { states.delete(TableView); return parent; }
      return render(TableView, table.props);
    },
  };
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props?.children)];
}
const rowsOf = tree => nodes(tree).filter(n => n.type === 'tr' && n.props.children?.[0]?.type === 'td');
const circle = row => nodes(row).find(n => n.type === 'button');
const labels = tree => rowsOf(tree).map(row => circle(row).props['aria-label']);
const settle = () => new Promise(resolve => setImmediate(resolve));
const tick = row => circle(row).props.onClick({ currentTarget: {} });

test('completed rows keep their place through refresh, including the last open task', async () => {
  const h = screen();
  tick(rowsOf(h.render([first, second]))[0]);
  await settle();
  const afterFirst = h.render([{ ...first, status: 'done' }, second]);
  assert.deepEqual(labels(afterFirst), ['Task a: Done', 'Mark “Task b” done']);
  assert.equal(circle(rowsOf(afterFirst)[0]).props.disabled, true);
  tick(rowsOf(afterFirst)[1]);
  await settle();
  const afterLast = h.render([{ ...first, status: 'done' }, { ...second, status: 'done' }]);
  assert.deepEqual(labels(afterLast), ['Task a: Done', 'Task b: Done']);
  assert.ok(rowsOf(afterLast).every(row => circle(row).props.disabled));
  assert.deepEqual(labels(h.render([])), ['Task a: Done', 'Task b: Done'], 'server may omit finished tasks entirely');
  assert.equal(h.calls.length, 2);
  assert.equal(h.refreshes, 2);
  assert.equal(rowsOf(screen().render([])).length, 0, 'leaving the page clears the retained rows');
});

test('completion does not reorder a table sorted by recently changed after refresh', async () => {
  const h = screen({ status: 'all', sort: 'updated' });
  tick(rowsOf(h.render([first, second]))[1]);
  await settle();
  const tree = h.render([first, { ...second, status: 'done', updatedAt: '2026-01-01T13:00:00Z' }]);
  assert.deepEqual(labels(tree), ['Mark “Task a” done', 'Task b: Done']);
  assert.equal(circle(rowsOf(tree)[1]).props.disabled, true);
});

test('a retained completed task can be undone without moving the next circle', async () => {
  const h = screen();
  tick(rowsOf(h.render([first, second]))[0]);
  await settle();
  h.render([second]);
  h.undos[0]();
  await settle();
  const tree = h.render([first, second]);
  assert.deepEqual(labels(tree), ['Mark “Task a” done', 'Mark “Task b” done']);
  assert.equal(circle(rowsOf(tree)[0]).props.disabled, false);
  assert.equal(h.calls.at(-1).body.status, 'open');
});

test('a failed completion restores the open row and reports the failure', async () => {
  const h = screen({ fail: true });
  tick(rowsOf(h.render([first, second]))[0]);
  await settle();
  const tree = h.render([first, second]);
  assert.deepEqual(labels(tree), ['Mark “Task a” done', 'Mark “Task b” done']);
  assert.equal(circle(rowsOf(tree)[0]).props.disabled, false);
  assert.equal(h.undos.length, 0);
  assert.equal(h.notices.at(-1).message, 'Could not save');
});

test('an initially empty table still displays its empty state', () => {
  const tree = screen().render([]);
  assert.equal(rowsOf(tree).length, 0);
  assert.ok(nodes(tree).some(n => n.type === 'b' && n.props.children === 'Nothing here yet'));
});

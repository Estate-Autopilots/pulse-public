import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePaste, guessMapping} from './paste-table.mjs';

test('Sheets TSV strips BOM, detects headers and skips blank records', () => {
  assert.deepEqual(parsePaste('\uFEFFTask\tStatus\tOwner\nDraft banner\tOpen\tPerson A\n\t\t\n'), {
    format: 'tsv', fenced: false, header: ['Task', 'Status', 'Owner'],
    rows: [['Draft banner', 'Open', 'Person A']], overflow: 0, problems: [],
  });
});

test('Excel TSV preserves multiline quoted cells, embedded tabs and doubled quotes', () => {
  const parsed = parsePaste('Title\tStatus\r\n"Draft\r\n""hero""\timage"\tOpen\r\n');
  assert.equal(parsed.format, 'tsv');
  assert.deepEqual(parsed.rows, [['Draft\n"hero"\timage', 'Open']]);
  assert.deepEqual(parsed.problems, []);
});

test('RFC CSV handles quoted commas, newlines, doubled quotes and CRLF', () => {
  const parsed = parsePaste('Subject,State,Person\r\n"Edit, review","In\r\nprogress","Person ""B"""\r\n');
  assert.equal(parsed.format, 'csv');
  assert.deepEqual(parsed.header, ['Subject', 'State', 'Person']);
  assert.deepEqual(parsed.rows, [['Edit, review', 'In\nprogress', 'Person "B"']]);
  assert.deepEqual(parsed.problems, []);
});

test('semicolon CSV wins over commas inside task text', () => {
  const parsed = parsePaste('Task;Status;Priority\n"Draft, check; export";Open;High\nShip, review;Done;Low');
  assert.equal(parsed.format, 'csv');
  assert.deepEqual(parsed.rows, [['Draft, check; export', 'Open', 'High'], ['Ship, review', 'Done', 'Low']]);
});

test('Markdown supports optional outer pipes, alignment, escaping, bold and code', () => {
  for (const outer of [true, false]) {
    const lines = ['**Task** | `Status`', '--- | :--:', '**Draft** \\| `hero` | Open'];
    const parsed = parsePaste(lines.map(line => outer ? `| ${line} |` : line).join('\n'));
    assert.equal(parsed.format, 'markdown');
    assert.deepEqual(parsed.header, ['Task', 'Status']);
    assert.deepEqual(parsed.rows, [['Draft | hero', 'Open']]);
  }
  assert.deepEqual(parsePaste('| Task |\n| --- |\n| Draft |').rows, [['Draft']]);
});

test('ChatGPT fences use only the first block, ignoring surrounding prose', () => {
  for (const [tag, body, format] of [
    ['csv', 'Task,Status\nDraft,Open', 'csv'],
    ['markdown', '| Task | Status |\n| --- | --- |\n| Draft | Open |', 'markdown'],
    ['md', 'Task | Status\n--- | ---\nDraft | Open', 'markdown'],
    ['tsv', 'Task\tStatus\nDraft\tOpen', 'tsv'],
    ['', 'Task,Status\nDraft,Open', 'csv'],
  ]) {
    const parsed = parsePaste(`Here are tasks:\n\n\`\`\`${tag}\n${body}\n\`\`\`\nMore prose\n\`\`\`csv\nIgnored,Data\n\`\`\``);
    assert.equal(parsed.fenced, true);
    assert.equal(parsed.format, format);
    assert.deepEqual(parsed.rows, [['Draft', 'Open']]);
  }
});

test('plain bullet, numbered and checkbox lists retain punctuation in task titles', () => {
  const parsed = parsePaste('- Draft, review\n* [ ] Check; export\n1. [x] Ship\n[x] Archive\n\n- [ ]');
  assert.equal(parsed.format, 'lines');
  assert.equal(parsed.header, null);
  assert.deepEqual(parsed.rows, [['Draft, review'], ['Check; export'], ['Ship'], ['Archive']]);
  assert.deepEqual(parsePaste('Draft\nShip').rows, [['Draft'], ['Ship']]);
});

test('header detection preserves the first task when there is no header', () => {
  assert.equal(parsePaste('Draft\tOpen\nShip\tDone').header, null);
  assert.deepEqual(parsePaste('Draft\tOpen\nShip\tDone').rows, [['Draft', 'Open'], ['Ship', 'Done']]);
  assert.deepEqual(parsePaste('Task,Notes\nDraft,Details').header, ['Task', 'Notes']);
  assert.deepEqual(parsePaste('Task').rows, [['Task']]);
  assert.deepEqual(guessMapping(null), ['title']);
  assert.deepEqual(guessMapping(['Custom', 'Notes']), ['ignore', 'ignore']);
});

test('all aliases map case-insensitively with normalized whitespace', () => {
  for (const [field, names] of Object.entries({
    title: ['title', 'task', 'name', 'subject', 'to do'], status: ['status', 'state', 'stage'],
    assignee: ['assignee', 'owner', 'who', 'assigned to', 'person'], due: ['due', 'due date', 'deadline', 'date', 'by'],
    project: ['project', 'client', 'campaign'], priority: ['priority', 'prio', 'p', 'urgency'],
  })) assert.deepEqual(guessMapping(names.map(name => ` ${name.toUpperCase().replaceAll(' ', '  ')} `)), names.map(() => field));
});

test('ragged rows are padded and long cells are reported without cutting', () => {
  const long = 'x'.repeat(301);
  const parsed = parsePaste(`Task,Status,Owner\nDraft,Open\n${long},Done,Person A`);
  assert.deepEqual(parsed.rows, [['Draft', 'Open', ''], [long, 'Done', 'Person A']]);
  assert.deepEqual(parsed.problems, [
    {row: 2, message: 'Expected 3 cells; found 2.'}, {row: 3, message: 'Column 1 exceeds 300 characters.'},
  ]);
});

test('201 data rows explicitly overflow, whether or not a header is present', () => {
  const rows = Array.from({length: 201}, (_, i) => `Task ${i + 1}\tOpen`).join('\n');
  for (const prefix of ['', 'Title\tStatus\n']) {
    const parsed = parsePaste(prefix + rows);
    assert.equal(parsed.rows.length, 200);
    assert.equal(parsed.overflow, 1);
    assert.deepEqual(parsed.rows.at(-1), ['Task 200', 'Open']);
  }
});

test('empty and blank-only input has no header, rows, problems or overflow', () => {
  for (const text of ['', '\uFEFF\r\n \n\t\n']) assert.deepEqual(parsePaste(text), {
    format: 'lines', fenced: false, header: null, rows: [], overflow: 0, problems: [],
  });
});

test('unclosed quotes are surfaced and an empty final CSV field is retained', () => {
  assert.deepEqual(parsePaste('Task,Status\nDraft,').rows, [['Draft', '']]);
  assert.deepEqual(parsePaste('Task,Status\n"Draft,Open').problems, [
    {row: 2, message: 'Unclosed quoted cell.'}, {row: 2, message: 'Expected 2 cells; found 1.'},
  ]);
});

test('spreadsheet quoting round-trips punctuation and whitespace across supported delimiters', () => {
  const values = ['plain', ' comma, semicolon; tab\t ', 'line\nnext', 'a "quote"', 'pipe | **bold** `code`'];
  for (const delimiter of [',', ';', '\t']) {
    const quote = value => `"${value.replaceAll('"', '""')}"`;
    const body = [['Title', 'Notes'], ...values.map(value => [value, value])]
      .map(row => row.map(quote).join(delimiter)).join('\r\n');
    const parsed = parsePaste(`\`\`\`${delimiter === '\t' ? 'tsv' : 'csv'}\n${body}\n\`\`\``);
    assert.deepEqual(parsed.rows, values.map(value => [value, value]));
    assert.deepEqual(parsed.problems, []);
  }
});

test('untagged quoted CSV punctuation does not masquerade as TSV or Markdown', () => {
  for (const value of ['first\tsecond', 'left | right']) {
    const parsed = parsePaste(`"Draft | hero","${value}"\n"Ship | review","${value}"`);
    assert.equal(parsed.format, 'csv');
    assert.deepEqual(parsed.rows, [['Draft | hero', value], ['Ship | review', value]]);
    assert.deepEqual(parsed.problems, []);
  }
});

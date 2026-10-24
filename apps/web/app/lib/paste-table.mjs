/** @typedef {'title'|'status'|'assignee'|'due'|'project'|'priority'|'ignore'} Mapping */
/** @typedef {{row: number, message: string}} Problem */
/** @typedef {{cells: string[], row: number}} RecordRow */
/** @typedef {{format: 'tsv'|'csv'|'markdown'|'lines', fenced: boolean,
 * header: string[]|null, rows: string[][], overflow: number, problems: Problem[]}} PasteResult */

const aliases = [
  ['title', 'task', 'name', 'subject', 'to do'], ['status', 'state', 'stage'],
  ['assignee', 'owner', 'who', 'assigned to', 'person'], ['due', 'due date', 'deadline', 'date', 'by'],
  ['project', 'client', 'campaign'], ['priority', 'prio', 'p', 'urgency'],
];
/** @type {Mapping[]} */
const fields = ['title', 'status', 'assignee', 'due', 'project', 'priority'];

/** Infer header columns. Without a header, use title for column one and ignore any additional columns.
 * @param {string[]|null} header @returns {Mapping[]} */
export function guessMapping(header) {
  if (header === null) return ['title'];
  return header.map(cell => {
    const normalized = cell.trim().toLowerCase().replace(/\s+/g, ' ');
    const index = aliases.findIndex(names => names.includes(normalized));
    return index < 0 ? 'ignore' : fields[index];
  });
}

/** Parse logical records, including spreadsheet quoting. Row numbers include blank records and headers.
 * @param {string} text @param {string} delimiter */
function delimited(text, delimiter) {
  /** @type {RecordRow[]} */
  const records = [];
  /** @type {Problem[]} */
  const problems = [];
  let cells = [], cell = '', quoted = false, quotedCells = 0, invalidQuoteEndings = 0;
  const endCell = () => { cells.push(cell); cell = ''; };
  const endRow = () => { endCell(); records.push({cells, row: records.length + 1}); cells = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') {
        quoted = false;
        if (i + 1 < text.length && ![delimiter, '\n'].includes(text[i + 1])) invalidQuoteEndings++;
      }
      else cell += char;
    } else if (char === '"' && cell === '') { quoted = true; quotedCells++; }
    else if (char === delimiter) endCell();
    else if (char === '\n') endRow();
    else cell += char;
  }
  if (quoted) problems.push({row: records.length + 1, message: 'Unclosed quoted cell.'});
  endRow();
  return {records, problems, quotedCells, invalidQuoteEndings};
}

/** @param {string} line @returns {string[]} */
function markdownCells(line) {
  const source = line.trim(), cells = [];
  let cell = '';
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\\' && ['|', '\\'].includes(source[i + 1])) cell += source[++i];
    else if (char === '|') { cells.push(cell); cell = ''; }
    else cell += char;
  }
  cells.push(cell);
  if (source.startsWith('|')) cells.shift();
  if (source.endsWith('|') && cells.at(-1) === '') cells.pop();
  return cells.map(value => value.trim().replace(/\*\*(.*?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1'));
}

/** Deterministic paste parsing; problem.row is a one-based logical source record (header included).
 * Values remain intact, including long cells. Only returned data rows are capped at 200.
 * @param {string} text @returns {PasteResult} */
export function parsePaste(text) {
  let source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const fence = source.match(/(?:^|\n)[ \t]*```([^\n]*)\n([\s\S]*?)(?:\n[ \t]*```[ \t]*(?:\n|$)|$)/);
  const tag = fence?.[1].trim().toLowerCase();
  if (fence) source = fence[2].replace(/^\uFEFF/, '');
  const lines = source.split('\n');
  const nonblank = lines.filter(line => line.trim());
  const markdown = lines.map((line, i) => ({cells: markdownCells(line), row: i + 1}));
  const alignment = cells => cells.length > 0 && cells.every(cell => /^:?-{2,}:?$/.test(cell));
  const taggedMarkdown = tag === 'md' || tag === 'markdown';
  const isMarkdown = taggedMarkdown || markdown.some(record => alignment(record.cells) && lines[record.row - 1].includes('|'))
    || (nonblank.length > 0 && nonblank.every(line => markdownCells(line).length > 1)
      && (nonblank.length > 1 || /^\s*\|.*\|\s*$/.test(source)));
  const candidates = ['\t', ',', ';'].map(delimiter => ({delimiter, ...delimited(source, delimiter)}));
  // Tabs win over punctuation in spreadsheet cells; quoted delimiters never create columns.
  const tsv = candidates[0];
  const score = candidate => {
    if (candidate.invalidQuoteEndings) return 0;
    const rows = candidate.records.filter(record => record.cells.some(cell => cell.trim()));
    const frequencies = new Map();
    let separated = 0, consistent = 0;
    for (const {cells} of rows) {
      if (cells.length < 2) continue;
      separated++;
      const count = (frequencies.get(cells.length) ?? 0) + 1;
      frequencies.set(cells.length, count); consistent = Math.max(consistent, count);
    }
    return rows.length ? (separated * 10 + consistent) / rows.length : 0;
  };
  const csv = score(candidates[2]) > score(candidates[1]) ? candidates[2] : candidates[1];
  const bullets = nonblank.length > 0 && nonblank.every(line => /^\s*(?:[-*]\s+|\d+\.\s+|\[[ xX]\])/.test(line));
  /** @type {PasteResult['format']} */
  let format = 'lines';
  /** @type {RecordRow[]} */
  let records;
  /** @type {Problem[]} */
  let problems = [];
  if (tag === 'tsv' || (!taggedMarkdown && tag !== 'csv' && score(tsv) > 0)) {
    format = 'tsv'; ({records, problems} = tsv);
  } else if (isMarkdown && tag !== 'csv' && (taggedMarkdown || !csv.quotedCells || !score(csv))) {
    format = 'markdown'; records = markdown.filter(record => !alignment(record.cells));
  } else if (tag === 'csv' || (!bullets && score(csv) > 0)) {
    format = 'csv'; ({records, problems} = csv);
  } else {
    records = lines.map((line, i) => ({row: i + 1,
      cells: [line.trim().replace(/^(?:[-*]\s+|\d+\.\s+)?(?:\[[ xX]\]\s*)?/, '').trim()]}));
  }
  records = records.filter(record => record.cells.some(cell => cell.trim()));
  const width = records.reduce((max, record) => Math.max(max, record.cells.length), 0);
  for (const record of records) {
    if (record.cells.length !== width) {
      problems.push({row: record.row, message: `Expected ${width} cells; found ${record.cells.length}.`});
      while (record.cells.length < width) record.cells.push('');
    }
    record.cells.forEach((cell, i) => {
      if (cell.length > 300) problems.push({row: record.row, message: `Column ${i + 1} exceeds 300 characters.`});
    });
  }
  const first = records[0]?.cells;
  const mapping = first ? guessMapping(first) : [];
  const known = mapping.filter(field => field !== 'ignore').length;
  // A title alias or at least half recognized columns permits headers with extra, unmapped columns.
  const hasHeader = format !== 'lines' && known > 0 && (mapping.includes('title') || known >= width / 2);
  const header = hasHeader ? records.shift().cells : null;
  return {format, fenced: Boolean(fence), header, rows: records.slice(0, 200).map(record => record.cells),
    overflow: Math.max(0, records.length - 200), problems};
}

// DOCS-EDITOR-2 (owner, 17 Nov 2026: "tables … paste from Sheets/Excel"): rows copied from Google Sheets, Excel or Numbers
// as plain text are tab-separated, one row a line; a cell holding a line break or a tab comes in double quotes ("a""b"
// is a quote). This reads that text into rows of cells, and writes the rows as a doc table (the first row its header).
// When the copy also carries an HTML table, the editor reads that instead (it keeps the column widths).

export const MAX_ROWS = 2000;
export const MAX_COLS = 40;

/** The rows of cells in copied text, or null when it is not a grid (no tab, one line, or ragged past repair). */
export function parseGrid(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  if (!src.includes("\t")) return null;
  const rows = [];
  let row = [], cell = "", quoted = false, i = 0;
  const endCell = () => { row.push(cell); cell = ""; };
  const endRow = () => { endCell(); rows.push(row); row = []; };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === "\"" && src[i + 1] === "\"") { cell += "\""; i += 2; continue; }
      if (ch === "\"") { quoted = false; i += 1; continue; }
      cell += ch; i += 1; continue;
    }
    if (ch === "\"" && cell === "") { quoted = true; i += 1; continue; }
    if (ch === "\t") { endCell(); i += 1; continue; }
    if (ch === "\n") { endRow(); i += 1; continue; }
    cell += ch; i += 1;
  }
  if (cell !== "" || row.length) endRow();
  // A copy usually ends with a line break: no empty last row.
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === "")) rows.pop();
  if (rows.length < 2) return null;
  const width = Math.max(...rows.map((r) => r.length));
  if (width < 2) return null;
  // Most rows must have the full width; a short row is padded (Sheets drops trailing empty cells on some copies).
  const full = rows.filter((r) => r.length === width).length;
  if (full * 2 < rows.length) return null;
  return rows.slice(0, MAX_ROWS).map((r) => { const out = r.slice(0, MAX_COLS); while (out.length < Math.min(width, MAX_COLS)) out.push(""); return out; });
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cellHtml = (tag, text) => `<${tag}>${String(text).split("\n").map((line) => `<p>${esc(line.trim())}</p>`).join("")}</${tag}>`;

/** A doc table from rows of cells. `header`: the first row is the header (default when it reads as one). */
export function gridHtml(rows, { header } = {}) {
  if (!rows?.length) return "";
  const head = header ?? looksLikeHeader(rows);
  const body = rows.map((r, i) => `<tr>${r.map((c) => cellHtml(head && i === 0 ? "th" : "td", c)).join("")}</tr>`).join("");
  return `<table><tbody>${body}</tbody></table>`;
}

/** A first row of short words with no numbers, over rows that differ from it, reads as a header. */
export function looksLikeHeader(rows) {
  if (rows.length < 2) return false;
  const first = rows[0];
  if (!first.some((c) => c.trim())) return false;
  return first.every((c) => c.trim().length <= 60 && !/^[-+(]?[₹$€£]?\s?\d[\d,.]*%?\)?$/.test(c.trim()));
}

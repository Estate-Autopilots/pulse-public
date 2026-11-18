// GROWTH-LOOP slice 5 (owner, 8 Nov 2026): reading a price list in the browser. A CSV or TSV file, a table pasted from a
// doc or a sheet (tabs, or a Markdown/pipe table), or an Excel file's first sheet (read-excel-file) becomes rows; its
// columns are matched to the catalogue's fields by their names first and their values second; the API checks every
// row again (services/api/src/catalog-import.ts) before anything is made.

export const FIELDS = [
  { key: "name", label: "Name", hint: "What you sell", need: true },
  { key: "unit", label: "Unit", hint: "per video, per day, sq ft" },
  { key: "rate", label: "Rate", hint: "The price before GST", need: true },
  { key: "gst", label: "GST %", hint: "0, 5, 12, 18 or 28" },
  { key: "sac", label: "HSN/SAC", hint: "4 to 8 digits" },
  { key: "category", label: "Category", hint: "A group, like Video or Design" },
  // WL-ONBOARD-FIX (17 Nov 2026): what is on the shelf now (empty keeps the stock as it is).
  { key: "stock", label: "Stock", hint: "How many you have now" },
];

const WORDS = {
  name: ["name", "item", "service", "product", "particular", "particulars", "description", "item name", "service name", "work", "deliverable"],
  unit: ["unit", "per", "uom", "unit of measure", "units", "billing unit", "measure"],
  rate: ["rate", "price", "amount", "cost", "fee", "charges", "mrp", "selling price", "rate (inr)", "price (inr)", "rs", "inr", "₹"],
  gst: ["gst", "gst %", "gst%", "tax", "tax %", "gst rate", "igst", "tax rate"],
  sac: ["sac", "hsn", "hsn/sac", "sac code", "hsn code", "hsn / sac", "sac/hsn"],
  category: ["category", "type", "group", "section", "department", "head", "class"],
  stock: ["stock", "in stock", "qty", "quantity", "on hand", "stock qty", "closing stock", "available", "available qty", "balance qty", "current stock"],
};

/** Split one line of a CSV (quotes and doubled quotes kept as text). */
function csvCells(text, sep) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") q = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Text from a file or a paste → a table (rows of trimmed cells, empty rows dropped). Tabs win, then pipes, then ; or ,. */
export function parseTable(text) {
  const t = String(text ?? "").replace(/^﻿/, "");
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  let rows;
  if (lines.some((l) => l.includes("\t"))) rows = lines.map((l) => l.split("\t"));
  else if (lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length >= Math.min(2, lines.length))
    rows = lines.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, "").split("|"));
  else {
    const head = lines[0];
    const sep = (head.match(/;/g) ?? []).length > (head.match(/,/g) ?? []).length ? ";" : ",";
    rows = csvCells(t, sep);
  }
  return rows.map((r) => r.map((c) => String(c ?? "").trim())).filter((r) => r.some((c) => c));
}

/** An Excel sheet's rows (any cell type) → the same table. */
export const fromSheet = (data) => (data ?? []).map((r) => (r ?? []).map((c) => (c === null || c === undefined ? "" : c instanceof Date ? c.toISOString().slice(0, 10) : String(c).trim()))).filter((r) => r.some((c) => c));

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9%₹/ ]+/g, " ").replace(/\s+/g, " ").trim();

/** Which field each column fills: by its header first, then by what its values look like. -1 = not used. */
export function guessMapping(header, sample = []) {
  const map = Object.fromEntries(FIELDS.map((f) => [f.key, -1]));
  const taken = new Set();
  const h = header.map(norm);
  // 1. exact header words, then headers that contain a word.
  for (const pass of ["exact", "contains"]) for (const f of FIELDS) {
    if (map[f.key] >= 0) continue;
    const i = h.findIndex((x, j) => !taken.has(j) && x && WORDS[f.key].some((w) => (pass === "exact" ? x === w : x.includes(w) && w.length > 2)));
    if (i >= 0) { map[f.key] = i; taken.add(i); }
  }
  // 2. by values: digits-only 4-8 long = HSN/SAC; a GST rate; money; the longest words = the name.
  const col = (j) => sample.map((r) => String(r[j] ?? "").trim()).filter(Boolean);
  const all = (j, re) => { const v = col(j); return v.length > 0 && v.every((x) => re.test(x)); };
  for (let j = 0; j < header.length; j++) {
    if (taken.has(j)) continue;
    if (map.sac < 0 && all(j, /^\d{4,8}$/)) { map.sac = j; taken.add(j); continue; }
    if (map.gst < 0 && all(j, /^(0|0\.1|0\.25|1\.5|3|5|6|12|18|28|40)\s*%?$/)) { map.gst = j; taken.add(j); continue; }
    if (map.rate < 0 && all(j, /^(₹|rs\.?\s*)?[\d,]+(\.\d{1,2})?(\/-)?$/i)) { map.rate = j; taken.add(j); continue; }
  }
  if (map.name < 0) {
    let best = -1, len = 0;
    for (let j = 0; j < header.length; j++) {
      if (taken.has(j)) continue;
      const v = col(j), avg = v.reduce((s, x) => s + x.length, 0) / Math.max(1, v.length);
      if (v.length && /[a-z]/i.test(v.join("")) && avg > len) { best = j; len = avg; }
    }
    if (best >= 0) map.name = best;
  }
  return map;
}

/** Whether the first row is a header (its words name fields) or already data. */
export function hasHeader(table) {
  const first = (table[0] ?? []).map(norm);
  return first.some((x) => Object.values(WORDS).some((ws) => ws.includes(x))) || first.every((x) => x && !/^[\d.,₹%\s/-]+$/.test(x));
}

/** The rows to send: one object per row with the mapped fields (blank where not used). */
export function mapRows(body, map) {
  return body.map((r) => Object.fromEntries(FIELDS.map((f) => [f.key, map[f.key] >= 0 ? String(r[map[f.key]] ?? "").trim() : ""])));
}

/** Rupees for the preview: "450000" paise → "₹4,500". */
export function rupees(paise) {
  const n = Number(paise) / 100;
  if (!Number.isFinite(n)) return "";
  return `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n)}`;
}

/** "42 new · 6 updated · 2 skipped (no price)": the plan in one line. */
export function planLine(p) {
  const parts = [`${p.created} new`, `${p.updated} updated`];
  if (p.unchanged) parts.push(`${p.unchanged} already the same`);
  if (p.stockOff) parts.push("stock not set: turn on Inventory in Billing settings first");
  if (p.stockLeft?.length) parts.push(`stock not set for ${p.stockLeft.length} serial-numbered item${p.stockLeft.length === 1 ? "" : "s"} (count them on the item)`);
  if (p.skipped?.length) {
    const why = [...new Set(p.skipped.map((s) => s.why))];
    parts.push(`${p.skipped.length} skipped${why.length === 1 ? ` (${why[0].toLowerCase()})` : ""}`);
  }
  return parts.join(" · ");
}

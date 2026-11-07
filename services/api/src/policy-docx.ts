// R41: reading a policy's Word (.docx) file without trusting it. Used three ways:
//  * checkDocx refuses anything that is not a plain Word document (old .doc or password-protected files, macros,
//    templates, damaged or oversized archives, DTDs) before a byte is kept;
//  * docxMarkdown turns the file into the Markdown the policy reader already shows (headings, lists, tables, bold), so
//    employees read and acknowledge the text of the exact file HR saved;
//  * docxFeatures/compareFidelity describe what a Word round trip must keep — tables, headers and footers, lists, page
//    breaks and fonts — for the fidelity harness (docx-fidelity.ts).
// No dependency: a bounded ZIP reader on node:zlib and a small XML reader for WordprocessingML. Nothing is executed and
// no entity is expanded.
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export const DOCX_MAX_BYTES = 5 * 1024 * 1024;
const MAX_ENTRIES = 2000, MAX_ENTRY = 40 * 1024 * 1024, MAX_TOTAL = 80 * 1024 * 1024;

/** A refusal HR can act on (the API answers 400 with the message). */
export class DocxError extends Error {
  readonly statusCode = 400;
  readonly expose = true;
}

// ------------------------------------------------------------------------------------------------------------ ZIP
export type Zip = { names: string[]; has(name: string): boolean; text(name: string): string | null };

/** Opens a ZIP archive lazily. Refuses ZIP64, encryption, unknown compression and anything that inflates past limits. */
export function readZip(buf: Buffer): Zip {
  const damaged = () => new DocxError("This Word file is damaged or too large to open safely.");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw damaged();
  const count = buf.readUInt16LE(eocd + 10), size = buf.readUInt32LE(eocd + 12), start = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || start === 0xffffffff || count > MAX_ENTRIES || start + size > eocd) throw damaged();
  const entries = new Map<string, { method: number; compressed: number; size: number; offset: number; crc: number }>();
  let p = start;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw damaged();
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const compressed = buf.readUInt32LE(p + 20), length = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString("utf8");
    if (flags & 1) throw new DocxError("This Word file is password-protected. Save it without a password and try again.");
    if (![0, 8].includes(method) || length > MAX_ENTRY || entries.has(name)) throw damaged();
    entries.set(name, { method, compressed, size: length, offset, crc });
    p += 46 + nameLength + extra + comment;
  }
  let budget = MAX_TOTAL;
  const cache = new Map<string, string>();
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    text(name) {
      if (cache.has(name)) return cache.get(name)!;
      const e = entries.get(name);
      if (!e) return null;
      if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw damaged();
      const from = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
      if (from + e.compressed > buf.length) throw damaged();
      const raw = buf.subarray(from, from + e.compressed);
      if (e.size > budget) throw damaged();
      let out: Buffer;
      try { out = e.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) }); } catch { throw damaged(); }
      if (out.length !== e.size || crc32(out) !== e.crc) throw damaged();
      budget -= out.length;
      const text = out.toString("utf8").replace(/^﻿/, "");
      cache.set(name, text);
      return text;
    },
  };
}

/** A minimal ZIP writer (deflate), for synthetic fixtures and tests. */
export function writeZip(files: Record<string, string | Buffer>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"), packed = deflateRawSync(data), n = Buffer.from(name, "utf8");
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc32(data), 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(n.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc32(data), 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(offset, 42);
    local.push(head, n, packed); central.push(dir, n);
    offset += 30 + n.length + packed.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

// ------------------------------------------------------------------------------------------------------------ XML
export type El = { name: string; attrs: Record<string, string>; children: (El | string)[] };
const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
  if (e[0] !== "#") return ENTITY[e];
  const n = e[1] === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
});
const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/y;

/** Parses well-formed XML into elements. A DTD (and so any entity definition) or a malformed tag is refused. */
export function parseXml(text: string): El {
  if (/<!DOCTYPE/i.test(text)) throw new DocxError("This Word file contains a document type definition, which Pulse does not open.");
  const root: El = { name: "#root", attrs: {}, children: [] }, stack = [root];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const m = TOKEN.exec(text);
    if (!m) throw new DocxError("This Word file is damaged or too large to open safely.");
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.children.push(m[1]);
    else if (m[6] !== undefined) { if (stack.length > 1) top.children.push(decode(m[6])); }
    else if (m[3]) {
      if (m[2]) { if (top.name !== m[3] || stack.length === 1) throw new DocxError("This Word file is damaged or too large to open safely."); stack.pop(); continue; }
      const attrs: Record<string, string> = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3] ?? "");
      const el: El = { name: m[3], attrs, children: [] };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    }
  }
  if (stack.length !== 1) throw new DocxError("This Word file is damaged or too large to open safely.");
  const first = root.children.find((c): c is El => typeof c !== "string");
  if (!first) throw new DocxError("This Word file is damaged or too large to open safely.");
  return first;
}
const els = (e: El) => e.children.filter((c): c is El => typeof c !== "string");
export const kid = (e: El | undefined, name: string) => e ? els(e).find((c) => c.name === name) : undefined;
/** Every descendant with this name, in document order (not looking inside a match). */
export function all(e: El, name: string, out: El[] = []): El[] {
  for (const c of els(e)) { if (c.name === name) out.push(c); else all(c, name, out); }
  return out;
}
const val = (e: El | undefined, attr = "w:val") => e?.attrs[attr];
const on = (e: El | undefined) => !!e && !["0", "false", "off"].includes(e.attrs["w:val"] ?? "true");

// ------------------------------------------------------------------------------------------------------- the file
const MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
export type Docx = { zip: Zip; document: El; part: (path: string) => El | null; rels: Map<string, string>; styles: Map<string, { name: string; based?: string; el: El }>; numbering: (numId: string, ilvl: number) => string | null };

/** Opens a .docx, or refuses it with a sentence HR can act on. */
export function checkDocx(bytes: Buffer): Docx {
  if (bytes.length > DOCX_MAX_BYTES) throw new DocxError("A Word file can be at most 5 MB.");
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0xd0cf11e0) throw new DocxError("This is an old Word (.doc) or password-protected file. Save it as a Word document (.docx) without a password and try again.");
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw new DocxError("This is not a Word document (.docx).");
  const zip = readZip(bytes);
  if (zip.names.some((n) => /(^|\/)vbaProject\.bin$/i.test(n))) throw new DocxError("Word files with macros are not accepted. Save it as a Word document (.docx) and try again.");
  const types = zip.text("[Content_Types].xml"), docXml = zip.text("word/document.xml");
  if (!types || !docXml) throw new DocxError("This is not a Word document (.docx).");
  const overrides = all(parseXml(types), "Override");
  const main = overrides.find((o) => o.attrs.PartName === "/word/document.xml")?.attrs.ContentType;
  if (main !== MAIN) throw new DocxError(main?.includes("macroEnabled") ? "Word files with macros are not accepted. Save it as a Word document (.docx) and try again."
    : main?.includes("template") ? "This is a Word template. Save it as a Word document (.docx) and try again." : "This is not a Word document (.docx).");
  const parts = new Map<string, El | null>();
  const part = (path: string) => { if (!parts.has(path)) { const t = zip.text(path); parts.set(path, t === null ? null : parseXml(t)); } return parts.get(path)!; };
  const document = part("word/document.xml")!;
  if (!kid(document, "w:body")) throw new DocxError("This Word file has no body.");
  const rels = new Map<string, string>();
  for (const r of all(part("word/_rels/document.xml.rels") ?? { name: "", attrs: {}, children: [] }, "Relationship")) if (r.attrs.TargetMode !== "External") rels.set(r.attrs.Id, "word/" + r.attrs.Target.replace(/^\/?word\//, "").replace(/^\//, ""));
  const styles = new Map<string, { name: string; based?: string; el: El }>();
  const stylesXml = part("word/styles.xml");
  if (stylesXml) for (const s of all(stylesXml, "w:style")) styles.set(s.attrs["w:styleId"], { name: (val(kid(s, "w:name")) ?? "").toLowerCase(), based: val(kid(s, "w:basedOn")), el: s });
  const numberingXml = part("word/numbering.xml");
  const abstract = new Map<string, El>(), nums = new Map<string, string>();
  if (numberingXml) {
    for (const a of all(numberingXml, "w:abstractNum")) abstract.set(a.attrs["w:abstractNumId"], a);
    for (const n of all(numberingXml, "w:num")) nums.set(n.attrs["w:numId"], val(kid(n, "w:abstractNumId")) ?? "");
  }
  const numbering = (numId: string, ilvl: number) => {
    const a = abstract.get(nums.get(numId) ?? "");
    const lvl = a && els(a).find((l) => l.name === "w:lvl" && l.attrs["w:ilvl"] === String(ilvl));
    return lvl ? val(kid(lvl, "w:numFmt")) ?? "decimal" : null;
  };
  return { zip, document, part, rels, styles, numbering };
}

type Para = { style: string; list: { fmt: string; level: number } | null };
/** A paragraph's style name and list membership (directly or through its style). */
function paraInfo(d: Docx, p: El): Para {
  const pPr = kid(p, "w:pPr");
  const styleId = val(kid(pPr, "w:pStyle")) ?? "";
  let numPr = kid(pPr, "w:numPr");
  for (let id: string | undefined = styleId, depth = 0; !numPr && id && depth < 10; depth++) { const s = d.styles.get(id); numPr = kid(kid(s?.el, "w:pPr"), "w:numPr"); id = s?.based; }
  const numId = val(kid(numPr, "w:numId")), level = Number(val(kid(numPr, "w:ilvl")) ?? 0);
  const fmt = numId && numId !== "0" ? d.numbering(numId, level) : null;
  return { style: d.styles.get(styleId)?.name ?? styleId.toLowerCase(), list: fmt ? { fmt, level } : null };
}

/** Text of runs, in order: tracked deletions are skipped, tabs and line breaks become spaces. */
function runs(e: El, out: { text: string; bold: boolean }[] = []): { text: string; bold: boolean }[] {
  for (const c of els(e)) {
    if (["w:del", "w:pPr", "w:rPr", "w:instrText", "w:delText", "mc:Fallback"].includes(c.name)) continue;
    if (c.name === "w:r") {
      const b = on(kid(kid(c, "w:rPr"), "w:b"));
      for (const t of els(c)) {
        if (t.name === "w:t") out.push({ text: t.children.filter((x): x is string => typeof x === "string").join(""), bold: b });
        else if (t.name === "w:tab" || (t.name === "w:br" && t.attrs["w:type"] !== "page")) out.push({ text: " ", bold: b });
        else if (t.name === "w:noBreakHyphen") out.push({ text: "-", bold: b });
      }
    } else runs(c, out);
  }
  return out;
}
const plainText = (e: El) => runs(e).map((r) => r.text).join("").replace(/\s+/g, " ").trim();

// ------------------------------------------------------------------------------------------------- reader text
const escape = (s: string) => s.replace(/([\\`*_[\]|<>])/g, "\\$1");
const lineStart = (s: string) => s.replace(/^(#{1,6}\s|[-+*]\s|>)/, "\\$1").replace(/^(\d+)([.)]\s)/, "$1\\$2");
function inline(p: El): string {
  // Bold runs merge (spaces between them too), and a bold span keeps its outer spaces outside the ** markers.
  const segs: { text: string; bold: boolean }[] = [];
  for (const r of runs(p)) {
    if (!r.text) continue;
    const last = segs.at(-1), bold = r.bold && r.text.trim() !== "";
    if (last && (last.bold === bold || !r.text.trim())) last.text += r.text; else segs.push({ text: r.text, bold });
  }
  return segs.map((s) => {
    const t = escape(s.text), m = t.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
    return s.bold && m[2] ? `${m[1]}**${m[2]}**${m[3]}` : t;
  }).join("").replace(/\s+/g, " ").trim();
}

/** The Markdown the policy reader shows for a Word file: headings, paragraphs, (nested) lists, tables and bold. */
export function docxMarkdown(d: Docx): string {
  const blocks: string[] = [];
  let list: string[] | null = null, widths: number[] = [], top = "";
  const endList = () => { if (list) { blocks.push(list.join("\n")); list = null; widths = []; } };
  const walk = (parent: El) => {
    for (const c of els(parent)) {
      if (c.name === "w:sdt") { const content = kid(c, "w:sdtContent"); if (content) walk(content); continue; }
      if (c.name === "w:tbl") { endList(); const t = table(c); if (t) blocks.push(t); continue; }
      if (c.name !== "w:p") continue;
      const info = paraInfo(d, c), text = inline(c);
      if (!text) continue;
      const heading = info.style === "title" ? 1 : /^heading [1-9]$/.test(info.style) ? Math.min(4, Number(info.style.slice(8)) + 1) : 0;
      if (heading) { endList(); blocks.push(`${"#".repeat(heading)} ${text}`); continue; }
      if (info.list) {
        const marker = info.list.fmt === "bullet" || info.list.fmt === "none" ? "- " : "1. ";
        if (list && info.list.level === 0 && marker !== top) endList();
        if (!list || info.list.level === 0) top = marker;
        const level = Math.min(info.list.level, list ? widths.length : 0), indent = level ? widths[level - 1] : 0;
        widths = widths.slice(0, level); widths[level] = indent + marker.length;
        (list ??= []).push(" ".repeat(indent) + marker + text);
        continue;
      }
      endList();
      blocks.push(lineStart(text));
    }
  };
  const table = (t: El) => {
    const rows = els(t).filter((r) => r.name === "w:tr").map((r) => els(r).filter((c) => c.name === "w:tc").flatMap((c) => {
      const span = Number(val(kid(kid(c, "w:tcPr"), "w:gridSpan")) ?? 1);
      const continued = kid(kid(c, "w:tcPr"), "w:vMerge") && val(kid(kid(c, "w:tcPr"), "w:vMerge")) !== "restart";
      const text = continued ? "" : all(c, "w:p").map(inline).filter(Boolean).join(" ");
      return [text, ...Array(Math.max(0, Math.min(span, 20) - 1)).fill("")];
    }));
    const cols = Math.max(0, ...rows.map((r) => r.length));
    if (!cols || !rows.some((r) => r.some(Boolean))) return null;
    const line = (r: string[]) => "| " + Array.from({ length: cols }, (_, i) => r[i] || " ").join(" | ") + " |";
    return [line(rows[0]), "| " + Array(cols).fill("---").join(" | ") + " |", ...rows.slice(1).map(line)].join("\n");
  };
  walk(kid(d.document, "w:body")!);
  endList();
  const out = blocks.join("\n\n").trim();
  if (out.length < 10) throw new DocxError("This Word file has no text to show.");
  if (out.length > 30000) throw new DocxError("This Word file's text is longer than a policy can be (30,000 characters).");
  return out;
}

// ------------------------------------------------------------------------------------------- fidelity features
export type Features = {
  application: string | null;
  paragraphs: string[];
  tables: { rows: number[]; merged: number }[];
  headers: string[];
  footers: string[];
  pageNumbers: number;
  lists: string[];
  breaks: { page: number; before: number; sections: number };
  fonts: { body: string | null; headings: string | null; used: string[]; sizes: number[] };
};

/** What a round trip must keep, read from one file. */
export function docxFeatures(d: Docx): Features {
  const body = kid(d.document, "w:body")!;
  const app = d.part("docProps/app.xml");
  const application = app ? [kid(app, "Application"), kid(app, "AppVersion")].map((e) => e ? plainChildren(e) : "").filter(Boolean).join(" ") || null : null;
  const paragraphs = all(body, "w:p").map(plainText).filter(Boolean);
  const tables = all(body, "w:tbl").map((t) => {
    const rows = els(t).filter((r) => r.name === "w:tr").map((r) => els(r).filter((c) => c.name === "w:tc").reduce((n, c) => n + Number(val(kid(kid(c, "w:tcPr"), "w:gridSpan")) ?? 1), 0));
    const merged = all(t, "w:gridSpan").filter((g) => Number(val(g)) > 1).length + all(t, "w:vMerge").length;
    return { rows, merged };
  });
  const sections = all(body, "w:sectPr");
  const headers: string[] = [], footers: string[] = [];
  let pageNumbers = 0;
  const fieldsIn = (e: El) => all(e, "w:fldSimple").filter((f) => /\bPAGE\b/.test(f.attrs["w:instr"] ?? "")).length + all(e, "w:instrText").filter((t) => /\bPAGE\b/.test(plainChildren(t))).length;
  sections.forEach((s, i) => {
    for (const [tag, out] of [["w:headerReference", headers], ["w:footerReference", footers]] as const) {
      for (const ref of els(s).filter((c) => c.name === tag)) {
        const part = d.part(d.rels.get(ref.attrs["r:id"]) ?? "");
        if (!part) continue;
        out.push(`section ${i + 1} ${ref.attrs["w:type"] ?? "default"}: ${plainText(part)}`);
        pageNumbers += fieldsIn(part);
      }
    }
  });
  const lists = all(body, "w:p").map((p) => paraInfo(d, p).list).filter((l): l is { fmt: string; level: number } => !!l).map((l) => `${l.fmt === "none" ? "bullet" : l.fmt}@${l.level}`);
  const page = all(body, "w:br").filter((b) => b.attrs["w:type"] === "page").length;
  const before = all(body, "w:pageBreakBefore").filter(on).length;
  // Fonts: the theme's body/heading faces, the document defaults and every face or size a used style or run names.
  const theme = d.part("word/theme/theme1.xml");
  const face = (tag: string) => { const f = theme && all(theme, tag)[0]; const latin = f && kid(f, "a:latin"); return latin?.attrs.typeface || null; };
  const minor = face("a:minorFont"), major = face("a:majorFont");
  const resolve = (r: El | undefined) => { if (!r) return null; const a = r.attrs; return a["w:ascii"] ?? a["w:hAnsi"] ?? (a["w:asciiTheme"] ? (a["w:asciiTheme"].startsWith("major") ? major : minor) : null); };
  const stylesXml = d.part("word/styles.xml");
  const defaults = stylesXml ? kid(kid(kid(stylesXml, "w:docDefaults"), "w:rPrDefault"), "w:rPr") : undefined;
  const usedStyles = new Set(all(body, "w:pStyle").concat(all(body, "w:rStyle")).map((s) => val(s) ?? ""));
  const used = new Set<string>(), sizes = new Set<number>();
  const take = (rPr: El | undefined) => { const f = resolve(kid(rPr, "w:rFonts")); if (f) used.add(f); const sz = Number(val(kid(rPr, "w:sz"))); if (sz) sizes.add(sz / 2); };
  take(defaults);
  for (const id of usedStyles) take(kid(d.styles.get(id)?.el, "w:rPr"));
  for (const r of all(body, "w:rPr")) take(r);
  return {
    application, paragraphs, tables, headers, footers, pageNumbers, lists, breaks: { page, before, sections: sections.length },
    fonts: { body: resolve(kid(defaults, "w:rFonts")) ?? minor, headings: major, used: [...used].sort(), sizes: [...sizes].sort((a, b) => a - b) },
  };
}
function plainChildren(e: El): string { return e.children.map((c) => typeof c === "string" ? c : plainChildren(c)).join("").trim(); }

export type Category = "text" | "tables" | "headersFooters" | "lists" | "pageBreaks" | "fonts";
export type Comparison = Record<Category, { ok: boolean; differences: string[] }>;
const short = (s: string) => (s.length > 80 ? s.slice(0, 77) + "…" : s);

/** Every way the second file differs from the first in what a policy's layout depends on. */
export function compareFidelity(a: Features, b: Features): Comparison {
  const result = {} as Comparison;
  const add = (cat: Category, diffs: string[]) => { result[cat] = { ok: !diffs.length, differences: diffs }; };
  const seq = (x: string[], y: string[], what: string) => {
    const out: string[] = [];
    if (x.length !== y.length) out.push(`${what}: ${x.length} before, ${y.length} after`);
    const i = x.findIndex((v, k) => v !== y[k]);
    if (i >= 0 && i < Math.min(x.length, y.length)) out.push(`${what} ${i + 1} changed: “${short(x[i])}” → “${short(y[i])}”`);
    return out;
  };
  add("text", seq(a.paragraphs, b.paragraphs, "paragraph"));
  const tables: string[] = [];
  if (a.tables.length !== b.tables.length) tables.push(`tables: ${a.tables.length} before, ${b.tables.length} after`);
  a.tables.forEach((t, i) => {
    const u = b.tables[i]; if (!u) return;
    if (t.rows.length !== u.rows.length) tables.push(`table ${i + 1}: ${t.rows.length} rows before, ${u.rows.length} after`);
    else if (t.rows.some((n, k) => n !== u.rows[k])) tables.push(`table ${i + 1}: columns per row ${t.rows.join("/")} before, ${u.rows.join("/")} after`);
    if (t.merged !== u.merged) tables.push(`table ${i + 1}: ${t.merged} merged cells before, ${u.merged} after`);
  });
  add("tables", tables);
  add("headersFooters", [...seq(a.headers, b.headers, "header"), ...seq(a.footers, b.footers, "footer"),
    ...(a.pageNumbers !== b.pageNumbers ? [`page-number fields: ${a.pageNumbers} before, ${b.pageNumbers} after`] : [])]);
  add("lists", seq(a.lists, b.lists, "list item (format@level)"));
  const breaks: string[] = [];
  if (a.breaks.page + a.breaks.before !== b.breaks.page + b.breaks.before) breaks.push(`page breaks: ${a.breaks.page} explicit + ${a.breaks.before} before-paragraph before, ${b.breaks.page} + ${b.breaks.before} after`);
  if (a.breaks.sections !== b.breaks.sections) breaks.push(`sections: ${a.breaks.sections} before, ${b.breaks.sections} after`);
  add("pageBreaks", breaks);
  const fonts: string[] = [];
  if (a.fonts.body !== b.fonts.body) fonts.push(`body font: ${a.fonts.body ?? "none"} before, ${b.fonts.body ?? "none"} after`);
  if (a.fonts.headings !== b.fonts.headings) fonts.push(`heading font: ${a.fonts.headings ?? "none"} before, ${b.fonts.headings ?? "none"} after`);
  const lost = a.fonts.used.filter((f) => !b.fonts.used.includes(f)), gained = b.fonts.used.filter((f) => !a.fonts.used.includes(f));
  if (lost.length || gained.length) fonts.push(`fonts used: lost ${lost.join(", ") || "none"}; gained ${gained.join(", ") || "none"}`);
  if (a.fonts.sizes.join() !== b.fonts.sizes.join()) fonts.push(`font sizes (pt): ${a.fonts.sizes.join(", ")} before, ${b.fonts.sizes.join(", ")} after`);
  add("fonts", fonts);
  return result;
}

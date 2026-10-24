// Policy documents are written in Markdown. This reads the part of it a policy needs — headings, paragraphs, bulleted
// and numbered lists (nested), tables, quotes, rules, code, bold, italics and links — into plain data that the reader
// renders as React elements. No HTML is ever passed through: raw tags stay text, and links keep only http(s), mailto
// and in-app addresses. "(confirm)" markers become their own node so the reader can flag them and Publish can list them.

const CONFIRM = /\(confirm\b[^)]*\)/gi;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^ {0,3}(```|~~~)/;
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** The leading spaces of a line, a tab counting as four. */
const indentOf = (line) => { let n = 0; for (const ch of line) { if (ch === " ") n++; else if (ch === "\t") n += 4; else break; } return n; };
const blank = (line) => !line.trim();
const dedent = (line, n) => { let i = 0, w = 0; while (i < line.length && w < n && (line[i] === " " || line[i] === "\t")) { w += line[i] === "\t" ? 4 : 1; i++; } return line.slice(i); };
/** A list marker: "- ", "* ", "+ " or "1. " / "1) ", with where the item's text starts (`width`). */
const marker = (line) => {
  const m = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/.exec(line);
  if (!m) return null;
  const ordered = /\d/.test(m[2]), wide = m[3].length > 4;
  return { indent: m[1].length, ordered, width: m[1].length + m[2].length + (wide || !m[3].length ? 1 : m[3].length), text: (wide ? m[3].slice(1) : "") + m[4], start: ordered ? Number.parseInt(m[2], 10) : 1 };
};
/** A line that starts a block of its own, so it never continues a paragraph. */
const starts = (line) => HEADING.test(line) || RULE.test(line) || FENCE.test(line) || /^ {0,3}>/.test(line) || !!marker(line);

const cells = (row) => { let s = row.trim(); if (s.startsWith("|")) s = s.slice(1); if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out = []; let cur = ""; for (let i = 0; i < s.length; i++) { if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; } else if (s[i] === "|") { out.push(cur.trim()); cur = ""; } else cur += s[i]; }
  out.push(cur.trim()); return out; };

/** Inline Markdown → nodes: text, strong, em, code, link, confirm, break. */
export function parseInline(src) {
  const out = [];
  const text = (t) => { if (!t) return; const last = out.at(-1); if (last?.type === "text") last.text += t; else out.push({ type: "text", text: t }); };
  let i = 0;
  while (i < src.length) {
    const ch = src[i], rest = src.slice(i);
    if (ch === "\\" && i + 1 < src.length && /[!-/:-@[-`{-~]/.test(src[i + 1])) { text(src[i + 1]); i += 2; continue; }
    if (ch === "\\" && src[i + 1] === "\n") { out.push({ type: "break" }); i += 2; continue; }
    if (ch === " " && /^ {2,}\n/.test(rest)) { out.push({ type: "break" }); i += rest.match(/^ {2,}\n/)[0].length; continue; }
    if (ch === "\n") { text(" "); i++; continue; }
    if (ch === "`") { const run = rest.match(/^`+/)[0], end = src.indexOf(run, i + run.length);
      if (end > 0) { out.push({ type: "code", text: src.slice(i + run.length, end).replace(/\n/g, " ").trim() }); i = end + run.length; continue; } }
    if ((ch === "*" || ch === "_") && src[i + 1] === ch) {
      const end = closing(src, i + 2, ch + ch);
      if (end > 0 && (ch === "*" || !/\w/.test(src[i - 1] ?? ""))) { out.push({ type: "strong", children: parseInline(src.slice(i + 2, end)) }); i = end + 2; continue; }
    }
    if ((ch === "*" || ch === "_") && src[i + 1] && !/\s/.test(src[i + 1]) && (ch === "*" || !/\w/.test(src[i - 1] ?? ""))) {
      const end = closing(src, i + 1, ch);
      if (end > 0) { out.push({ type: "em", children: parseInline(src.slice(i + 1, end)) }); i = end + 1; continue; }
    }
    if (ch === "[") {
      const m = rest.match(/^\[((?:\\.|[^\]\\])*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/);
      if (m) { const href = safeHref(m[2]); if (href) out.push({ type: "link", href, children: parseInline(m[1]) }); else out.push(...parseInline(m[1])); i += m[0].length; continue; }
    }
    if (ch === "<") { const m = rest.match(/^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i); if (m) { out.push({ type: "link", href: m[1], children: [{ type: "text", text: m[1].replace(/^mailto:/i, "") }] }); i += m[0].length; continue; } }
    text(ch); i++;
  }
  return out.flatMap((node) => node.type === "text" ? confirmSplit(node.text) : [node]);
}
/** The closing delimiter for an emphasis run, skipping code spans; -1 when there is none. */
function closing(src, from, delim) {
  for (let j = from; j < src.length; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] === "`") { const run = src.slice(j).match(/^`+/)[0], end = src.indexOf(run, j + run.length); if (end > 0) { j = end + run.length - 1; continue; } }
    if (src.startsWith(delim, j) && j > from && !/\s/.test(src[j - 1])) {
      if (delim.length === 1 && src[j + 1] === delim) { j++; continue; }
      if (delim === "_" && /\w/.test(src[j + 1] ?? "")) continue;
      return j;
    }
  }
  return -1;
}
function confirmSplit(text) {
  const out = []; let last = 0;
  for (const m of text.matchAll(CONFIRM)) { if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) }); out.push({ type: "confirm", text: m[0] }); last = m.index + m[0].length; }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}
/** Only web, mail and in-app addresses become links. */
export function safeHref(raw) {
  const href = String(raw ?? "").trim();
  if (/^(https?:\/\/|mailto:)/i.test(href)) return href;
  if (/^(\/(?!\/)|#)/.test(href)) return href;
  return null;
}

/** Block Markdown → nodes: heading, paragraph, list, table, quote, rule, code. */
function parseBlocks(lines) {
  const blocks = []; let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    const fence = FENCE.exec(line);
    if (fence) { const body = []; i++; while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]); i++; blocks.push({ type: "code", text: body.join("\n") }); continue; }
    const h = HEADING.exec(line);
    if (h) { blocks.push({ type: "heading", level: h[1].length, children: parseInline(h[2] ?? "") }); i++; continue; }
    if (RULE.test(line)) { blocks.push({ type: "rule" }); i++; continue; }
    if (/^ {0,3}>/.test(line)) { const body = []; while (i < lines.length && !blank(lines[i]) && (/^ {0,3}>/.test(lines[i]) || !starts(lines[i]))) body.push(lines[i++].replace(/^ {0,3}> ?/, "")); blocks.push({ type: "quote", children: parseBlocks(body) }); continue; }
    if (line.includes("|") && i + 1 < lines.length && DELIMITER.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = cells(line), align = cells(lines[i + 1]).map((c) => c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null);
      const rows = []; i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i].includes("|")) { const r = cells(lines[i++]); rows.push(head.map((_, k) => parseInline(r[k] ?? ""))); }
      blocks.push({ type: "table", align: head.map((_, k) => align[k] ?? null), head: head.map(parseInline), rows }); continue;
    }
    const first = marker(line);
    if (first) { const [list, next] = parseList(lines, i, first); blocks.push(list); i = next; continue; }
    const para = [line.trim()]; i++;
    while (i < lines.length && !blank(lines[i]) && !starts(lines[i]) && !(lines[i].includes("|") && DELIMITER.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-"))) para.push(lines[i++].trim());
    // Right under the document title, the first line is a byline ("Version 1 · Applies to …") and stands on its own.
    const prev = blocks.at(-1);
    if (prev?.type === "heading" && prev.level === 1 && para.length > 1) blocks.push({ type: "paragraph", children: parseInline(para.shift()) });
    blocks.push({ type: "paragraph", children: parseInline(para.join("\n").replace(/\\$/, "")) });
  }
  return blocks;
}
/** One list: items with the first item's kind and indent; deeper lines belong to the item above them. */
function parseList(lines, i, first) {
  const items = []; let loose = false;
  while (i < lines.length) {
    const m = marker(lines[i]);
    if (!m || m.ordered !== first.ordered || m.indent !== first.indent) break;
    const body = [m.text]; i++;
    let gap = false;
    while (i < lines.length) {
      const line = lines[i];
      if (blank(line)) { const next = lines.slice(i + 1).find((l) => !blank(l)); if (next !== undefined && indentOf(next) >= m.width) { body.push(""); gap = true; i++; continue; } break; }
      const inner = marker(line);
      if (indentOf(line) >= m.width) { body.push(dedent(line, m.width)); i++; continue; }
      if (inner && inner.indent > m.indent) { body.push(dedent(line, Math.min(inner.indent, m.width))); i++; continue; }
      if (!gap && !starts(line) && body.at(-1) !== "") { body.push(line.trim()); i++; continue; } // a lazy continuation of the item's text
      break;
    }
    if (gap) loose = true;
    items.push({ children: parseBlocks(body) });
    if (i < lines.length && blank(lines[i])) { const next = lines.slice(i).findIndex((l) => !blank(l)); const m2 = next >= 0 ? marker(lines[i + next]) : null; if (m2 && m2.ordered === first.ordered && m2.indent === first.indent) { loose = true; i += next; } }
  }
  return [{ type: "list", ordered: first.ordered, start: first.start, loose, items }, i];
}

/** Plain text of inline nodes, for headings, anchors and the confirmation list. */
export function plain(nodes) {
  return (nodes ?? []).map((n) => n.type === "text" || n.type === "code" || n.type === "confirm" ? n.text : n.type === "break" ? " " : plain(n.children)).join("").replace(/\s+/g, " ").trim();
}
const slug = (text) => text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "section";
const hasConfirm = (nodes) => (nodes ?? []).some((n) => n.type === "confirm" || hasConfirm(n.children));
/** "Items marked (confirm) need…" explains the marker; it is not itself a question for HR. */
const explains = (text) => /\bmarked\s+\(confirm\)/i.test(text);

/**
 * A whole document: its blocks (headings carry a unique `id`), the outline of level 1–3 headings for the contents,
 * and every unit of text that carries a "(confirm)" marker with the section it sits in.
 */
export function parseMarkdown(source) {
  const blocks = parseBlocks(String(source ?? "").replace(/\r\n?/g, "\n").split("\n"));
  const outline = [], confirm = [], used = new Map();
  let section = null;
  const visit = (list) => {
    for (const b of list) {
      if (b.type === "heading") {
        const text = plain(b.children), base = slug(text), n = used.get(base) ?? 0; used.set(base, n + 1);
        b.id = n ? `${base}-${n + 1}` : base;
        if (b.level <= 3) outline.push({ id: b.id, level: b.level, text });
        if (b.level >= 2 || !section) section = { id: b.id, text };
        if (hasConfirm(b.children)) confirm.push({ section: section.text, sectionId: section.id, text });
      } else if (b.type === "paragraph") { if (hasConfirm(b.children) && !explains(plain(b.children))) confirm.push({ section: section?.text ?? null, sectionId: section?.id ?? null, text: plain(b.children) }); }
      else if (b.type === "list") for (const item of b.items) { const own = item.children.filter((c) => c.type === "paragraph"); if (own.some((p) => hasConfirm(p.children))) confirm.push({ section: section?.text ?? null, sectionId: section?.id ?? null, text: own.map((p) => plain(p.children)).join(" ") }); visit(item.children.filter((c) => c.type !== "paragraph")); }
      else if (b.type === "table") for (const row of b.rows) { if (row.some(hasConfirm)) confirm.push({ section: section?.text ?? null, sectionId: section?.id ?? null, text: row.map(plain).filter(Boolean).join(" — ") }); }
      else if (b.type === "quote") visit(b.children);
    }
  };
  visit(blocks);
  return { blocks, outline, confirm };
}

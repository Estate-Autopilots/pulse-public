// DOCS-GDOCS (owner, 15 Nov 2026: "the document editor has a lot of bugs and artifacts … no raw Markdown ever shown"):
// a doc imported from Google Docs, Word or an AI's Markdown often arrives with Markdown that was never turned into
// formatting. Seen in the real "Vitals OS Offer" import (100 KB, 22 tables):
//  - "#### What buyers expect" inside 54 table cells (Google Docs' Markdown keeps a cell's heading style as "####");
//  - "**$100M Scaling Roadmap****:**": two bold runs side by side ("****") that Markdown cannot read;
//  - one line per paragraph with no blank line between (Google Docs and Word write it so): Markdown joins the lines
//    into one run-on paragraph, and a line after a list item is swallowed into that item.
// repairDocHtml() fixes the stored HTML before the editor reads it, so docs already saved look right; the API's
// Markdown import (services/api/src/doc-markdown.ts) fixes the cause for new imports. Pure (no DOM), so it runs in the
// browser, on the server and in node tests. The input is HTML the API already sanitised (quoted attributes, known
// tags), which is what makes a small tolerant tree safe here; anything it does not understand is written back as it was.

const VOID = new Set(["br", "hr", "img", "input", "col", "wbr"]);
const INLINE = new Set(["strong", "b", "em", "i", "u", "s", "mark", "code", "a", "span", "sub", "sup", "label"]);

/** @typedef {{ t: "text", v: string } | { t: "el", tag: string, attrs: string, kids: Node[] }} Node */

/** HTML → a list of nodes. Unknown or broken markup is kept as text, never dropped. */
export function parseHtml(html) {
  const root = { t: "el", tag: "#root", attrs: "", kids: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|[^<]+|</g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[0].startsWith("<!--")) continue;
    if (!m[2]) { top.kids.push({ t: "text", v: m[0] }); continue; }
    const tag = m[2].toLowerCase();
    if (m[1]) { // closing tag: close up to the matching open one, or ignore a stray one
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const el = { t: "el", tag, attrs: m[3] ?? "", kids: [] };
    top.kids.push(el);
    if (!VOID.has(tag) && !m[4]) stack.push(el);
  }
  return root.kids;
}

/** Nodes → HTML, attributes exactly as they came. */
export function writeHtml(nodes) {
  return nodes.map((n) => n.t === "text" ? n.v : VOID.has(n.tag) ? `<${n.tag}${n.attrs}>` : `<${n.tag}${n.attrs}>${writeHtml(n.kids)}</${n.tag}>`).join("");
}

const el = (tag, kids, attrs = "") => ({ t: "el", tag, attrs, kids });
const text = (v) => ({ t: "text", v });
const textOf = (nodes) => nodes.map((n) => n.t === "text" ? n.v : textOf(n.kids)).join("");
const isBlank = (nodes) => !nodes.some((n) => n.t === "el" ? n.tag === "img" || n.tag === "br" || !isBlank(n.kids) : n.v.trim());

/** Split a run of inline nodes at the line breaks of its own text (a break inside bold or a link is only a space). */
function splitLines(nodes) {
  const lines = [[]];
  for (const n of nodes) {
    if (n.t === "text" && n.v.includes("\n")) {
      n.v.split("\n").forEach((part, i) => { if (i) lines.push([]); if (part) lines[lines.length - 1].push(text(part)); });
    } else if (n.t === "el" && INLINE.has(n.tag)) {
      lines[lines.length - 1].push(collapseBreaks(n));
    } else lines[lines.length - 1].push(n);
  }
  return lines.map(trimLine).filter((l) => !isBlank(l));
}
function collapseBreaks(n) { return n.t === "text" ? text(n.v.replace(/\s*\n\s*/g, " ")) : el(n.tag, n.kids.map(collapseBreaks), n.attrs); }
function trimLine(line) {
  const out = line.slice();
  if (out[0]?.t === "text") out[0] = text(out[0].v.replace(/^[ \t]+/, ""));
  const k = out.length - 1;
  if (out[k]?.t === "text") out[k] = text(out[k].v.replace(/[ \t]+$/, ""));
  return out.filter((n) => n.t !== "text" || n.v);
}

/** Does this doc keep one paragraph per line (Google Docs, Word, chat answers), or wrap its lines at ~80 characters
 *  (hand-written Markdown)? Wrapped lines are all about the same length; one-per-line ones are not. */
function writtenOnePerLine(nodes) {
  const lens = [];
  const walk = (list) => { for (const n of list) {
    if (n.t !== "el" || n.tag === "pre" || n.tag === "code") continue;
    if (n.tag === "p" || n.tag === "li") {
      const own = n.kids.filter((k) => k.t === "text" || INLINE.has(k.tag));
      const lines = splitLines(own.map((k) => k.t === "text" ? text(k.v) : k)).map((l) => textOf(l).trim().length);
      if (lines.length > 1) lens.push(...lines.slice(0, -1));
    }
    walk(n.kids);
  } };
  walk(nodes);
  if (!lens.length) return false;
  const wrapped = lens.filter((x) => x >= 45 && x <= 100).length;
  return wrapped < lens.length * 0.8;
}

const BOLD_RE = /\*\*(?=\S)([^*\n]*?[^*\s\n])\*\*/g;
/** "**words**" left as text becomes bold; "****" (two bold runs side by side) is joined first. */
function literalBold(nodes, inCode = false) {
  const out = [];
  for (const n of nodes) {
    if (n.t === "el") {
      const code = inCode || n.tag === "code" || n.tag === "pre";
      out.push(el(n.tag, literalBold(n.kids, code), n.attrs));
      continue;
    }
    if (inCode || !n.v.includes("**")) { out.push(n); continue; }
    // "****" joins two bold runs: with a space before a word, without one before a mark (as the API's doc-markdown.ts).
    const v = n.v.replace(/\*{4}(?=\S)/g, (_m, at, str) => /[\p{L}\p{N}$₹€£]/u.test(str[at + 4] ?? "") ? "** **" : "");
    let last = 0, m;
    BOLD_RE.lastIndex = 0;
    while ((m = BOLD_RE.exec(v))) {
      if (m.index > last) out.push(text(v.slice(last, m.index)));
      const prev = out[out.length - 1];
      // "<strong>Hormozi’s</strong>**$100M Scaling Roadmap**": one bold run, with the space the export lost.
      if (m.index === 0 && prev?.t === "el" && (prev.tag === "strong" || prev.tag === "b") && !/\s$/.test(textOf(prev.kids))) prev.kids.push(text(` ${m[1]}`));
      else out.push(el("strong", [text(m[1])]));
      last = m.index + m[0].length;
    }
    if (last < v.length) out.push(text(v.slice(last)));
  }
  return out;
}

const HEAD_RE = /^\s*(#{1,6})\s+/;
/** A cell that starts with "#### " shows its words in bold (a heading cannot live in a table cell). */
function cellHeading(cell) {
  const kids = cell.kids.length === 1 && cell.kids[0].t === "el" && cell.kids[0].tag === "p" ? cell.kids[0].kids : cell.kids;
  const first = kids[0];
  if (first?.t !== "text" || !HEAD_RE.test(first.v)) return;
  first.v = first.v.replace(HEAD_RE, "");
  if (!first.v) kids.shift();
  const all = kids.splice(0, kids.length);
  if (!all.length) return;
  kids.push(all.length === 1 && all[0].t === "el" && (all[0].tag === "strong" || all[0].tag === "b") ? all[0] : el("strong", all));
}

/** A paragraph that reads "## Words" is a heading; "- words" or "• words" lines are a list. */
function lineBlocks(lines, onePerLine) {
  const out = [];
  for (const line of lines) {
    const first = line[0];
    const head = first?.t === "text" ? first.v.match(HEAD_RE) : null;
    if (head) {
      const rest = [text(first.v.replace(HEAD_RE, "")), ...line.slice(1)].filter((n) => n.t !== "text" || n.v);
      out.push(el(`h${Math.min(4, Math.max(2, head[1].length))}`, rest));
      continue;
    }
    const bullet = first?.t === "text" && onePerLine ? first.v.match(/^\s*([-*•●▪◦])\s+/) : null;
    if (bullet) {
      const item = el("li", [text(first.v.slice(bullet[0].length)), ...line.slice(1)].filter((n) => n.t !== "text" || n.v));
      const prev = out[out.length - 1];
      if (prev?.tag === "ul" && prev.fromLines) prev.kids.push(item);
      else out.push(Object.assign(el("ul", [item]), { fromLines: true }));
      continue;
    }
    out.push(el("p", line));
  }
  return out;
}

/** A list item that swallowed the lines after it: the first line stays the item, the rest come after the list as
 *  paragraphs, and the items after them start a new list (numbering carried on). */
function splitList(list, onePerLine) {
  const out = [];
  let cur = el(list.tag, [], list.attrs);
  let n = Number((list.attrs.match(/\bstart="(\d+)"/) ?? [])[1] ?? 1);
  const flush = () => { if (cur.kids.length) out.push(cur); };
  for (const item of list.kids) {
    if (item.t !== "el" || item.tag !== "li") { if (item.t === "el" || item.v.trim()) cur.kids.push(item); continue; }
    const cut = item.kids.findIndex((k) => k.t === "el" && !INLINE.has(k.tag) && k.tag !== "br");
    const own = cut < 0 ? item.kids : item.kids.slice(0, cut), rest = cut < 0 ? [] : item.kids.slice(cut);
    const lines = onePerLine && own.some((k) => k.t === "text" && k.v.includes("\n")) ? splitLines(own) : null;
    if (!lines || lines.length < 2 || rest.length) { cur.kids.push(item); n++; continue; }
    cur.kids.push(el("li", lines[0], item.attrs)); n++;
    flush();
    out.push(...lineBlocks(lines.slice(1), onePerLine));
    cur = el(list.tag, [], list.tag === "ol" ? `${list.attrs.replace(/\s*\bstart="\d+"/, "")} start="${n}"` : list.attrs);
  }
  flush();
  return out;
}

function repairBlocks(nodes, onePerLine) {
  const out = [];
  for (const n of nodes) {
    if (n.t !== "el") { out.push(n); continue; }
    if (n.tag === "pre" || n.tag === "code") { out.push(n); continue; }
    if (n.tag === "td" || n.tag === "th") { cellHeading(n); n.kids = repairBlocks(n.kids, onePerLine); out.push(n); continue; }
    if (n.tag === "p") {
      const split = onePerLine ? splitLines(n.kids) : [];
      const lines = split.length > 1 ? split : [n.kids];
      const blocks = lineBlocks(lines, onePerLine && lines.length > 1);
      // keep the paragraph's own attributes (alignment) on the first line
      if (blocks[0]?.tag === "p") blocks[0].attrs = n.attrs;
      out.push(...blocks);
      continue;
    }
    n.kids = repairBlocks(n.kids, onePerLine);
    if (n.tag === "ul" || n.tag === "ol") { out.push(...splitList(n, onePerLine)); continue; }
    out.push(n);
  }
  return out;
}

/** The stored HTML with every leftover piece of Markdown turned into formatting. Clean HTML comes back unchanged. */
export function repairDocHtml(html) {
  const src = String(html ?? "");
  if (!src || !/\*\*|#\s|\n/.test(src)) return src;
  const nodes = parseHtml(src);
  const onePerLine = writtenOnePerLine(nodes);
  const fixed = writeHtml(repairBlocks(literalBold(nodes), onePerLine));
  return fixed === src ? src : fixed;
}

/** What is still left (for tests and the walk): raw Markdown a reader would see. */
export function markdownLeftovers(html) {
  const found = [];
  const walk = (nodes, code) => { for (const n of nodes) {
    if (n.t === "el") { walk(n.kids, code || n.tag === "pre" || n.tag === "code"); continue; }
    if (code) continue;
    if (/\*\*\S/.test(n.v)) found.push(`bold: ${n.v.trim().slice(0, 60)}`);
    if (/(^|\n)\s*#{1,6}\s/.test(n.v)) found.push(`heading: ${n.v.trim().slice(0, 60)}`);
    if (/\n\s*[-*]\s+\S/.test(n.v)) found.push(`list: ${n.v.trim().slice(0, 60)}`);
  } };
  walk(parseHtml(String(html ?? "")), false);
  return found;
}

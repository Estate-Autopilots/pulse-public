// DOCS-GDOCS (owner, 15 Nov 2026: "no raw Markdown ever shown; imported Markdown/Word/HTML becomes real formatting"):
// Markdown as Google Docs, Word and chat answers write it, made readable for `marked` before it is turned into HTML.
// The real "Vitals OS Offer" import showed three faults (the web's apps/web/app/lib/doc-repair.mjs mends docs already
// stored with them):
//  - one paragraph per line with no blank line between: Markdown joins the lines into one run-on paragraph, and a line
//    written after a list item is swallowed into that item;
//  - "| #### What buyers expect |": a table cell keeps Google Docs' heading style as "####", shown as text;
//  - "**$100M Scaling Roadmap****:**": two bold runs side by side ("****"), which Markdown cannot read.

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const TABLE = /^\s*\|/;
const ITEM = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+\S/;
const NESTED = /^(\s{2,}|\t)\S/;
const HTML = /^\s{0,3}<\/?[a-zA-Z]/;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

const kind = (line: string) => !line.trim() ? 'blank' : TABLE.test(line) ? 'table' : HTML.test(line) ? 'html' : HEADING.test(line) ? 'heading'
  : RULE.test(line) ? 'rule' : /^\s{0,3}>/.test(line) ? 'quote' : NESTED.test(line) ? 'nested' : ITEM.test(line) ? 'item' : 'text';

/** Lines of words that sit together with no blank line between: hand-written Markdown wraps them at about 80
 *  characters (all about the same length); Google Docs, Word and chat answers write one paragraph per line. */
export function onePerLine(lines: string[]): boolean {
  const lens: number[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = kind(lines[i]), b = kind(lines[i + 1]);
    if ((a === 'text' || a === 'item') && (b === 'text')) lens.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '').trim().length);
  }
  if (!lens.length) return false;
  return lens.filter((x) => x >= 45 && x <= 100).length < lens.length * 0.8;
}

/** "****" joins two bold runs: with a space before a word ("**Hormozi’s****$100M**"), without one before a mark. */
const joinBold = (line: string) => line.replace(/\*{4}(?=\S)/g, (_m, at: number, s: string) => /[\p{L}\p{N}$₹€£]/u.test(s[at + 4] ?? '') ? '** **' : '');
/** A table cell that starts with "#### " shows its words in bold. */
const cellHeadings = (line: string) => line.replace(/(?<!\\)\|(\s*)#{1,6}\s+([^|]*?[^\s|\\])(\s*)(?=\|)/g, (_m, a: string, words: string, b: string) => `|${a}**${words.replace(/^\*\*|\*\*$/g, '')}**${b}`);

export function tidyMarkdown(md: string): string {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const prose: string[] = [];
  let fence: string | null = null;
  // fenced code is left exactly as written
  const inCode = lines.map((line) => {
    const f = line.match(FENCE);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; return true; }
    if (f) { fence = f[1]; return true; }
    return false;
  });
  lines.forEach((l, i) => { if (!inCode[i]) prose.push(l); else prose.push(''); });
  const split = onePerLine(prose);
  const out: string[] = [];
  lines.forEach((raw, i) => {
    if (inCode[i]) { out.push(raw); return; }
    let line = joinBold(raw);
    if (TABLE.test(line)) line = cellHeadings(line);
    if (split && i > 0 && !inCode[i - 1]) {
      const a = kind(lines[i - 1]), b = kind(line);
      // a new paragraph after words or after a list item (the item no longer swallows it); a list after words
      if ((b === 'text' && (a === 'text' || a === 'item')) || (b === 'item' && a === 'text')) out.push('');
      // inside a quote, each line is its own paragraph too
      else if (a === 'quote' && b === 'quote' && lines[i - 1].replace(/^\s*>\s?/, '').trim() && line.replace(/^\s*>\s?/, '').trim()) out.push('>');
    }
    out.push(line);
  });
  return out.join('\n');
}

/** A Google Docs "Web page (.html)" download: its bold, italics, underline and strike-through live in classes in
 *  <head> (".c3{font-weight:700}"), which the stored body does not keep; they become <strong>, <em>, <u> and <s>.
 *  Its links go through google.com/url?q=…; they point straight at the page again. */
export function webPageHtml(html: string): string {
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const rules = new Map<string, string[]>();
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)\s*\{([^}]*)\}/g)) {
    const d = m[2].replace(/\s+/g, '').toLowerCase(), tags: string[] = [];
    if (/font-weight:(bold|[6-9]00)/.test(d)) tags.push('strong');
    if (/font-style:italic/.test(d)) tags.push('em');
    if (/text-decoration(-line)?:[^;]*underline/.test(d)) tags.push('u');
    if (/text-decoration(-line)?:[^;]*line-through/.test(d)) tags.push('s');
    if (tags.length) rules.set(m[1], [...new Set([...(rules.get(m[1]) ?? []), ...tags])]);
  }
  const marked = !rules.size ? html : html.replace(/<span\b[^>]*?\bclass="([^"]*)"[^>]*>((?:(?!<\/?span\b)[\s\S])*)<\/span>/g, (all, cls: string, inner: string) => {
    const tags = [...new Set(cls.split(/\s+/).flatMap((c) => rules.get(c) ?? []))];
    return tags.length && inner.trim() ? tags.reduceRight((acc, t) => `<${t}>${acc}</${t}>`, inner) : all;
  });
  return marked.replace(/href="https:\/\/www\.google\.com\/url\?q=([^"&]+)[^"]*"/g, (_m, q: string) => {
    try { return `href="${decodeURIComponent(q.replace(/&amp;$/, ''))}"`; } catch { return `href="${q}"`; }
  });
}

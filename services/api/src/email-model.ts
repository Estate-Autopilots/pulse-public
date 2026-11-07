// CHATS-2 premium email: what the API does to a Gmail message before a browser sees it. The reader also renders the
// result in a sandboxed iframe (no scripts, no forms, remote images only on request), so this sanitiser is the second
// wall, not the only one. It keeps the layout of a newsletter (tables, inline styles, <style>) and removes everything
// that runs, submits, embeds or navigates on its own.

const DROP_WITH_CONTENT = new Set(['script', 'iframe', 'object', 'embed', 'applet', 'frame', 'frameset', 'noscript', 'template', 'svg', 'math', 'title', 'textarea', 'select', 'button', 'audio', 'video', 'canvas']);
const ALLOWED = new Set(['a', 'abbr', 'address', 'article', 'b', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'label', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q',
  's', 'samp', 'section', 'small', 'span', 'strike', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'var', 'wbr']);
const VOID = new Set(['br', 'col', 'hr', 'img', 'wbr']);
const ATTRS = new Set(['align', 'alt', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'class', 'color', 'cols', 'colspan', 'dir', 'face', 'height', 'href', 'hspace', 'lang', 'rowspan', 'size', 'span',
  'src', 'start', 'style', 'summary', 'title', 'type', 'valign', 'vspace', 'width', 'background']);
// Mail clients' own markers for the quoted earlier message.
const QUOTE_CLASS = /(?:^|\s)(gmail_quote|gmail_extra|yahoo_quoted|moz-cite-prefix|protonmail_quote|OutlookMessageHeader)(?:\s|$)/i;
const OUTLOOK_REPLY = /^(divRplyFwdMsg|appendonsend|Signature|mail-editor-reference-message-container)$/i;

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')' };
export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    return ENTITY[e.toLowerCase()] ?? m;
  });
}
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Tracking and redirect wrappers hide the real destination; this is the address a person would recognise. */
export function unwrapLink(href: string): string {
  try {
    let u = new URL(href);
    for (let i = 0; i < 3; i++) {
      const host = u.hostname.toLowerCase();
      const inner = (host === 'www.google.com' || host === 'google.com') && u.pathname === '/url' ? u.searchParams.get('q') ?? u.searchParams.get('url')
        : /(^|\.)safelinks\.protection\.outlook\.com$/.test(host) ? u.searchParams.get('url')
        : host === 'l.facebook.com' || host === 'lm.facebook.com' ? u.searchParams.get('u')
        : host === 'urldefense.com' || host === 'urldefense.proofpoint.com' ? (u.pathname.match(/__(https?:\/\/[^_]+)__/)?.[1] ?? u.searchParams.get('u'))
        : null;
      if (!inner || !/^https?:\/\//i.test(inner)) break;
      u = new URL(inner);
    }
    return u.href;
  } catch { return href; }
}
/** "https://click.mailer.example.com/ls/click?upn=…" → "mailer.example.com". */
export function linkLabel(href: string): string {
  try {
    const u = new URL(unwrapLink(href));
    if (u.protocol === 'mailto:') return decodeURIComponent(u.pathname);
    return u.hostname.replace(/^(www|click|links?|email|e|t|track|trk|go|r|url\d*|em|mail)\d*\./i, '');
  } catch { return href.slice(0, 40); }
}

function safeUrl(raw: string, kind: 'href' | 'src', cid?: (id: string) => string | null): string | null {
  const v = decodeEntities(raw).replace(/[\u0000-\u0020\u007f-\u009f]+/g, '');
  if (kind === 'src' && /^cid:/i.test(v)) return cid?.(v.slice(4)) ?? null;
  if (kind === 'src' && /^data:image\/(png|gif|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(v)) return v;
  if (/^https?:\/\//i.test(v)) return v;
  if (kind === 'href' && /^(mailto|tel):/i.test(v)) return v;
  if (kind === 'href' && v.startsWith('#')) return v;
  return null;
}
/** CSS that cannot run code, load another stylesheet or bind behaviour. Remote url()s stay: the iframe's CSP blocks them. */
export function safeCss(css: string): string {
  return decodeEntities(css).replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^;]*;?/gi, '').replace(/expression\s*\(/gi, 'x(').replace(/(?:java|vb)script\s*:/gi, '')
    .replace(/behavior\s*:/gi, 'x:').replace(/-moz-binding/gi, 'x').replace(/position\s*:\s*fixed/gi, 'position:static').replace(/<\/?\w/g, '');
}

export type Sanitised = { html: string; remoteImages: number; links: number };
/** Allow-list sanitiser for an e-mail body (see the file comment). `cid` maps an inline image's Content-ID to a URL. */
export function sanitizeEmailHtml(input: string, cid?: (id: string) => string | null): Sanitised {
  const src = input.slice(0, 400000);
  const out: string[] = []; const stack: string[] = []; let remoteImages = 0, links = 0;
  // A quote is collapsed once, at its outermost element; Outlook's reply header collapses the rest of its parent.
  let quoteDepth = -1, outlookDepth = -1;
  const TOKEN = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
  let at = 0, m: RegExpExecArray | null;
  const text = (s: string) => {
    if (!s) return;
    let t = s.replace(/</g, '&lt;');
    // A URL written as the visible text of a link is shown as its domain.
    if (stack.includes('a') && /^\s*https?:\/\/\S+\s*$/i.test(decodeEntities(t))) t = attr(linkLabel(decodeEntities(t).trim()));
    out.push(t);
  };
  const closeTo = (depth: number) => {
    while (stack.length > depth) {
      // Outlook's collapsed block ends just inside the parent of its reply header.
      if (outlookDepth >= 0 && stack.length === outlookDepth) { out.push('</details>'); outlookDepth = -1; }
      const tag = stack.pop()!;
      out.push(`</${tag}>`);
      if (quoteDepth === stack.length) { out.push('</details>'); quoteDepth = -1; }
    }
  };
  while ((m = TOKEN.exec(src))) {
    text(src.slice(at, m.index)); at = TOKEN.lastIndex;
    const tag = m[1]?.toLowerCase();
    if (!tag) continue; // comment, doctype, CDATA, processing instruction
    const closing = m[0][1] === '/';
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!closing && !m[0].endsWith('/>')) { const end = src.toLowerCase().indexOf(`</${tag}`, at); at = end < 0 ? src.length : (src.indexOf('>', end) + 1 || src.length); TOKEN.lastIndex = at; }
      continue;
    }
    if (tag === 'style') {
      if (closing) continue;
      const end = src.toLowerCase().indexOf('</style', at); const css = src.slice(at, end < 0 ? src.length : end);
      out.push(`<style>${safeCss(css)}</style>`); at = end < 0 ? src.length : (src.indexOf('>', end) + 1 || src.length); TOKEN.lastIndex = at;
      continue;
    }
    if (!ALLOWED.has(tag)) continue; // unknown element: drop the tag, keep its text
    if (closing) { const i = stack.lastIndexOf(tag); if (i >= 0) closeTo(i); continue; }
    const kept: string[] = []; let cls = '', idv = '', cite = false;
    const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g; let a: RegExpExecArray | null;
    while ((a = ATTR.exec(m[2] ?? ''))) {
      const name = a[1].toLowerCase(); const value = a[2] ?? a[3] ?? a[4] ?? '';
      if (name === 'id') idv = value;
      if (name === 'type' && tag === 'blockquote' && value.toLowerCase() === 'cite') cite = true;
      if (!ATTRS.has(name) || name.startsWith('on')) continue;
      if (name === 'href') { const u = tag === 'a' ? safeUrl(value, 'href') : null; if (u) { kept.push(`href="${attr(u)}"`, `title="${attr(linkLabel(u))}"`); links++; } continue; }
      if (name === 'src' || name === 'background') {
        const u = safeUrl(value, 'src', cid); if (!u) continue;
        if (/^https?:/i.test(u)) remoteImages++;
        kept.push(`${name}="${attr(u)}"`); continue;
      }
      if (name === 'style') { kept.push(`style="${attr(safeCss(value))}"`); continue; }
      if (name === 'class') cls = value;
      kept.push(`${name}="${attr(decodeEntities(value))}"`);
    }
    if (tag === 'a') kept.push('target="_blank"', 'rel="noopener noreferrer"');
    if (quoteDepth < 0 && outlookDepth < 0 && ((tag === 'div' || tag === 'blockquote') && QUOTE_CLASS.test(cls) || cite)) {
      out.push('<details class="pulse-quote"><summary title="Show the quoted message">•••</summary>'); quoteDepth = stack.length;
    } else if (quoteDepth < 0 && outlookDepth < 0 && OUTLOOK_REPLY.test(idv) && /^(divRplyFwdMsg|appendonsend)$/i.test(idv)) {
      out.push('<details class="pulse-quote"><summary title="Show the quoted message">•••</summary>'); outlookDepth = stack.length;
    }
    out.push(`<${tag}${kept.length ? ' ' + kept.join(' ') : ''}>`);
    if (!VOID.has(tag)) stack.push(tag);
  }
  text(src.slice(at));
  closeTo(0);
  if (outlookDepth >= 0) out.push('</details>');
  return { html: out.join(''), remoteImages, links };
}

/** UI-POLISH-3 (R024): an address under the reserved `.invalid` domain (synthetic test people) never has a mailbox, so
 *  Chats does not offer it and the inbox never asks Google (which answered 503 on every page that warmed the mail). */
export const hasMailbox = (email: string | null | undefined) => !!email && /@[^@\s]+$/.test(email.trim()) && !/\.invalid$/i.test(email.trim());

/** "Priya Soniba <priya@example.com>" → name and address; a bare address keeps its local part as the name. */
export function parseSender(from: string): { name: string; email: string } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim().toLowerCase() };
  const email = from.trim().toLowerCase();
  return { name: email.split('@')[0] || from, email };
}

const SYSTEM_LABELS: Record<string, string> = { INBOX: 'Inbox', STARRED: 'Starred', IMPORTANT: 'Important', SENT: 'Sent', DRAFT: 'Draft', SPAM: 'Spam', TRASH: 'Trash',
  CATEGORY_PERSONAL: 'Primary', CATEGORY_SOCIAL: 'Social', CATEGORY_PROMOTIONS: 'Promotions', CATEGORY_UPDATES: 'Updates', CATEGORY_FORUMS: 'Forums' };
export const EMAIL_CATEGORIES = ['primary', 'promotions', 'social', 'updates', 'forums'] as const;
/** Gmail label ids → the category tab and the user labels worth showing as chips. */
export function describeLabels(ids: string[], names: Map<string, string>) {
  const category = ids.includes('CATEGORY_PROMOTIONS') ? 'promotions' : ids.includes('CATEGORY_SOCIAL') ? 'social' : ids.includes('CATEGORY_UPDATES') ? 'updates' : ids.includes('CATEGORY_FORUMS') ? 'forums' : 'primary';
  const labels = ids.filter((x) => !(x in SYSTEM_LABELS) && !/^(UNREAD|CHAT|CATEGORY_)/.test(x)).map((x) => names.get(x) ?? null).filter((x): x is string => !!x && !/^(\[Imap\]|Notes$)/.test(x));
  return { category, labels, starred: ids.includes('STARRED'), important: ids.includes('IMPORTANT') };
}
/** The Gmail search for a view: the inbox tab by default, everything when someone searches. */
export function inboxQuery(q: { q?: string; unread?: string; category?: string; label?: string; starred?: string }): string {
  const parts: string[] = [];
  const typed = String(q.q ?? '').trim().slice(0, 300);
  if (q.label) parts.push(`label:"${String(q.label).replace(/["\\]/g, '').slice(0, 100)}"`);
  else if (q.starred === '1') parts.push('is:starred');
  else if (!typed) parts.push('in:inbox');
  // Gmail's Primary is "in no other tab": mail without a category label does not match category:primary.
  if (!typed && !q.label && q.starred !== '1' && EMAIL_CATEGORIES.includes(q.category as typeof EMAIL_CATEGORIES[number]))
    parts.push(q.category === 'primary' ? '-category:promotions -category:social -category:updates -category:forums' : `category:${q.category}`);
  if (q.unread === '1') parts.push('is:unread');
  if (typed) parts.push(typed);
  return parts.join(' ');
}

// DOCS-RICH (owner, 9 Nov 2026): uploaded web pages inside docs, and "Turn into doc blocks".
//
// A page (an HTML analysis Claude made, say) is kept as a doc file and only ever shown through GET /api/v0/docs/frames/:id,
// which answers with its own content-security-policy: `sandbox allow-scripts` (an opaque origin: no cookies, no storage,
// no reach into the doc, Pulse or its API), no network at all except scripts, styles and fonts from a short list of
// public CDNs, no forms, no frames, no top navigation, and only Pulse may frame it. The doc shows it in
// <iframe sandbox="allow-scripts"> as well (the web proxy sets the same policy: apps/web/app/lib/doc-rich.mjs). A small
// script added at the top of the page tells the doc its height, by postMessage, so the frame grows with the page.
//
// Agents send a page inside a block ({"kind":"html","source":"<!doctype html>…"}); saving keeps it as a file
// (takePages, then storePages once the doc row exists) so the doc body holds only the block's fileId.
import { randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx } from './routes.js';
import { cleanBlock, blocksIn } from './doc-blocks.js';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A page kept in Docs: 4 MB at most (a doc file may be 10 MB; an analysis page is usually under 1 MB). */
export const MAX_PAGE = 4 * 1024 * 1024;

/** Where a page may load scripts, styles and fonts from: public CDNs that analyses use (Chart.js, Plotly, D3, ECharts,
 *  Vega, Mermaid, Tailwind, Google Fonts). Everything else (any fetch, form, frame, beacon or picture from the web) is
 *  refused. Keep it equal to FRAME_CSP in apps/web/app/lib/doc-rich.mjs (test/doc-rich.test.mjs checks). */
export const FRAME_CDNS = ['https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://unpkg.com', 'https://cdn.plot.ly', 'https://d3js.org', 'https://cdn.tailwindcss.com'];
export const FRAME_CSP = ['sandbox allow-scripts', "default-src 'none'", `script-src 'unsafe-inline' 'unsafe-eval' ${FRAME_CDNS.join(' ')}`,
  `style-src 'unsafe-inline' ${FRAME_CDNS.join(' ')} https://fonts.googleapis.com`, `font-src data: ${FRAME_CDNS.join(' ')} https://fonts.gstatic.com`,
  'img-src data: blob:', 'media-src data: blob:', "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "child-src 'none'", 'worker-src blob:',
  "object-src 'none'", "base-uri 'none'", "manifest-src 'none'", "frame-ancestors 'self'"].join('; ');

/** Added at the top of every page shown in a frame: it tells the doc the page's height (nothing else). */
export const HEIGHT_SCRIPT = '<script>(function(){var l=-1;function s(){var d=document.documentElement,b=document.body,h=Math.ceil(Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0));'
  + 'if(h&&h!==l){l=h;try{parent.postMessage({pulseFrame:"height",height:h},"*")}catch(e){}}}'
  + 'addEventListener("load",s);addEventListener("resize",s);document.addEventListener("DOMContentLoaded",s);'
  + 'if(window.ResizeObserver){try{new ResizeObserver(s).observe(document.documentElement)}catch(e){}}setInterval(s,1500)})();</script>';
/** The page with the height script placed at the start of its head (or body, or the whole page), never before a doctype. */
export function framePage(html: string): string {
  const head = html.slice(0, 4000);
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = head.match(re);
    if (m && m.index !== undefined) return html.slice(0, m.index + m[0].length) + HEIGHT_SCRIPT + html.slice(m.index + m[0].length);
  }
  return HEIGHT_SCRIPT + html;
}

// ------------------------------------------------------------------------------------------------ pages sent inline
/** Pages taken out of a body being saved, waiting for the doc row (storePages). Keys are fresh random ids. */
const PENDING = new Map<string, { name: string; data: Buffer; at: number }>();
const entities = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** An html block carrying its page (source, or html) gets a file id instead; the page waits in PENDING. */
function hoist(raw: Row): Row {
  if (raw.kind !== 'html') return raw;
  const src = typeof raw.source === 'string' ? raw.source : typeof raw.html === 'string' ? raw.html : null;
  if (src === null || !src.trim() || (typeof raw.fileId === 'string' && UUID.test(raw.fileId))) return raw;
  const data = Buffer.from(src, 'utf8');
  if (data.length > MAX_PAGE) fail(413, 'A web page in a doc is 4 MB at most');
  const id = randomUUID(), title = String(raw.title ?? '').replace(/[\\/\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || 'Web page';
  const now = Date.now();
  for (const [k, v] of PENDING) if (now - v.at > 15 * 60_000) PENDING.delete(k);
  PENDING.set(id, { name: /\.html?$/i.test(title) ? title : `${title}.html`, data, at: now });
  const { source: _s, html: _h, ...rest } = raw;
  return { ...rest, fileId: id };
}
/** Markdown: ```pulse-block {"kind":"html","source":"…"}``` fences. */
export function takePagesMarkdown(md: string): string {
  if (!md.includes('"html"')) return md;
  return md.replace(/^```pulse-block[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm, (all, json: string) => {
    try { const b = JSON.parse(json) as Row; return b?.kind === 'html' ? `\`\`\`pulse-block\n${JSON.stringify(hoist(b))}\n\`\`\`` : all; } catch { return all; }
  });
}
/** HTML: <div data-type="pulse-block" data-block='{"kind":"html","source":…}'> (either quote). */
export function takePagesHtml(html: string): string {
  if (!html.includes('pulse-block')) return html;
  return html.replace(/(<div\b[^>]*?\bdata-block=)("([^"]*)"|'([^']*)')/g, (all, pre: string, _q: string, dq?: string, sq?: string) => {
    try {
      const b = JSON.parse(entities(dq ?? sq ?? '')) as Row;
      return b?.kind === 'html' ? `${pre}"${attr(JSON.stringify(hoist(b)))}"` : all;
    } catch { return all; }
  });
}
/** After the doc row is written: each page this body waits for becomes the doc's file (under its own row security). */
export async function storePages(c: PoolClient, docIdValue: string, html: string) {
  for (const b of blocksIn(html)) {
    const id = typeof b.fileId === 'string' ? b.fileId : '', p = b.kind === 'html' ? PENDING.get(id) : undefined;
    if (!p) continue;
    PENDING.delete(id);
    await c.query(`insert into pulse.doc_file(org_id,id,doc_id,name,mime,size,sha256,bytes,added_by)
      values(pulse.current_org(),$1,$2,$3,'text/html',$4,$5,$6,pulse.current_viewer())`, [id, docIdValue, p.name, p.data.length, createHash('sha256').update(p.data).digest('hex'), p.data]);
  }
}

// ------------------------------------------------------------------------------------------------ one block at a time
/** Replaces one block of a body (found by its id) with a new version of it; the kind stays (MCP update_doc_block). */
export function replaceBlock(html: string, blockIdValue: string, next: Row): { html: string; block: Row } {
  let hit: Row | null = null;
  const out = html.replace(/<div\b[^>]*data-type="pulse-block"[^>]*><\/div>/g, (tag) => {
    const raw = (tag.match(/data-block="([^"]*)"/) ?? [])[1];
    if (!raw || hit) return tag;
    let b: Row;
    try { b = JSON.parse(entities(raw)) as Row; } catch { return tag; }
    if (b.id !== blockIdValue) return tag;
    const merged = hoist({ ...b, ...next, kind: b.kind, id: b.id });
    const clean = cleanBlock(merged);
    if (!clean) return tag;
    hit = clean;
    return `<div data-type="pulse-block" data-kind="${clean.kind}" data-id="${clean.id}" data-block="${attr(JSON.stringify(clean))}"></div>`;
  });
  return hit ? { html: out, block: hit } : fail(404, 'That block is not in this doc. Read the doc again (get_doc) for its blocks and their ids.');
}

// ------------------------------------------------------------------------------------------------ routes
export function registerDocRichRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // A page, sealed (see the top of this file). ?source=1 sends its words as plain text, for "Edit code".
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/v0/docs/frames/:id', async (req, reply) => {
    const file = await tx(req, async (c) => UUID.test(req.params.id)
      ? (await c.query(`select name,bytes from pulse.doc_file where id=$1 and mime='text/html' and archived_at is null`, [req.params.id])).rows[0] : undefined);
    if (!file) fail(404, 'Page unavailable');
    const text = Buffer.from(file.bytes).toString('utf8');
    reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer')
      .header('cross-origin-resource-policy', 'same-origin').header('content-security-policy', req.query.source === '1' ? "default-src 'none'; sandbox" : FRAME_CSP);
    return req.query.source === '1' ? reply.type('text/plain; charset=utf-8').send(text) : reply.type('text/html; charset=utf-8').send(framePage(text));
  });
  // "Turn into doc blocks": the page's words, tables, numbers and charts as the doc's own blocks (nothing is saved here).
  app.post<{ Body: Row }>('/api/v0/docs/convert-html', { bodyLimit: 6_500_000 }, (req) => tx(req, async (c) => {
    if (!(await c.query('select pulse.doc_member_ok() v')).rows[0]?.v) fail(403, 'Docs are for the company\'s staff and AI employees');
    const b = req.body ?? {};
    let page = typeof b.html === 'string' ? b.html : null;
    if (page === null && typeof b.fileId === 'string' && UUID.test(b.fileId)) {
      const f = (await c.query(`select bytes from pulse.doc_file where id=$1 and mime='text/html'`, [b.fileId])).rows[0];
      page = f ? Buffer.from(f.bytes).toString('utf8') : fail(404, 'Page unavailable');
    }
    if (page === null || !page.trim()) return fail(400, 'Send the page (html) or its file (fileId)');
    if (Buffer.byteLength(page) > MAX_PAGE) fail(413, 'A web page in a doc is 4 MB at most');
    // loaded here, not with the API: only this route needs the page and script parsers (htmlparser2, acorn)
    const [{ cleanHtml }, { convertHtmlPage }] = await Promise.all([import('./docs.js'), import('./doc-html.js')]);
    const out = convertHtmlPage(page);
    return { title: out.title, html: cleanHtml(out.html), found: out.found };
  }));
}

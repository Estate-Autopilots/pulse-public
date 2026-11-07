import type { FastifyInstance } from 'fastify';
import { fail, type Tx } from './routes.js';
// WA-REPORT (1074): Insights → Reports, the company's analysis book in Pulse: the contents with search, one page (its
// blocks, the messages its evidence opens and excerpts from the chats the viewer may read), the page about a colleague
// or a client for their own page, and exports (a page's Markdown and PDF, the whole book as PDF and Markdown). The
// database decides who reads what: leadership and admins everything, a colleague their own page (pulse.report_can);
// every page read and download is audited there.
const KEY = /^[a-z]+\/[A-Za-z0-9_-]{1,80}$/;
const KIND = new Set(['person', 'client', 'project', 'group']);
type Q = Record<string, string | undefined>;

const key = (k: unknown) => typeof k === 'string' && KEY.test(k) ? k : fail(400, 'Choose a valid report page');
const fileName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'report';

export function registerReportRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const person = (v: { person: string | null }) => { if (!v.person) fail(403, 'Reports need your individual employee account'); };
  // The contents: ?part=&q=&limit=&offset= (a colleague who is not a leader gets their own page only).
  app.get('/api/v0/reports', (req) => tx(req, async (c, v) => {
    person(v); const q = req.query as Q;
    const p = { part: q.part ?? '', q: (q.q ?? '').slice(0, 120), limit: Number(q.limit ?? 200) || 200, offset: Number(q.offset ?? 0) || 0 };
    return (await c.query('select pulse.report_index($1) r', [JSON.stringify(p)])).rows[0].r;
  }));
  app.get('/api/v0/reports/editions', (req) => tx(req, async (c, v) => {
    person(v); const r = (await c.query('select pulse.report_editions() r')).rows[0].r;
    if (r === null) fail(403, 'Reports are for leadership and admins');
    return { editions: r };
  }));
  // One page with the excerpts of the messages it cites (only from chats the viewer reads).
  app.get('/api/v0/reports/page', (req) => tx(req, async (c, v) => {
    person(v); const k = key((req.query as Q).key);
    const page = (await c.query('select pulse.report_page($1) r', [k])).rows[0].r;
    if (!page) fail(404, 'This report page is not there, or not yours to read');
    const excerpts = (await c.query('select pulse.report_excerpts($1) r', [k])).rows[0].r ?? {};
    return { ...page, excerpts };
  }));
  // The page about a subject, for its own page in Pulse (null when there is none the viewer may read).
  app.get<{ Params: { kind: string; id: string } }>('/api/v0/reports/subject/:kind/:id', (req) => tx(req, async (c, v) => {
    person(v); const kind = KIND.has(req.params.kind) ? req.params.kind : fail(400, 'Choose a person, client, project or group');
    const id = /^[A-Za-z0-9_-]{1,80}$/.test(req.params.id) ? req.params.id : fail(400, 'Choose a valid id');
    return { page: (await c.query('select pulse.report_subject($1,$2) r', [kind, id])).rows[0].r };
  }));
  // Exports: ?key=<page>&format=md|pdf, or ?book=pdf|md (the whole book: leadership and admins).
  app.get('/api/v0/reports/export', async (req, reply) => {
    const q = req.query as Q;
    const out = await tx(req, async (c, v) => {
      person(v);
      if (q.format === 'md' && q.key) {
        const k = key(q.key);
        const md = (await c.query('select pulse.report_page_md($1) r', [k])).rows[0].r as string | null;
        if (md === null) fail(404, 'This report page is not there, or not yours to read');
        return { mime: 'text/markdown', name: `${fileName(k)}.md`, bytes: Buffer.from(md!, 'utf8') };
      }
      const fkey = q.book === 'pdf' ? 'book.pdf' : q.book === 'md' ? 'book.md' : q.format === 'pdf' && q.key ? `slice:${key(q.key)}` : fail(400, 'Choose a page and a format, or the book');
      const f = (await c.query('select pulse.report_file_open($1) f', [fkey])).rows[0].f as { mime: string; size: number; parts: number; sha256: string; version: string } | null;
      if (!f) fail(404, fkey.startsWith('slice:') ? 'No PDF of this page in the current edition' : 'The book is for leadership and admins');
      const chunks: Buffer[] = [];
      for (let p = 0; p < f!.parts; p += 16) {
        for (const r of (await c.query('select part, data from pulse.report_file_parts($1,$2,$3)', [fkey, p, Math.min(p + 15, f!.parts - 1)])).rows) chunks.push(r.data);
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== f!.size) fail(500, 'The stored file is incomplete');
      const base = fkey.startsWith('slice:') ? fileName(fkey.slice(6)) : `ea-analysis-${fileName(f!.version)}`;
      return { mime: f!.mime, name: `${base}.${f!.mime === 'application/pdf' ? 'pdf' : 'md'}`, bytes, etag: f!.sha256 };
    });
    const inline = out.mime === 'application/pdf' && q.inline === '1';
    reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(out.name)}`)
      .type(out.mime === 'text/markdown' ? 'text/markdown; charset=utf-8' : out.mime);
    if (out.mime !== 'application/pdf' || !inline) reply.header('content-security-policy', 'sandbox');
    reply.header('content-length', String(out.bytes.length));
    return reply.send(out.bytes);
  });
}

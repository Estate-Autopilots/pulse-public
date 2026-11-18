// DOCS-EXPORT (owner, 17 Nov 2026: "at least export and download features, and little by little more"): one doc as a
// file to keep or send, as PDF, Word (.docx) or Markdown: GET /api/v0/docs/:id/export?format=pdf|docx|md.
// Who may export is who may open: the doc is read inside the viewer's own transaction (tx), so forced row security
// (pulse.doc_can_see, tenant_isolation) decides; a doc the viewer cannot open, or one in another company, answers 404
// exactly as opening it does, and nothing tells them it exists. The words come from the Markdown Docs already makes for
// export and AI (htmlToMarkdown); the PDF and Word files are drawn by @pulse/invoice-doc (doc-export.js), as the Drive
// backup does. A chart, diagram or web page block goes as its words; the doc page's own PDF (print) keeps their pictures.
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { FONT_URLS, renderDocDocx, renderDocPdf, safeFileName } from '@pulse/invoice-doc';
import { fail, type Tx } from './routes.js';

export const EXPORT_FORMATS = {
  pdf: { ext: 'pdf', mime: 'application/pdf' },
  docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  md: { ext: 'md', mime: 'text/markdown; charset=utf-8' },
} as const;
export type ExportFormat = keyof typeof EXPORT_FORMATS;

/** The format asked for (pdf, docx or md; "word" and "markdown" too), or a plain 400. */
export function exportFormat(v: unknown): ExportFormat {
  const f = String(v ?? '').trim().toLowerCase();
  const named = f === 'word' ? 'docx' : f === 'markdown' ? 'md' : f;
  return Object.hasOwn(EXPORT_FORMATS, named) ? named as ExportFormat : fail(400, 'Choose a format: pdf, docx or md');
}

/** Content-Disposition for a download: an ASCII name for old programs and the real (UTF-8) name for the rest. */
export function attachmentHeader(title: string, ext: string): string {
  const name = safeFileName(title, ext);
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\%;]/g, '').replace(/\s+/g, ' ').trim();
  return `attachment; filename="${ascii && ascii !== `.${ext}` ? ascii : `doc.${ext}`}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** The Markdown file: the title as its first heading, then the doc. */
export const markdownFile = (title: string, markdown: string) => `# ${title.replace(/\s+/g, ' ').trim() || 'Untitled'}\n\n${markdown.trim()}\n`;

let fonts: Promise<{ regular: Buffer; semibold: Buffer }> | null = null;
const fontBytes = () => (fonts ??= Promise.all([readFile(FONT_URLS.regular), readFile(FONT_URLS.semibold)]).then(([regular, semibold]) => ({ regular, semibold })));

type Deps = {
  getDoc: (c: PoolClient, id: string) => Promise<{ title: string; html: string; updatedAt: string }>;
  htmlToMarkdown: (html: string) => string;
};

export function registerDocExportRoutes(app: FastifyInstance, { tx }: { tx: Tx }, deps: Deps) {
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/v0/docs/:id/export', async (req, reply) => {
    // Read under the viewer's row security (and nothing else: the file is drawn after the transaction ends).
    // The format is checked inside the transaction, after the session: someone signed out gets 401, never a 400.
    const { format, doc } = await tx(req, async (c) => {
      const format = exportFormat(req.query.format);
      const d = await deps.getDoc(c, req.params.id);
      return { format, doc: { title: d.title || 'Untitled', html: d.html, updatedAt: d.updatedAt } };
    });
    const markdown = deps.htmlToMarkdown(doc.html);
    const kind = EXPORT_FORMATS[format];
    const body = format === 'md' ? Buffer.from(markdownFile(doc.title, markdown), 'utf8')
      : format === 'pdf' ? Buffer.from(await renderDocPdf({ title: doc.title, markdown }, { fonts: await fontBytes() }))
      : Buffer.from(await renderDocDocx({ title: doc.title, markdown }));
    return reply
      .header('content-type', kind.mime)
      .header('content-disposition', attachmentHeader(doc.title, kind.ext))
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(body);
  });
}

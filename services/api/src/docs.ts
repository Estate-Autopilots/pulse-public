// DOCS-WORKBENCH (owner, 6 Nov 2026: "a super document-saving system with an editor, folders, files … you can tag
// different things, people, everything … far better than any Google document"): the company's docs (1686). One model
// serves the screens (/api/v0/docs…, below) and API v1 / MCP / the CLI (v1-docs.ts). Who sees and changes which doc is
// decided in the database (pulse.doc_can_see / doc_can_edit / doc_id_can_share under forced row security); this file
// sanitises what is stored, keeps the mentions for backlinks and shapes the words. docs/spec/DOCS.md has the design.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import sanitizeHtml from 'sanitize-html';
import { marked } from 'marked';
import TurndownService from 'turndown';
import mammoth from 'mammoth';
import { fail, type Tx } from './routes.js';
import { sendFile } from './tasks.js';
import { blockAttribs, blockHtml, blocksFromMarkdown } from './doc-blocks.js';
import { docsFor, registerDocInteractiveRoutes } from './doc-interactive.js';
import { registerDocExportRoutes } from './doc-export.js';
import { storePages, takePagesHtml, takePagesMarkdown } from './doc-rich.js';
import { tidyMarkdown, webPageHtml } from './doc-markdown.js';
import { byActivity, docActivity, folderActivity } from './doc-activity.js';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const docId = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(404, 'Doc not found');
const anId = (x: unknown, what: string) => UUID.test(String(x)) ? String(x) : fail(400, `Choose ${what}`);

export const MENTION_KINDS = ['person', 'agent', 'task', 'project', 'goal', 'contract', 'client', 'file', 'doc'] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];
export const ACCESS = ['private', 'company', 'people'] as const;
export type Access = (typeof ACCESS)[number];
/** Size limits: a doc's HTML, an uploaded or imported file. */
export const MAX_HTML = 1_000_000, MAX_FILE = 10 * 1024 * 1024, MAX_IMPORT = 5 * 1024 * 1024;

// ------------------------------------------------------------------------------------------------ the stored body
/** Only the editor's own blocks survive: no scripts, styles, event handlers, frames or forms. Links are http(s) or
 *  mailto; images come from the doc's own files or https. Mentions keep their kind, id and label. */
const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 's', 'u', 'mark', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'hr',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col', 'a', 'img', 'span', 'div', 'label', 'input', 'sub', 'sup', 'details', 'summary'],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'title', 'width', 'height'],
    // DOCS-GDOCS: Google Docs' toolbar: a paragraph's alignment (style) and indent; a word's size (style) and named
    // colour; a highlight's named colour. Only the styles below survive (allowedStyles).
    span: ['data-type', 'data-kind', 'data-id', 'data-label', 'class', 'data-color', 'style'], mark: ['data-color'],
    p: ['style', 'data-indent'], h1: ['style', 'data-indent'], h2: ['style', 'data-indent'], h3: ['style', 'data-indent'], h4: ['style', 'data-indent'],
    div: ['data-type', 'data-tone', 'data-kind', 'data-id', 'data-block', 'data-count'],
    details: ['data-type', 'open'],
    ul: ['data-type'], ol: ['start'], li: ['data-type', 'data-checked'], input: ['type', 'checked', 'disabled'],
    pre: ['class'], code: ['class'], th: ['colspan', 'rowspan', 'colwidth'], td: ['colspan', 'rowspan', 'colwidth'], col: ['span'],
  },
  allowedClasses: { code: [/^language-[a-z0-9+#-]{1,30}$/], pre: [/^language-[a-z0-9+#-]{1,30}$/], span: ['mention'] },
  allowedStyles: {
    p: { 'text-align': [/^(center|right|justify)$/] }, h1: { 'text-align': [/^(center|right|justify)$/] }, h2: { 'text-align': [/^(center|right|justify)$/] },
    h3: { 'text-align': [/^(center|right|justify)$/] }, h4: { 'text-align': [/^(center|right|justify)$/] }, span: { 'font-size': [/^([6-9]|[1-6]\d|7[0-2])(\.\d)?pt$/] },
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['https'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  exclusiveFilter: (frame) => frame.tag === 'input' && frame.attribs.type !== 'checkbox',
  transformTags: {
    a: (tag, attribs) => ({ tagName: tag, attribs: { ...attribs, rel: 'noopener noreferrer nofollow', ...(attribs.target ? { target: '_blank' } : {}) } }),
    img: (tag, attribs) => ({ tagName: tag, attribs: /^(\/api\/v0\/docs\/files\/[0-9a-f-]{36}|https:\/\/)/.test(attribs.src ?? '') ? attribs : { alt: attribs.alt ?? '' } }),
    // DOCS-INTERACTIVE: an interactive block keeps only its kind's checked fields (doc-interactive.ts cleanBlock).
    div: (tag, attribs) => ({ tagName: tag, attribs: blockAttribs(attribs) ?? ((attribs['data-type'] === 'callout'
      ? { 'data-type': 'callout', 'data-tone': ['info', 'tip', 'warning', 'danger'].includes(attribs['data-tone'] ?? '') ? attribs['data-tone']! : 'info' }
      // DOCS-RICH: columns (2 or 3, each a column of blocks) and a toggle's hidden part.
      : attribs['data-type'] === 'columns' ? { 'data-type': 'columns', 'data-count': attribs['data-count'] === '3' ? '3' : '2' }
      : ['column', 'toggle-content', 'page-break'].includes(attribs['data-type'] ?? '') ? { 'data-type': attribs['data-type']! } : {}) as Record<string, string>) }),
    // DOCS-GDOCS: a named colour from the editor's palette only; an indent of 1 to 8 steps.
    span: (tag, attribs) => ({ tagName: tag, attribs: namedColour(attribs) }),
    mark: (tag, attribs) => ({ tagName: tag, attribs: namedColour(attribs) }),
    ...Object.fromEntries(['p', 'h1', 'h2', 'h3', 'h4'].map((t) => [t, (tag: string, attribs: sanitizeHtml.Attributes) => ({ tagName: tag,
      attribs: /^[1-8]$/.test(attribs['data-indent'] ?? '') ? attribs : Object.fromEntries(Object.entries(attribs).filter(([k]) => k !== 'data-indent')) })])),
    details: (tag, attribs) => ({ tagName: tag, attribs: { 'data-type': 'toggle', ...(attribs.open !== undefined ? { open: '' } : {}) } }),
  },
};
const COLOURS = new Set(['grey', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink', 'brown']);
const namedColour = (attribs: sanitizeHtml.Attributes) => attribs['data-color'] === undefined || COLOURS.has(attribs['data-color'])
  ? attribs : Object.fromEntries(Object.entries(attribs).filter(([k]) => k !== 'data-color'));
export function cleanHtml(html: unknown): string {
  const raw = String(html ?? '');
  if (raw.length > MAX_HTML * 2) fail(413, 'The doc is too long to save (about 1 MB of text at most). Split it into two docs.');
  const out = sanitizeHtml(raw, SANITIZE);
  return out.length > MAX_HTML ? fail(413, 'The doc is too long to save (about 1 MB of text at most). Split it into two docs.') : out;
}
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
/** Plain words of a doc, for search. */
export const textOf = (html: string) => html.replace(/<(br|\/p|\/h[1-4]|\/li|\/tr|\/pre|\/blockquote)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, k: string) => ENTITIES[k] ?? ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 400000);

/** The mentions a body holds: `<span data-type="mention" data-kind=… data-id=… data-label=…>`. */
export function mentionsOf(html: string): { kind: MentionKind; id: string; label: string }[] {
  const seen = new Map<string, { kind: MentionKind; id: string; label: string }>();
  for (const m of html.matchAll(/<span\b[^>]*data-type="mention"[^>]*>/g)) {
    const attr = (k: string) => (m[0].match(new RegExp(`${k}="([^"]*)"`)) ?? [])[1] ?? '';
    const kind = attr('data-kind') as MentionKind, id = attr('data-id');
    if (!(MENTION_KINDS as readonly string[]).includes(kind) || !UUID.test(id)) continue;
    seen.set(`${kind}:${id}`, { kind, id, label: attr('data-label').replace(/&(amp|lt|gt|quot|#39);/g, (_, k: string) => ENTITIES[k] ?? '').slice(0, 200) });
    if (seen.size >= 500) break;
  }
  return [...seen.values()];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const mentionHtml = (kind: string, id: string, label: string) =>
  `<span data-type="mention" data-kind="${esc(kind)}" data-id="${esc(id)}" data-label="${esc(label)}">@${esc(label)}</span>`;
/** Markdown in (from AI employees, the API and imports). `@[Label](task:<id>)` becomes a live mention. */
export function markdownToHtml(md: string): string {
  // DOCS-GDOCS: Markdown as Google Docs, Word and chat answers write it (one paragraph per line, "####" in cells, "****").
  const withMentions = blocksFromMarkdown(tidyMarkdown(String(md ?? ''))).replace(new RegExp(`@\\[([^\\]\\n]{1,200})\\]\\((${MENTION_KINDS.join('|')}):([0-9a-f-]{36})\\)`, 'g'),
    (_, label: string, kind: string, id: string) => mentionHtml(kind, id, label));
  const html = marked.parse(withMentions, { async: false, gfm: true }) as string;
  // GitHub-style checklists ("- [ ] item") become the editor's checklist. DOCS-POLISH: a quote that starts **Info:**,
  // **Note:**, **Tip:**, **Warning:** or **Danger:** is a callout (the form htmlToMarkdown writes one in), so it comes back.
  return html.replace(/<blockquote>\s*<p><strong>(Info|Note|Tip|Warning|Danger):<\/strong>\s*([\s\S]*?)<\/blockquote>/g,
    (_m, tone: string, rest: string) => `<div data-type="callout" data-tone="${tone === 'Note' ? 'info' : tone.toLowerCase()}"><p>${rest.trim()}</div>`)
    .replace(/<ul>\s*(<li><input (?:checked="" )?disabled="" type="checkbox">)/g, '<ul data-type="taskList">$1')
    .replace(/<li><input (checked="" )?disabled="" type="checkbox">\s*/g, (_, on?: string) => `<li data-type="taskItem" data-checked="${on ? 'true' : 'false'}">`);
}

// An interactive block is an empty <div> (its data is in data-block), and turndown sends empty elements to blankReplacement
// before any rule, so the block's fence is written there.
const blockFence = (n: unknown) => {
  const el = n as { nodeName?: string; getAttribute?(k: string): string | null; isBlock?: boolean };
  return el.nodeName === 'DIV' && el.getAttribute?.('data-type') === 'pulse-block' ? `\n\n\`\`\`pulse-block\n${el.getAttribute?.('data-block') ?? '{}'}\n\`\`\`\n\n` : null;
};
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-',
  blankReplacement: (_c, n) => blockFence(n) ?? ((n as unknown as { isBlock?: boolean }).isBlock ? '\n\n' : '') });
turndown.addRule('mention', { filter: (n) => n.nodeName === 'SPAN' && (n as unknown as { getAttribute(k: string): string | null }).getAttribute('data-type') === 'mention',
  replacement: (_c, n) => { const el = n as unknown as { getAttribute(k: string): string | null }; return `@[${el.getAttribute('data-label') ?? ''}](${el.getAttribute('data-kind')}:${el.getAttribute('data-id')})`; } });
turndown.addRule('taskItem', { filter: (n) => n.nodeName === 'LI' && (n as unknown as { getAttribute(k: string): string | null }).getAttribute('data-type') === 'taskItem',
  replacement: (content, n) => `- [${(n as unknown as { getAttribute(k: string): string | null }).getAttribute('data-checked') === 'true' ? 'x' : ' '}] ${content.replace(/^\s+|\s+$/g, '').replace(/\n+/g, ' ')}\n` });
turndown.addRule('checkbox', { filter: (n) => n.nodeName === 'INPUT' || n.nodeName === 'LABEL', replacement: () => '' });
turndown.addRule('callout', { filter: (n) => n.nodeName === 'DIV' && (n as unknown as { getAttribute(k: string): string | null }).getAttribute('data-type') === 'callout',
  replacement: (content, n) => `\n> **${((n as unknown as { getAttribute(k: string): string | null }).getAttribute('data-tone') ?? 'info').replace(/^./, (c) => c.toUpperCase())}:** ${content.trim().replace(/\n/g, '\n> ')}\n\n` });
// DOCS-INTERACTIVE: a block travels as a fenced ```pulse-block {json}``` (agents read and write blocks this way).
turndown.addRule('pulseBlock', { filter: (n) => n.nodeName === 'DIV' && (n as unknown as { getAttribute(k: string): string | null }).getAttribute('data-type') === 'pulse-block',
  replacement: (_c, n) => blockFence(n) ?? '' });
// DOCS-RICH: a toggle and columns keep their shape in Markdown as the same HTML around Markdown (marked reads it back).
const dataType = (n: unknown) => (n as { getAttribute?(k: string): string | null }).getAttribute?.('data-type') ?? null;
turndown.addRule('toggle', { filter: (n) => n.nodeName === 'DETAILS', replacement: (content) => `\n\n<details data-type="toggle">\n${content.trim()}\n\n</div></details>\n\n` });
turndown.addRule('toggleSummary', { filter: (n) => n.nodeName === 'SUMMARY', replacement: (content) => `<summary>${content.replace(/\s+/g, ' ').trim()}</summary><div data-type="toggle-content">\n\n` });
turndown.addRule('toggleContent', { filter: (n) => n.nodeName === 'DIV' && dataType(n) === 'toggle-content', replacement: (content) => `${content.trim()}\n\n` });
turndown.addRule('columns', { filter: (n) => n.nodeName === 'DIV' && dataType(n) === 'columns',
  replacement: (content, n) => `\n\n<div data-type="columns" data-count="${(n as unknown as { getAttribute(k: string): string | null }).getAttribute('data-count') === '3' ? 3 : 2}">\n${content.trim()}\n</div>\n\n` });
turndown.addRule('column', { filter: (n) => n.nodeName === 'DIV' && dataType(n) === 'column', replacement: (content) => `\n<div data-type="column">\n\n${content.trim()}\n\n</div>\n` });
turndown.addRule('table', { filter: 'table', replacement: (_c, n) => {
  type El = { rows?: ArrayLike<{ cells: ArrayLike<{ textContent: string | null }> }> };
  const rows = Array.from((n as unknown as El).rows ?? []).map((r) => Array.from(r.cells).map((c) => (c.textContent ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  return `\n\n${line(rows[0])}\n| ${Array.from({ length: width }, () => '---').join(' | ')} |\n${rows.slice(1).map(line).join('\n')}\n\n`;
} });
/** A doc as Markdown (export, and how AI employees read it). */
export const htmlToMarkdown = (html: string) => turndown.turndown(html || '');

// ------------------------------------------------------------------------------------------------ templates
export const TEMPLATES: Record<string, { title: string; html: string; label: string; category?: string }> = {
  meeting: { label: 'Meeting notes', title: 'Meeting notes', category: 'Meeting notes', html: '<h1>Meeting notes</h1><p><strong>Date:</strong> </p><p><strong>People:</strong> </p>'
    + '<h2>Agenda</h2><ul><li><p></p></li></ul><h2>Notes</h2><p></p><h2>Decisions</h2><ul><li><p></p></li></ul>'
    + '<h2>Actions</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Who does what, by when</p></li></ul>' },
  brief: { label: 'Brief', title: 'Brief', category: 'Brief', html: '<h1>Brief</h1><div data-type="callout" data-tone="info"><p>One sentence: what we are making and for whom.</p></div>'
    + '<h2>Goal</h2><p></p><h2>Audience</h2><p></p><h2>What to deliver</h2><ul><li><p></p></li></ul><h2>Tone and references</h2><p></p>'
    + '<h2>Dates</h2><table><tbody><tr><th><p>Step</p></th><th><p>Date</p></th></tr><tr><td><p>First draft</p></td><td><p></p></td></tr><tr><td><p>Final</p></td><td><p></p></td></tr></tbody></table>' },
  plan: { label: 'Plan', title: 'Plan', category: 'Plan', html: '<h1>Plan</h1><h2>Why</h2><p></p><h2>Outcome we want</h2><p></p><h2>Steps</h2>'
    + '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>First step</p></li><li data-type="taskItem" data-checked="false"><p>Next step</p></li></ul>'
    + '<h2>Risks</h2><div data-type="callout" data-tone="warning"><p>What could go wrong, and what we do then.</p></div><h2>Owner and dates</h2><p></p>' },
  // DOCS-INTERACTIVE: HR documents and proposals in the same format, each ending in an approval someone can be sent.
  proposal: { label: 'Proposal', title: 'Proposal', html: '<h1>Proposal</h1><div data-type="callout" data-tone="info"><p>In one sentence: what you propose and why now.</p></div>'
    + '<h2>The problem</h2><p></p><h2>What we propose</h2><p></p><h2>Cost and time</h2><p></p><h2>Steps</h2>'
    + blockHtml({ kind: 'timeline', id: 'b_tplsteps', title: 'Steps', steps: [{ date: 'Week 1', text: 'Start', done: false }, { date: 'Week 2', text: 'Finish', done: false }] })
    + '<h2>Decision</h2>' + blockHtml({ kind: 'approval', id: 'b_tplprop', question: 'Do you approve this proposal?' }) },
  policy: { label: 'HR policy', title: 'Policy', category: 'Policy', html: '<h1>Policy</h1><p>Version 1 (draft) · Applies to all employees</p><h2>1. Purpose</h2><p>What this policy is for.</p>'
    + '<h2>2. The rules</h2><ul><li><p>A rule</p></li></ul><h2>3. Questions</h2><p>Ask HR in Pulse → My desk → Requests.</p>'
    + blockHtml({ kind: 'approval', id: 'b_tplpolicy', question: 'I have read this policy and I agree to follow it.' }) },
  offer: { label: 'Offer letter', title: 'Offer letter', html: '<h1>Offer letter</h1><p><strong>To:</strong> </p><p><strong>Role:</strong> </p><p><strong>Start date:</strong> </p>'
    + '<h2>Your role</h2><p></p><h2>Pay and benefits</h2><table><tbody><tr><th><p>Item</p></th><th><p>Amount</p></th></tr><tr><td><p>Monthly pay</p></td><td><p></p></td></tr></tbody></table>'
    + '<h2>Before you join</h2>' + blockHtml({ kind: 'checklist', id: 'b_tploffer1', title: 'Before you join', items: ['Send your ID proof', 'Send your bank details', 'Sign this letter'] })
    + '<h2>Your answer</h2>' + blockHtml({ kind: 'approval', id: 'b_tploffer2', question: 'Do you accept this offer?' }) },
  onboarding: { label: 'Onboarding plan', title: 'Onboarding plan', html: '<h1>Onboarding plan</h1><p><strong>New team member:</strong> </p><p><strong>Buddy:</strong> </p>'
    + '<h2>First week</h2>' + blockHtml({ kind: 'checklist', id: 'b_tplonb1', title: 'First week', items: ['Laptop and accounts ready', 'Meet the team', 'Read the HR policies', 'First small task done'] })
    + '<h2>First month</h2>' + blockHtml({ kind: 'timeline', id: 'b_tplonb2', title: 'First month', steps: [{ date: 'Day 1', text: 'Welcome', done: false }, { date: 'Week 2', text: 'First project', done: false }, { date: 'Day 30', text: 'Check-in with your lead', done: false }] })
    + '<h2>Questions for you</h2>' + blockHtml({ kind: 'form', id: 'b_tplonb3', title: 'About you', fields: [{ label: 'What should we call you?', type: 'text' }, { label: 'T-shirt size', type: 'choice', options: ['S', 'M', 'L', 'XL'] }] }) },
};
// DOCS-DRIVE: New ▾ → SOP and Offer (an offer to a client, as the offer-stage docs are written).
TEMPLATES.sop = { label: 'SOP', title: 'SOP', category: 'SOP', html: '<h1>SOP</h1><div data-type="callout" data-tone="info"><p>What this is for, in one sentence.</p></div>'
  + '<p><strong>Owner:</strong> </p><p><strong>When to use it:</strong> </p><h2>Steps</h2><ol><li><p>First step</p></li><li><p>Next step</p></li></ol>'
  + '<h2>Done when</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>How you know it is finished</p></li></ul><h2>If something goes wrong</h2><p></p>' };
TEMPLATES.client_offer = { label: 'Offer to a client', title: 'Offer', category: 'Offer', html: '<h1>Offer</h1><p><strong>For:</strong> </p><p><strong>Stage:</strong> </p>'
  + '<h2>What they need</h2><p></p><h2>What we offer</h2><ul><li><p></p></li></ul><h2>Price</h2><table><tbody><tr><th><p>Item</p></th><th><p>Price</p></th></tr><tr><td><p></p></td><td><p></p></td></tr></tbody></table>'
  + '<h2>Next step</h2>' + blockHtml({ kind: 'approval', id: 'b_tplcoffer', question: 'Is this offer ready to send?' }) };
// DOCS-POLISH (14 Nov 2026): a report and an analysis that start rich (big numbers, a chart, a toggle for the method), for
// an empty doc's "Start with a template" and New ▾. The chart's example numbers say so in its title; the big numbers wait
// for the writer's own (— until typed).
TEMPLATES.report = { label: 'Report', title: 'Report', category: 'Report', html: '<h1>Report</h1><div data-type="callout" data-tone="info"><p>In one sentence: what this report shows.</p></div>'
  + '<h2>Key numbers</h2>' + blockHtml({ kind: 'stat', id: 'b_tplrep1', title: '', items: [{ value: '—', label: 'First number', delta: '', tone: 'neutral' }, { value: '—', label: 'Second number', delta: '', tone: 'neutral' }, { value: '—', label: 'Third number', delta: '', tone: 'neutral' }] })
  + '<h2>What happened</h2><p></p><h2>The numbers</h2><table><tbody><tr><th><p>Item</p></th><th><p>This month</p></th><th><p>Last month</p></th></tr><tr><td><p></p></td><td><p></p></td><td><p></p></td></tr></tbody></table>'
  + '<h2>What we do next</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Who does what, by when</p></li></ul>' };
TEMPLATES.analysis = { label: 'Analysis with charts', title: 'Analysis', category: 'Report', html: '<h1>Analysis</h1><p><strong>The question:</strong> </p>'
  + blockHtml({ kind: 'stat', id: 'b_tplana1', title: '', items: [{ value: '—', label: 'The headline number', delta: '', tone: 'neutral' }, { value: '—', label: 'Compared with', delta: '', tone: 'neutral' }] })
  + '<h2>The trend</h2>' + blockHtml({ kind: 'chart', id: 'b_tplana2', type: 'line', title: 'Example chart: open Edit and type your numbers', unit: '', columns: ['Month', 'This year', 'Last year'], rows: [['Jan', 12, 10], ['Feb', 14, 11], ['Mar', 13, 12], ['Apr', 17, 12]] })
  + '<h2>What it means</h2><p></p><h2>What we do next</h2><ul><li><p></p></li></ul>'
  + '<details data-type="toggle"><summary>How the numbers were worked out</summary><div data-type="toggle-content"><p>Where the numbers come from, and anything left out.</p></div></details>' };
export const TEMPLATE_KEYS = Object.keys(TEMPLATES);

// ------------------------------------------------------------------------------------------------ tags and categories
/** DOCS-MCP (1716): tags are short lowercase words ("offer", "stage 2", "sop"), at most 20 per doc; "#Offer, SOP" works too. */
export function cleanTags(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out = new Set<string>();
  for (const t of raw) {
    const tag = String(t ?? '').normalize('NFC').toLowerCase().replace(/^#+/, '').replace(/[^\p{L}\p{N} ._&+-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
    if (tag && /^[\p{L}\p{N}]/u.test(tag)) out.add(tag);
    if (out.size >= 20) break;
  }
  return [...out];
}
export const cleanCategory = (v: unknown) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || null;
/** Suggested categories (a company may type its own). */
export const CATEGORIES = ['Idea', 'Offer', 'SOP', 'Meeting notes', 'Plan', 'Brief', 'Policy', 'Legal', 'Product', 'Other'];

/** Every tag on the docs the viewer can see, most used first, with when a doc holding it last changed. */
export async function listTags(c: PoolClient) {
  return (await c.query(`select t tag,count(*)::int docs,max(d.updated_at)::text "lastAt" from pulse.doc d cross join lateral unnest(d.tags) t
    where d.archived_at is null group by t order by count(*) desc,t limit 300`)).rows as { tag: string; docs: number; lastAt: string }[];
}
export async function listCategories(c: PoolClient) {
  const used = (await c.query(`select category,count(*)::int docs from pulse.doc where archived_at is null and category is not null group by category order by count(*) desc limit 100`)).rows as { category: string; docs: number }[];
  return [...used, ...CATEGORIES.filter((k) => !used.some((u) => u.category.toLowerCase() === k.toLowerCase())).map((category) => ({ category, docs: 0 }))];
}

// ------------------------------------------------------------------------------------------------ reading
export type DocSummary = { id: string; title: string; folderId: string | null; access: Access; createdBy: string; owner: string | null; updatedAt: string;
  updatedBy: string | null; version: number; archived: boolean; snippet: string | null; tags: string[]; category: string | null; preview: string };
export type Doc = DocSummary & { html: string; companyEdits: boolean; createdAt: string; canEdit: boolean; canShare: boolean };

const SUMMARY = `d.id,d.title,d.folder_id "folderId",d.access,d.created_by "createdBy",o.display_name owner,d.updated_at::text "updatedAt",u.display_name "updatedBy",
  d.version,d.archived_at is not null archived,d.tags,d.category,left(regexp_replace(d.body_text,'\\s+',' ','g'),220) preview`;
const summaryOut = (r: Row): DocSummary => ({ id: String(r.id), title: String(r.title), folderId: (r.folderId as string) ?? null, access: r.access as Access,
  createdBy: String(r.createdBy), owner: (r.owner as string) ?? null, updatedAt: String(r.updatedAt), updatedBy: (r.updatedBy as string) ?? null,
  version: Number(r.version), archived: r.archived === true, snippet: (r.snippet as string) ?? null, tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
  category: (r.category as string) ?? null, preview: String(r.preview ?? '') });

export type DocFilter = { q?: string; folderId?: string | null; mention?: { kind: string; id: string }; archived?: boolean; mine?: boolean; after?: string | null; take?: number;
  /** DOCS-MCP: docs holding every one of these tags; one category. */ tags?: string[]; category?: string | null;
  /** DOCS-DRIVE: shared with me (by others), my Recent (opened or changed by me) or my Starred; one owner; changed between two dates;
   *  anywhere under a folder (its sub-folders too). */
  view?: 'shared' | 'recent' | 'starred' | 'activity' | null; ownerId?: string | null; changedFrom?: string | null; changedTo?: string | null; under?: string | null };
/** DOCS-ACTIVITY: 'activity' is the Docs page's Recent: every doc the viewer can see, newest activity first (an edit, a
 *  comment, a move or share by anyone, or the viewer's own opening of it). API v1 keeps 'recent' (the viewer's own). */
export const DOC_VIEWS = ['shared', 'recent', 'starred', 'activity'] as const;
const day = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null;
/** Docs the viewer may see (row security), newest change first; with q, best match first (title, then words). */
export async function listDocs(c: PoolClient, f: DocFilter): Promise<DocSummary[]> {
  const q = (f.q ?? '').trim().slice(0, 200);
  const take = Math.min(Math.max(f.take ?? 100, 1), 200);
  const r = await c.query(`select ${SUMMARY},
      case when $1::text is null then null else ts_headline('simple',left(d.body_text,20000),websearch_to_tsquery('simple',$1),'MaxWords=18,MinWords=6,StartSel=«,StopSel=»') end snippet
    from pulse.doc d left join pulse.person o on o.id=d.created_by left join pulse.person u on u.id=d.updated_by
    where ($1::text is null or d.search @@ websearch_to_tsquery('simple',$1) or d.title ilike '%'||$2||'%' or lower($1) = any(d.tags))
      and ($3::boolean is false or d.folder_id is not distinct from $4::uuid)
      and ($5::text is null or exists(select 1 from pulse.doc_mention m where m.doc_id=d.id and m.kind=$5 and m.ref_id=$6::uuid)
        or exists(select 1 from pulse.doc_link l where l.doc_id=d.id and l.kind=$5 and l.ref_id=$6::uuid))
      and (d.archived_at is not null)=$7 and ($8::boolean is false or d.created_by=pulse.current_viewer())
      and ($9::uuid is null or d.id>$9)
      and ($11::text[] is null or d.tags @> $11::text[]) and ($12::text is null or lower(d.category)=lower($12))
      and ($13::text is null or ($13='shared' and d.created_by<>pulse.current_viewer() and exists(select 1 from pulse.doc_share s where s.doc_id=d.id and s.person_id=pulse.current_viewer()))
        or ($13='starred' and exists(select 1 from pulse.doc_star s where s.doc_id=d.id))
        or ($13='recent' and (exists(select 1 from pulse.doc_recent r where r.doc_id=d.id) or d.updated_by=pulse.current_viewer())) or $13='activity')
      and ($14::uuid is null or d.created_by=$14) and ($15::date is null or d.updated_at>=$15::date) and ($16::date is null or d.updated_at<$16::date+1)
      and ($17::uuid is null or d.folder_id in (with recursive t(id,hops) as (select $17::uuid,0 union all select f.id,t.hops+1 from pulse.doc_folder f join t on f.parent_id=t.id where t.hops<14) select id from t))
    order by ${f.after !== undefined ? 'd.id' : f.view === 'recent' && !q ? `greatest(coalesce((select r.opened_at from pulse.doc_recent r where r.doc_id=d.id),'-infinity'),case when d.updated_by=pulse.current_viewer() then d.updated_at else '-infinity' end) desc`
      : f.view === 'activity' && !q ? `greatest(d.updated_at,coalesce((select max(k.created_at) from pulse.doc_comment k where k.doc_id=d.id and k.removed_at is null),'-infinity'),
        coalesce((select max(e.at) from pulse.doc_event e where e.doc_id=d.id and e.kind<>'created'),'-infinity'),coalesce((select r.opened_at from pulse.doc_recent r where r.doc_id=d.id),'-infinity')) desc`
      : `case when $1::text is null then 0 else ts_rank(d.search,websearch_to_tsquery('simple',$1)) end desc,d.updated_at desc`}
    limit $10`, [q || null, q.replace(/[\\%_]/g, (m) => `\\${m}`), f.folderId !== undefined, f.folderId ?? null, f.mention?.kind ?? null, f.mention?.id ?? null,
    f.archived === true, f.mine === true, f.after ?? null, take, f.tags?.length ? cleanTags(f.tags) : null, f.category ? cleanCategory(f.category) : null,
    f.view && (DOC_VIEWS as readonly string[]).includes(f.view) ? f.view : null, f.ownerId && UUID.test(f.ownerId) ? f.ownerId : null, day(f.changedFrom), day(f.changedTo),
    f.under && UUID.test(f.under) ? f.under : null]);
  return r.rows.map(summaryOut);
}

export async function getDoc(c: PoolClient, id: string): Promise<Doc> {
  const r = (await c.query(`select ${SUMMARY},d.body_html html,d.company_edits "companyEdits",d.created_at::text "createdAt",
      pulse.doc_can_edit(d.id,d.access,d.created_by,d.company_edits) and d.archived_at is null "canEdit",pulse.doc_id_can_share(d.id) "canShare"
    from pulse.doc d left join pulse.person o on o.id=d.created_by left join pulse.person u on u.id=d.updated_by where d.id=$1`, [docId(id)])).rows[0];
  if (!r) fail(404, 'Doc not found');
  return { ...summaryOut(r), html: String(r.html ?? ''), companyEdits: r.companyEdits === true, createdAt: String(r.createdAt), canEdit: r.canEdit === true, canShare: r.canShare === true };
}

export async function sharesOf(c: PoolClient, id: string) {
  return (await c.query(`select s.person_id "personId",p.display_name name,p.side,s.can_edit "canEdit",s.can_comment or s.can_edit "canComment" from pulse.doc_share s join pulse.person p on p.id=s.person_id
    where s.doc_id=$1 order by p.display_name`, [id])).rows as { personId: string; name: string; side: string; canEdit: boolean; canComment: boolean }[];
}

// ------------------------------------------------------------------------------------------------ writing
async function keepMentions(c: PoolClient, id: string, html: string) {
  await storePages(c, id, html); // DOCS-RICH: pages sent inline, now that the doc row exists
  const list = mentionsOf(html);
  await c.query('delete from pulse.doc_mention where doc_id=$1', [id]);
  if (list.length) await c.query(`insert into pulse.doc_mention(org_id,doc_id,kind,ref_id,label)
    select pulse.current_org(),$1,x.kind,x.id::uuid,x.label from jsonb_to_recordset($2::jsonb) x(kind text,id text,label text) on conflict do nothing`, [id, JSON.stringify(list)]);
}

async function folderOk(c: PoolClient, folderId: unknown): Promise<string | null> {
  if (folderId === null || folderId === undefined || folderId === '') return null;
  const id = anId(folderId, 'a folder');
  if (!(await c.query('select 1 from pulse.doc_folder where id=$1 and archived_at is null', [id])).rowCount) fail(404, 'That folder is not one you can see');
  return id;
}

const cleanTitle = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
/** The body sent: html (sanitised), or markdown, or appendMarkdown (added at the end). */
function bodyFrom(b: Row, old: string | null): string | null {
  // DOCS-RICH: a web page sent inside a block becomes the doc's file (doc-rich.ts); the body keeps its fileId.
  if (typeof b.html === 'string') return cleanHtml(takePagesHtml(b.html));
  if (typeof b.markdown === 'string') return cleanHtml(markdownToHtml(takePagesMarkdown(b.markdown)));
  if (typeof b.appendMarkdown === 'string') return cleanHtml(`${old ?? ''}${markdownToHtml(takePagesMarkdown(b.appendMarkdown))}`);
  return null;
}

/** Make a doc (id null) or change what was sent. Autosave sends baseVersion: a doc changed meanwhile by someone else
 *  answers 409 so the screen reloads instead of overwriting their words. */
export async function saveDoc(c: PoolClient, id: string | null, b: Row, reason: 'edit' | 'import' | 'enrich' = 'edit'): Promise<string> {
  const me: string = (await c.query('select pulse.current_viewer() v')).rows[0]?.v ?? fail(403, 'Sign in with your own account to write docs');
  if (!(await c.query('select pulse.doc_member_ok() v')).rows[0]?.v) fail(403, 'Docs are for the company\'s staff and AI employees');
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  if (reason !== 'edit') await c.query(`select set_config('pulse.doc_save_reason',$1,true)`, [reason]);
  if (!id) {
    const tpl = typeof b.template === 'string' && b.template ? TEMPLATES[b.template] ?? fail(400, `Choose a template: ${TEMPLATE_KEYS.join(', ')}`) : null;
    const html = bodyFrom(b, null) ?? (tpl ? cleanHtml(tpl.html) : '');
    const title = cleanTitle(b.title) || tpl?.title || (html.match(/<h1>(.*?)<\/h1>/)?.[1] ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 200) || 'Untitled';
    const access = has('access') ? (ACCESS as readonly string[]).includes(String(b.access)) ? String(b.access) : fail(400, 'A doc is private, the company\'s or chosen people\'s') : 'private';
    const folderId = await folderOk(c, b.folderId);
    const nid: string = (await c.query(`insert into pulse.doc(org_id,folder_id,title,body_html,body_text,access,company_edits,created_by,tags,category)
      values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [folderId, title, html, textOf(html), access, b.companyEdits !== false, me,
      cleanTags(b.tags), cleanCategory(has('category') ? b.category : tpl?.category)])).rows[0].id;
    await keepMentions(c, nid, html);
    return nid;
  }
  const old = await getDoc(c, id);
  if (!old.canEdit) fail(403, old.archived ? 'This doc is archived; restore it to change it' : 'You can read this doc but not change it');
  if (has('baseVersion') && b.baseVersion !== null && Number(b.baseVersion) !== old.version) {
    fail(409, `${old.updatedBy ?? 'Someone'} changed this doc meanwhile. Reload to see their changes; your last words are still on screen to copy.`);
  }
  const html = bodyFrom(b, old.html) ?? old.html;
  const title = has('title') ? cleanTitle(b.title) || fail(400, 'Give the doc a name') : old.title;
  const folderId = has('folderId') ? await folderOk(c, b.folderId) : old.folderId;
  // DOCS-MCP: tags and category change without a new version (they are labels, not words).
  const tags = has('tags') ? cleanTags(b.tags) : has('addTags') || has('removeTags')
    ? cleanTags([...old.tags, ...cleanTags(b.addTags)].filter((t) => !cleanTags(b.removeTags).includes(t))) : old.tags;
  const category = has('category') ? cleanCategory(b.category) : old.category;
  const r = await c.query(`update pulse.doc set title=$2,body_html=$3,body_text=$4,folder_id=$5,tags=$6,category=$7 where id=$1 returning id`,
    [old.id, title, html, textOf(html), folderId, tags, category]);
  if (!r.rowCount) fail(403, 'You can read this doc but not change it');
  if (html !== old.html) await keepMentions(c, old.id, html);
  return old.id;
}

/** Sharing: private, the company's (everyone edits unless companyEdits false), or chosen people (each reads, comments or
 *  edits: DOCS-DRIVE role view / comment / edit; canEdit alone still works, and a reader comments unless canComment false). */
export async function shareDoc(c: PoolClient, id: string, b: Row) {
  const old = await getDoc(c, id);
  if (!old.canShare) fail(403, 'Only the doc\'s owner (or an admin) changes who it is shared with');
  const access = (ACCESS as readonly string[]).includes(String(b.access ?? old.access)) ? String(b.access ?? old.access) : fail(400, 'A doc is private, the company\'s or chosen people\'s');
  await c.query('update pulse.doc set access=$2,company_edits=$3 where id=$1', [old.id, access, b.companyEdits === undefined ? old.companyEdits : b.companyEdits !== false]);
  if (Array.isArray(b.people)) {
    const people = (b.people as Row[]).slice(0, 200).map((p) => {
      const edit = p.role === 'edit' || (p.role === undefined && p.canEdit === true);
      return { id: anId(p.personId, 'a person'), edit, comment: edit || (p.role === undefined ? p.canComment !== false : p.role === 'comment') };
    }).filter((p) => p.id !== old.createdBy);
    await c.query('delete from pulse.doc_share where doc_id=$1 and not (person_id=any($2::uuid[]))', [old.id, people.map((p) => p.id)]);
    for (const p of people) {
      await c.query(`insert into pulse.doc_share(org_id,doc_id,person_id,can_edit,can_comment,added_by) values(pulse.current_org(),$1,$2,$3,$4,pulse.current_viewer())
        on conflict (doc_id,person_id) do update set can_edit=excluded.can_edit,can_comment=excluded.can_comment`, [old.id, p.id, p.edit, p.comment]);
    }
  }
  return getDoc(c, old.id);
}

export async function archiveDoc(c: PoolClient, id: string, archived: boolean) {
  const old = await getDoc(c, id);
  if (!old.canShare) fail(403, 'Only the doc\'s owner (or an admin) archives it');
  await c.query('update pulse.doc set archived_at=case when $2 then now() else null end where id=$1', [old.id, archived]);
  return getDoc(c, old.id);
}

export async function listVersions(c: PoolClient, id: string) {
  await getDoc(c, id);
  return (await c.query(`select v.id,v.version,v.title,v.reason,v.saved_at::text "savedAt",v.started_at::text "startedAt",p.display_name "savedBy",length(v.body_html) size
    from pulse.doc_version v left join pulse.person p on p.id=v.saved_by where v.doc_id=$1 order by v.saved_at desc limit 200`, [docId(id)])).rows;
}
export async function getVersion(c: PoolClient, id: string, versionId: string) {
  const r = (await c.query(`select v.id,v.version,v.title,v.body_html html,v.saved_at::text "savedAt",p.display_name "savedBy" from pulse.doc_version v
    left join pulse.person p on p.id=v.saved_by where v.doc_id=$1 and v.id=$2`, [docId(id), anId(versionId, 'a version')])).rows[0];
  return r ?? fail(404, 'That version is not on this doc');
}
/** Restore: the doc takes that version's words; the restore itself becomes a new version, so nothing is lost. */
export async function restoreVersion(c: PoolClient, id: string, versionId: string) {
  const v = await getVersion(c, id, versionId);
  const old = await getDoc(c, id);
  if (!old.canEdit) fail(403, 'You can read this doc but not change it');
  await c.query(`select set_config('pulse.doc_save_reason','restore',true)`);
  await c.query('update pulse.doc set title=$2,body_html=$3,body_text=$4 where id=$1', [old.id, v.title, v.html, textOf(String(v.html))]);
  await keepMentions(c, old.id, String(v.html));
  await c.query(`select set_config('pulse.doc_save_reason','',true)`);
  return getDoc(c, old.id);
}

// ------------------------------------------------------------------------------------------------ comments
export async function listComments(c: PoolClient, id: string) {
  await getDoc(c, id);
  return (await c.query(`select k.id,k.body,k.quote,k.person_id "personId",p.display_name who,k.created_at::text "createdAt",k.resolved_at::text "resolvedAt",
      k.person_id=pulse.current_viewer() mine from pulse.doc_comment k join pulse.person p on p.id=k.person_id
    where k.doc_id=$1 and k.removed_at is null order by k.created_at limit 500`, [docId(id)])).rows;
}
export async function addComment(c: PoolClient, id: string, b: Row) {
  const d = await getDoc(c, id);
  // DOCS-DRIVE (1893): a chosen person who may only view reads it but does not comment.
  if (!(await c.query('select pulse.doc_id_can_comment($1) v', [d.id])).rows[0]?.v) fail(403, 'You can read this doc but not comment on it. Ask its owner to let you comment.');
  const body = String(b.body ?? '').trim().slice(0, 4000) || fail(400, 'Write the comment first');
  const quote = typeof b.quote === 'string' && b.quote.trim() ? b.quote.trim().slice(0, 500) : null;
  return (await c.query(`insert into pulse.doc_comment(org_id,doc_id,person_id,body,quote) values(pulse.current_org(),$1,pulse.current_viewer(),$2,$3) returning id`,
    [d.id, body, quote])).rows[0].id as string;
}
export async function setComment(c: PoolClient, id: string, commentId: string, action: 'resolve' | 'reopen' | 'remove') {
  const cid = anId(commentId, 'a comment');
  const sql = action === 'remove' ? 'update pulse.doc_comment set removed_at=now() where id=$1 and doc_id=$2 and person_id=pulse.current_viewer() returning id'
    : `update pulse.doc_comment set resolved_at=${action === 'resolve' ? 'now()' : 'null'},resolved_by=${action === 'resolve' ? 'pulse.current_viewer()' : 'null'} where id=$1 and doc_id=$2 returning id`;
  const r = await c.query(sql, [cid, docId(id)]);
  if (!r.rowCount) fail(403, action === 'remove' ? 'You take back only your own comments' : 'You resolve comments on docs you may change');
}

// ------------------------------------------------------------------------------------------------ folders and files
export type FolderOut = { id: string; name: string; parentId: string | null; createdBy: string; canEdit: boolean; docs: number; files: number; access: 'company' | 'people'; canShare: boolean;
  people: { personId: string; name: string }[] };
/** DOCS-MCP (1716): each folder says who it is for: the company's, or private to chosen people (its maker always included). */
export async function listFolders(c: PoolClient): Promise<FolderOut[]> {
  return (await c.query(`select f.id,f.name,f.parent_id "parentId",f.created_by "createdBy",(f.created_by=pulse.current_viewer() or pulse.viewer_is('admin','leadership')) "canEdit",
      (select count(*) from pulse.doc d where d.folder_id=f.id and d.archived_at is null)::int docs,
      (select count(*) from pulse.doc_file x where x.folder_id=f.id and x.doc_id is null and x.archived_at is null)::int files,f.access,pulse.doc_folder_can_share(f.id) "canShare",
      case when f.access='people' then coalesce((select json_agg(json_build_object('personId',p.id,'name',p.display_name) order by p.display_name)
        from pulse.person p where p.id=f.created_by or p.id in (select s.person_id from pulse.doc_folder_share s where s.folder_id=f.id)),'[]'::json) else '[]'::json end people
    from pulse.doc_folder f where f.archived_at is null order by lower(f.name) limit 1000`)).rows as FolderOut[];
}
/** A private folder's chosen people (its maker is always in). Only the maker, or an admin who can see it, changes them. */
async function setFolderPeople(c: PoolClient, id: string, access: unknown, people: unknown) {
  if (access === undefined && people === undefined) return;
  if (!(await c.query('select pulse.doc_folder_can_share($1) v', [id])).rows[0]?.v) fail(403, 'Only the folder\'s maker (or an admin) changes who it is for');
  if (access !== undefined) {
    if (access !== 'company' && access !== 'people') fail(400, 'A folder is for the whole company or for chosen people');
    await c.query('update pulse.doc_folder set access=$2 where id=$1', [id, access]);
  }
  if (Array.isArray(people)) {
    const ids = [...new Set(people.slice(0, 200).map((p) => anId(typeof p === 'object' && p ? (p as Row).personId : p, 'a person')))];
    await c.query('delete from pulse.doc_folder_share where folder_id=$1 and not (person_id=any($2::uuid[]))', [id, ids]);
    await c.query(`insert into pulse.doc_folder_share(org_id,folder_id,person_id,added_by)
      select pulse.current_org(),$1,p.id,pulse.current_viewer() from pulse.person p where p.id=any($2::uuid[]) and p.side in ('staff','agent')
        and p.id<>(select created_by from pulse.doc_folder where id=$1) on conflict do nothing`, [id, ids]);
  }
}
export async function saveFolder(c: PoolClient, id: string | null, b: Row): Promise<string> {
  if (!(await c.query('select pulse.doc_member_ok() v')).rows[0]?.v) fail(403, 'Docs are for the company\'s staff and AI employees');
  const name = String(b.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const parentId = b.parentId ? await folderOk(c, b.parentId) : null;
  if (!id) {
    if (!name) fail(400, 'Name the folder');
    const nid: string = (await c.query(`insert into pulse.doc_folder(org_id,parent_id,name,created_by,access) values(pulse.current_org(),$1,$2,pulse.current_viewer(),$3) returning id`,
      [parentId, name, b.access === 'people' ? 'people' : 'company'])).rows[0].id;
    if (Array.isArray(b.people)) await setFolderPeople(c, nid, undefined, b.people);
    return nid;
  }
  const fid = anId(id, 'a folder');
  const r = await c.query(`update pulse.doc_folder set name=coalesce(nullif($2,''),name),parent_id=case when $3 then $4::uuid else parent_id end,
      archived_at=case when $5 then now() when $6 then null else archived_at end where id=$1 returning id`, [fid, name, Object.prototype.hasOwnProperty.call(b, 'parentId'), parentId, b.archived === true, b.archived === false]);
  if (!r.rows[0]?.id) fail(403, 'Folders are changed by whoever made them, leadership and admins');
  await setFolderPeople(c, fid, b.access, b.people);
  return fid;
}

export type DocFile = { id: string; name: string; mime: string; size: number; folderId: string | null; docId: string | null; addedBy: string | null; addedAt: string; url: string };
const FILE = `f.id,f.name,f.mime,f.size,f.folder_id "folderId",f.doc_id "docId",p.display_name "addedBy",f.added_at::text "addedAt"`;
const fileOut = (r: Row): DocFile => ({ id: String(r.id), name: String(r.name), mime: String(r.mime), size: Number(r.size), folderId: (r.folderId as string) ?? null,
  docId: (r.docId as string) ?? null, addedBy: (r.addedBy as string) ?? null, addedAt: String(r.addedAt), url: `/api/v0/docs/files/${r.id}` });
export async function listFiles(c: PoolClient, folderId: string | null | undefined, q?: string) {
  return (await c.query(`select ${FILE} from pulse.doc_file f left join pulse.person p on p.id=f.added_by where f.archived_at is null and f.doc_id is null
    and ($1::boolean is false or f.folder_id is not distinct from $2::uuid) and ($3::text is null or f.name ilike '%'||$3||'%') order by f.added_at desc limit 200`,
    [folderId !== undefined, folderId ?? null, q ? q.replace(/[\\%_]/g, (m) => `\\${m}`) : null])).rows.map(fileOut);
}
/** What may be uploaded: no executable or script types; HTML and SVG are kept but only ever shown sandboxed. */
const BLOCKED = /^(application\/(x-msdownload|x-msdos-program|x-sh|x-executable|java-archive|x-dosexec|javascript|ecmascript)|text\/javascript)$/;
export async function addFile(c: PoolClient, b: Row): Promise<DocFile> {
  const name = String(b.name ?? '').replace(/[\\/\u0000-\u001f]+/g, ' ').trim().slice(0, 200) || fail(400, 'Name the file');
  const mime = String(b.mime ?? 'application/octet-stream').toLowerCase().split(';')[0].trim();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) || BLOCKED.test(mime) || /\.(exe|bat|cmd|msi|sh|ps1|js|mjs|jar|scr|com|vbs)$/i.test(name)) fail(415, 'That kind of file cannot be kept in Docs');
  const data = typeof b.data === 'string' ? Buffer.from(b.data, 'base64') : fail(400, 'Send the file');
  if (!data.length) fail(400, 'The file is empty');
  if (data.length > MAX_FILE) fail(413, 'Files in Docs are 10 MB at most');
  const folderId = b.docId ? null : await folderOk(c, b.folderId);
  const docRef = b.docId ? docId(b.docId) : null;
  if (docRef && !(await getDoc(c, docRef)).canEdit) fail(403, 'You can read this doc but not add to it');
  const id: string = (await c.query(`insert into pulse.doc_file(org_id,folder_id,doc_id,name,mime,size,sha256,bytes,added_by)
    values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,pulse.current_viewer()) returning id`,
    [folderId, docRef, name, mime, data.length, createHash('sha256').update(data).digest('hex'), data])).rows[0].id;
  return fileOut((await c.query(`select ${FILE} from pulse.doc_file f left join pulse.person p on p.id=f.added_by where f.id=$1`, [id])).rows[0]);
}

// ------------------------------------------------------------------------------------------------ import
/** A file becomes a doc: Markdown, HTML (sanitised) or Word (.docx, through mammoth). */
export async function importDoc(c: PoolClient, b: Row): Promise<string> {
  const name = String(b.name ?? 'Imported').trim().slice(0, 200);
  const data = typeof b.data === 'string' ? Buffer.from(b.data, 'base64') : fail(400, 'Send the file');
  if (data.length > MAX_IMPORT) fail(413, 'Imports are 5 MB at most');
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  let html: string;
  const pics: { mime: string; data: string }[] = [];
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') html = markdownToHtml(data.toString('utf8'));
  // DOCS-GDOCS: a Google Docs "Web page" download keeps its bold, italics and underline in classes in <head>.
  else if (ext === 'html' || ext === 'htm') html = webPageHtml(data.toString('utf8')).replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '');
  else if (ext === 'docx') {
    try { html = (await mammoth.convertToHtml({ buffer: data }, { convertImage: wordPictures(pics), styleMap: WORD_STYLES })).value.replace(/<img src=""[^>]*>/g, ''); } catch { return fail(400, 'That Word file could not be read. Save it again as .docx and retry.'); }
  } else return fail(415, 'Import a .md, .html or .docx file');
  const title = name.replace(/\.[a-z0-9]+$/i, '') || 'Imported';
  const id = await saveDoc(c, null, { title, html, folderId: b.folderId ?? null }, 'import');
  // DOCS-GDOCS: a Word file's pictures become the doc's own files (the stored body keeps only https or doc-file pictures,
  // so they used to arrive as empty, broken pictures). Same import version: one person's saves within minutes are one.
  if (pics.length) {
    let body = (await c.query('select body_html from pulse.doc where id=$1', [id])).rows[0]?.body_html as string ?? '';
    for (const [i, p] of pics.entries()) {
      const f = await addFile(c, { docId: id, name: `${title.slice(0, 80)} picture ${i + 1}.${p.mime.split('/')[1].replace('jpeg', 'jpg').replace(/\+.*/, '')}`, mime: p.mime, data: p.data });
      body = body.split(`${PIC_SRC}${i}"`).join(`${f.url}"`);
    }
    await saveDoc(c, id, { html: body }, 'import');
  }
  return id;
}
const PIC_SRC = 'https://word-picture.invalid/';
/** DOCS-GDOCS: Word's Title and Subtitle are headings, and its underline and strike-through stay (mammoth drops them). */
const WORD_STYLES = ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh", 'u => u', 'strike => s'];
/** Word's pictures (PNG, JPEG, GIF, WebP; 10 MB and 40 at most) wait under a placeholder address until the doc exists. */
function wordPictures(pics: { mime: string; data: string }[]) {
  return mammoth.images.imgElement(async (img) => {
    const mime = String(img.contentType ?? '').toLowerCase();
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mime) || pics.length >= 40) return { src: '' };
    const data = await img.readAsBase64String();
    if (data.length * 0.75 > MAX_FILE) return { src: '' };
    pics.push({ mime, data });
    return { src: `${PIC_SRC}${pics.length - 1}` };
  });
}

/** DOCS-MCP: a Markdown file's front matter (`---` … `---` at the top): title, tags and category, as Claude and Obsidian
 *  write them. Only these simple keys are read; the rest of the block is dropped from the body. */
export function frontMatter(md: string): { body: string; title?: string; tags?: string[]; category?: string } {
  const m = md.match(/^﻿?---[ \t]*\r?\n([\s\S]{0,4000}?)\r?\n---[ \t]*(\r?\n|$)/);
  if (!m) return { body: md };
  const out: { body: string; title?: string; tags?: string[]; category?: string } = { body: md.slice(m[0].length) };
  const lines = m[1].split(/\r?\n/);
  const unq = (v: string) => v.trim().replace(/^["']|["']$/g, '').trim();
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase(), val = kv[2].trim();
    if (key === 'title' && val) out.title = unq(val).slice(0, 200);
    else if ((key === 'category' || key === 'type') && val) out.category = unq(val);
    else if (key === 'tags' || key === 'tag') {
      if (val.startsWith('[')) out.tags = cleanTags(val.replace(/^\[|\]$/g, '').split(',').map(unq));
      else if (val) out.tags = cleanTags(val.split(/[,]/).map(unq));
      else { const list: string[] = []; while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) list.push(unq(lines[++i].replace(/^\s*-\s+/, ''))); out.tags = cleanTags(list); }
    }
  }
  return out;
}

export type TreeItem = { path: string; data?: string; markdown?: string };
export type TreeResult = { created: number; updated: number; folders: number; skipped: { path: string; why: string }[]; docs: { id: string; title: string; path: string; action: 'created' | 'updated' }[] };
const TREE_EXT = /\.(md|markdown|txt|html?|docx)$/i;
/** DOCS-MCP: import a folder tree (a zip or a folder picked on the computer, or files an AI sends): every folder on the
 *  path is found or made under `folderId`, and each file becomes a doc there. With replace (the default) a doc of the
 *  same name already in that folder takes the new words instead of a copy being made, so importing the same folder
 *  again updates it (the old words stay in its history). At most 100 files and 20 MB per call. */
export async function importTree(c: PoolClient, b: Row): Promise<TreeResult> {
  const items = Array.isArray(b.items) ? (b.items as Row[]) : fail(400, 'Send the files to import');
  if (!items.length) fail(400, 'There are no files to import');
  if (items.length > 100) fail(413, 'Import at most 100 files at a time');
  const replace = b.replace !== false;
  const root = await folderOk(c, b.folderId);
  const result: TreeResult = { created: 0, updated: 0, folders: 0, skipped: [], docs: [] };
  const folders = new Map<string, string | null>([['', root]]);
  let total = 0;
  const folderFor = async (parts: string[]): Promise<string | null> => {
    let key = '', parent = root;
    for (const name of parts) {
      key += `/${name.toLowerCase()}`;
      if (folders.has(key)) { parent = folders.get(key)!; continue; }
      const found = (await c.query(`select id from pulse.doc_folder where archived_at is null and parent_id is not distinct from $1 and lower(name)=lower($2) order by created_at limit 1`,
        [parent, name])).rows[0]?.id as string | undefined;
      const id = found ?? await saveFolder(c, null, { name, parentId: parent });
      if (!found) result.folders++;
      folders.set(key, id); parent = id;
    }
    return parent;
  };
  for (const it of items) {
    const path = String(it.path ?? '').replace(/\\/g, '/').slice(0, 600);
    const parts = path.split('/').map((p) => p.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()).filter((p) => p && p !== '.');
    const file = parts.pop() ?? '';
    if (!file || parts.includes('..') || parts.some((p) => p.startsWith('.') || p === '__MACOSX') || file.startsWith('.')) { result.skipped.push({ path, why: 'hidden or system file' }); continue; }
    if (!TREE_EXT.test(file)) { result.skipped.push({ path, why: 'not a .md, .txt, .html or .docx file' }); continue; }
    if (parts.length > 8) { result.skipped.push({ path, why: 'more than 8 folders deep' }); continue; }
    const data = typeof it.data === 'string' ? Buffer.from(it.data, 'base64') : typeof it.markdown === 'string' ? Buffer.from(it.markdown, 'utf8') : null;
    if (!data) { result.skipped.push({ path, why: 'empty' }); continue; }
    if (data.length > MAX_IMPORT) { result.skipped.push({ path, why: 'bigger than 5 MB' }); continue; }
    total += data.length;
    if (total > 20 * 1024 * 1024) fail(413, 'Import at most 20 MB at a time; send the rest in another import');
    const ext = (file.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
    let html: string, meta: ReturnType<typeof frontMatter> = { body: '' };
    if (ext === 'docx') {
      try { html = (await mammoth.convertToHtml({ buffer: data })).value; } catch { result.skipped.push({ path, why: 'the Word file could not be read' }); continue; }
    } else if (ext === 'html' || ext === 'htm') html = data.toString('utf8').replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '');
    else { meta = frontMatter(data.toString('utf8')); html = markdownToHtml(meta.body); }
    const title = (meta.title || file.replace(TREE_EXT, '')).replace(/\s+/g, ' ').trim().slice(0, 200) || 'Imported';
    const folderId = await folderFor(parts.map((p) => p.slice(0, 120)));
    const labels = { ...(meta.tags ? { tags: meta.tags } : {}), ...(meta.category ? { category: meta.category } : {}) };
    const same = replace ? (await c.query(`select id from pulse.doc where archived_at is null and folder_id is not distinct from $1 and lower(title)=lower($2)
        and pulse.doc_can_edit(id,access,created_by,company_edits) order by updated_at desc limit 1`, [folderId, title])).rows[0]?.id as string | undefined : undefined;
    const id = same ? await saveDoc(c, same, { html, ...labels }, 'import') : await saveDoc(c, null, { title, html, folderId, access: b.access === 'private' ? 'private' : 'company', ...labels }, 'import');
    if (same) result.updated++; else result.created++;
    result.docs.push({ id, title, path, action: same ? 'updated' : 'created' });
  }
  return result;
}

// ------------------------------------------------------------------------------------------------ mentions
export type MentionHit = { kind: MentionKind; id: string; label: string; sub: string | null };
const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
const SEARCH: Record<MentionKind, string> = {
  person: `select id,display_name label,null sub from pulse.person where side='staff' and status='active' and display_name ilike $1 order by display_name limit $2`,
  agent: `select id,display_name label,'AI employee' sub from pulse.person where side='agent' and status='active' and display_name ilike $1 order by display_name limit $2`,
  task: `select id,title label,status sub from pulse.task where title ilike $1 and status<>'cancelled' order by coalesce(updated_at,created_at) desc nulls last limit $2`,
  project: `select id,coalesce(title,name) label,status sub from pulse.project where coalesce(title,name) ilike $1 order by updated_at desc limit $2`,
  goal: `select id,title label,status sub from pulse.goal where title ilike $1 order by status<>'active',created_at desc limit $2`,
  contract: `select id,title label,status sub from pulse.contract where title ilike $1 order by created_at desc limit $2`,
  client: `select id,display_name label,status sub from pulse.client where display_name ilike $1 order by display_name limit $2`,
  file: `select id,name label,mime sub from pulse.doc_file where name ilike $1 and archived_at is null order by added_at desc limit $2`,
  doc: `select id,title label,access sub from pulse.doc where title ilike $1 and archived_at is null order by updated_at desc limit $2`,
};
/** What may be mentioned, as the viewer sees it (each table's own row security). A kind the viewer cannot read is skipped. */
export async function searchMentions(c: PoolClient, q: string, kinds: MentionKind[] = [...MENTION_KINDS], take = 5): Promise<MentionHit[]> {
  const out: MentionHit[] = [];
  for (const kind of kinds) {
    await c.query('savepoint doc_mention_search');
    try {
      const rows = (await c.query(SEARCH[kind], [like(q.trim().slice(0, 80)), take])).rows;
      out.push(...rows.map((r) => ({ kind, id: String(r.id), label: String(r.label ?? ''), sub: r.sub ? String(r.sub) : null })));
      await c.query('release savepoint doc_mention_search');
    } catch { await c.query('rollback to savepoint doc_mention_search'); }
  }
  return out;
}
const RESOLVE: Record<MentionKind, string> = {
  person: `select id,display_name label,case when status='active' then null else 'left' end sub from pulse.person`,
  agent: `select id,display_name label,case when status='active' then 'AI employee' else 'paused' end sub from pulse.person`,
  task: 'select id,title label,status sub from pulse.task', project: 'select id,coalesce(title,name) label,status sub from pulse.project',
  goal: 'select id,title label,status sub from pulse.goal', contract: 'select id,title label,status sub from pulse.contract',
  client: 'select id,display_name label,status sub from pulse.client', file: 'select id,name label,mime sub from pulse.doc_file',
  doc: `select id,title label,case when archived_at is null then access else 'archived' end sub from pulse.doc`,
};
const HREF: Record<MentionKind, (id: string) => string> = { person: (id) => `/people/${id}`, agent: (id) => `/people/${id}`, task: (id) => `/tasks/${id}`,
  project: (id) => `/projects/${id}`, goal: (id) => `/goals/${id}`, contract: (id) => `/contracts/${id}`, client: (id) => `/clients/${id}`,
  file: (id) => `/api/v0/docs/files/${id}`, doc: (id) => `/docs/${id}` };
/** Live chips: each mention's name and state now (renamed, done, archived), or hidden when the viewer cannot see it. */
export async function resolveMentions(c: PoolClient, items: { kind: string; id: string }[]) {
  const out: (MentionHit & { href: string; hidden: boolean; mime?: string })[] = [];
  const want = items.filter((x) => (MENTION_KINDS as readonly string[]).includes(x.kind) && UUID.test(x.id)).slice(0, 300);
  for (const kind of MENTION_KINDS) {
    const ids = [...new Set(want.filter((x) => x.kind === kind).map((x) => x.id))];
    if (!ids.length) continue;
    await c.query('savepoint doc_mention_resolve');
    let found: Row[] = [];
    try {
      found = (await c.query(`${RESOLVE[kind]} where id=any($1::uuid[])`, [ids])).rows;
      await c.query('release savepoint doc_mention_resolve');
    } catch { await c.query('rollback to savepoint doc_mention_resolve'); found = []; }
    const by = new Map(found.map((r) => [String(r.id), r]));
    for (const id of ids) {
      const r = by.get(id);
      out.push({ kind, id, label: r ? String(r.label ?? '') : 'Hidden from you', sub: r?.sub ? String(r.sub) : null, href: HREF[kind](id), hidden: !r,
        ...(kind === 'file' && r ? { mime: String(r.sub ?? '') } : {}) });
    }
  }
  return out;
}

/** DOCS-MCP: the docs a chat message tags (a /docs/<id> link or @[Title](doc:<id>)), for an AI employee's prompt: read as
 *  that AI employee, so only the docs it may see come back (row security), each as Markdown cut at 8,000 characters. */
export async function docsForPrompt(c: PoolClient, ids: string[]) {
  const list = ids.filter((x) => UUID.test(x)).slice(0, 5);
  if (!list.length) return [];
  const rows = (await c.query(`select id,title,tags,category,body_html html,updated_at::text "updatedAt" from pulse.doc where id=any($1::uuid[]) and archived_at is null order by updated_at desc`, [list])).rows;
  return rows.map((r) => { const md = htmlToMarkdown(String(r.html ?? ''));
    return { id: String(r.id), title: String(r.title), tags: (r.tags as string[]) ?? [], category: (r.category as string) ?? null, updatedAt: String(r.updatedAt),
      markdown: md.length > 8000 ? `${md.slice(0, 8000)}\n\n[… the rest is in the doc]` : md }; });
}

/** Docs that mention something (a task's, project's, goal's … page shows them). */
/** DOCS-INTERACTIVE: a task's, project's or goal's docs are the linked ones (its brief first) and the ones that mention it. */
export const backlinks = (c: PoolClient, kind: string, id: string): Promise<{ id: string; title: string; updatedBy: string | null; role?: string | null }[]> =>
  ['task', 'project', 'goal'].includes(kind) ? docsFor(c, kind, id)
    : (MENTION_KINDS as readonly string[]).includes(kind) && UUID.test(id) ? listDocs(c, { mention: { kind, id }, take: 50 }) : Promise.resolve([]);

// ------------------------------------------------------------------------------------------------ screens
type Body = Record<string, unknown>;
const body = { type: 'object' } as const;
// ------------------------------------------------------------------------------------------------ DOCS-POLISH: richer
/** What "Make this doc richer" would change in a doc (doc-richer.ts; nothing is saved). Only its editors are offered it. */
export async function richerOf(c: PoolClient, id: string) {
  const doc = await getDoc(c, id);
  const { suggestRicher } = await import('./doc-richer.js');
  const r = doc.canEdit ? suggestRicher(doc.html) : { suggestions: [], kept: { tables: 0 } };
  return { version: doc.version, canEdit: doc.canEdit, ...r };
}
/** Make the chosen upgrades (ids from richerOf, or 'all' for the ones that start ticked) and keep them as their own History
 *  version, so one Restore undoes them. `undo` is the version to restore for that. */
export async function makeRicher(c: PoolClient, id: string, apply: string[] | 'all', baseVersion?: unknown) {
  const old = await getDoc(c, id);
  if (!old.canEdit) fail(403, old.archived ? 'This doc is archived; restore it to change it' : 'You can read this doc but not change it');
  if (baseVersion !== undefined && baseVersion !== null && Number(baseVersion) !== old.version) {
    fail(409, `${old.updatedBy ?? 'Someone'} changed this doc meanwhile. Look at the upgrades again.`);
  }
  if (apply !== 'all' && !apply.length) fail(400, 'Choose at least one upgrade');
  const { applyRicher } = await import('./doc-richer.js');
  const r = applyRicher(old.html, apply);
  if (r.missing.length) fail(409, 'The doc changed since you looked. Look at the upgrades again.');
  if (!r.applied.length) return { applied: [], version: old.version, html: old.html, undo: null };
  const undo: string | null = (await c.query('select id from pulse.doc_version where doc_id=$1 order by saved_at desc limit 1', [old.id])).rows[0]?.id ?? null;
  await saveDoc(c, old.id, { html: r.html, baseVersion: old.version }, 'enrich');
  const doc = await getDoc(c, old.id);
  return { applied: r.applied, version: doc.version, html: doc.html, undo };
}

export function registerDocRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  registerDocInteractiveRoutes(app, { tx }, { saveDoc: (c, id, b) => saveDoc(c, id, b), brief: TEMPLATES.brief.html });
  // DOCS-EXPORT: a doc as a PDF, Word or Markdown file, for whoever may open it (doc-export.ts).
  registerDocExportRoutes(app, { tx }, { getDoc, htmlToMarkdown });
  // The Docs page: folders, the docs and files in the folder chosen (or found by search), and the templates.
  app.get<{ Querystring: Record<string, string> }>('/api/v0/docs', req => tx(req, async c => {
    const q = req.query;
    const folderId = q.folder === 'root' ? null : q.folder && UUID.test(q.folder) ? q.folder : undefined;
    const searching = !!(q.q && q.q.trim());
    const tag = q.tag ? cleanTags([q.tag]) : [];
    // DOCS-DRIVE: Shared with me / Recent / Starred, and search filters (type = category, owner, changed from/to, under a folder).
    const view = (DOC_VIEWS as readonly string[]).includes(String(q.view)) ? q.view as DocFilter['view'] : null;
    const filtered = searching || tag.length > 0 || !!view || !!q.owner || !!q.from || !!q.to || !!q.category;
    const [docs, folders, files, me, tags, categories, stars, owners] = await Promise.all([
      listDocs(c, { q: q.q, folderId: filtered ? undefined : folderId, archived: q.archived === '1', mine: q.mine === '1', tags: tag, category: q.category || null,
        view, ownerId: q.owner || null, changedFrom: q.from || null, changedTo: q.to || null, under: filtered && q.folder && UUID.test(q.folder) ? q.folder : null, take: 200 }),
      listFolders(c), tag.length || view || q.archived === '1' || (filtered && !searching) ? Promise.resolve([]) : listFiles(c, searching ? undefined : folderId ?? undefined, searching ? q.q : undefined),
      c.query(`select pulse.current_viewer() me,pulse.doc_member_ok() ok,pulse.viewer_is('admin') admin`).then((r) => r.rows[0]), listTags(c), listCategories(c),
      c.query('select doc_id::text d,folder_id::text f from pulse.doc_star order by starred_at desc limit 500').then((r) => ({ docs: r.rows.filter((x) => x.d).map((x) => x.d as string), folders: r.rows.filter((x) => x.f).map((x) => x.f as string) })),
      c.query(`select distinct p.id::text id,p.display_name name from pulse.doc d join pulse.person p on p.id=d.created_by where d.archived_at is null order by p.display_name limit 100`).then((r) => r.rows as { id: string; name: string }[])]);
    if (!me?.ok) fail(403, 'Docs are for the company\'s staff and AI employees');
    const archivedFolders = q.archived === '1' ? (await c.query(`select id::text id,name,parent_id::text "parentId",(created_by=pulse.current_viewer() or pulse.viewer_is('admin','leadership')) "canEdit"
      from pulse.doc_folder where archived_at is not null order by archived_at desc limit 100`)).rows : [];
    // DOCS-ACTIVITY: each doc's last editor and latest activity, each folder's latest activity under it (the viewer's own
    // row security decides what counts); newest activity first, except a word search (best match first) and Recent (its
    // own order, the viewer's openings included).
    const [acts, folderActs, opened] = await Promise.all([docActivity(c, docs.map((d) => d.id)), folderActivity(c, folders),
      c.query('select doc_id::text d,opened_at::text at from pulse.doc_recent where doc_id=any($1::uuid[])', [docs.map((d) => d.id)]).then((r) => new Map(r.rows.map((x) => [x.d as string, x.at as string])))]);
    const docsOut = docs.map((d) => { const a = acts.get(d.id); return { ...d, activity: a?.last ?? null, editedBy: a?.editedBy ?? null, editedAt: a?.editedAt ?? d.updatedAt, editVia: a?.editVia ?? null,
      editViaLabel: a?.editViaLabel ?? null, madeVia: a?.madeVia ?? null, madeViaLabel: a?.madeViaLabel ?? null, openedAt: opened.get(d.id) ?? null }; });
    const foldersOut = byActivity(folders.map((x) => ({ ...x, activity: folderActs.get(x.id) ?? null })));
    // CI-GREEN-6: 'recent' and 'activity' keep the order their query gave (the viewer's own openings and changes; newest
    // activity with the viewer's openings); re-sorting 'recent' by others' activity put an older edit above the doc just opened.
    return { docs: searching || view === 'activity' || view === 'recent' ? docsOut : byActivity(docsOut), folders: foldersOut, files, me: me.me, admin: me.admin === true, templates: Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label })), tags, categories,
      starred: stars, owners, archivedFolders };
  }));
  app.post<{ Body: Body }>('/api/v0/docs', { schema: { body }, bodyLimit: 2_200_000 }, req => tx(req, async c => ({ doc: await getDoc(c, await saveDoc(c, null, req.body ?? {})) })));
  app.post<{ Body: Body }>('/api/v0/docs/import', { schema: { body }, bodyLimit: 7_200_000 }, req => tx(req, async c => ({ doc: await getDoc(c, await importDoc(c, req.body ?? {})) })));
  // DOCS-MCP: a zip or a folder from the computer, sent by the page in batches (the folder tree is kept).
  app.post<{ Body: Body }>('/api/v0/docs/import-tree', { schema: { body }, bodyLimit: 28_000_000 }, req => tx(req, async c => importTree(c, req.body ?? {})));
  // DOCS-POLISH: a template's words, for an empty doc's "Start with a template" (the same templates as New ▾).
  app.get<{ Params: { key: string } }>('/api/v0/docs/templates/:key', req => tx(req, async () => {
    const t = TEMPLATES[String(req.params.key)] ?? fail(404, 'No template by that name');
    return { key: req.params.key, title: t.title, category: t.category ?? null, html: cleanHtml(t.html) };
  }));
  app.get<{ Querystring: Record<string, string> }>('/api/v0/docs/mentions', req => tx(req, async c => {
    const kinds = (String(req.query.kinds ?? '').split(',').filter((k) => (MENTION_KINDS as readonly string[]).includes(k)) as MentionKind[]);
    return { items: await searchMentions(c, String(req.query.q ?? ''), kinds.length ? kinds : undefined, 5) };
  }));
  app.post<{ Body: Body }>('/api/v0/docs/resolve', { schema: { body } }, req => tx(req, async c =>
    ({ items: await resolveMentions(c, Array.isArray(req.body?.items) ? (req.body.items as Row[]).map((x) => ({ kind: String(x.kind), id: String(x.id) })) : []) })));
  app.get<{ Querystring: Record<string, string> }>('/api/v0/docs/backlinks', req => tx(req, async c => ({ docs: await backlinks(c, String(req.query.kind ?? ''), String(req.query.id ?? '')) })));
  app.post<{ Body: Body }>('/api/v0/docs/folders', { schema: { body } }, req => tx(req, async c => ({ id: await saveFolder(c, null, req.body ?? {}), folders: await listFolders(c) })));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/docs/folders/:id', { schema: { body } }, req => tx(req, async c => ({ id: await saveFolder(c, req.params.id, req.body ?? {}), folders: await listFolders(c) })));
  app.post<{ Body: Body }>('/api/v0/docs/files', { schema: { body }, bodyLimit: 14_200_000 }, req => tx(req, async c => ({ file: await addFile(c, req.body ?? {}) })));
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/v0/docs/files/:id', async (req, reply) => {
    const file = await tx(req, async c => (await c.query('select name,mime,bytes from pulse.doc_file where id=$1', [anId(req.params.id, 'a file')])).rows[0]);
    if (!file) fail(404, 'File unavailable');
    // Never run on the app's origin: HTML, SVG and anything not plainly a picture, sound, video or PDF is a download, sandboxed.
    const inline = req.query.download !== '1' && /^(application\/pdf|image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|ogg)|audio\/(mpeg|mp4|ogg|wav|webm|x-m4a))$/.test(file.mime);
    return sendFile(reply, file, inline);
  });
  app.post<{ Params: { id: string } }>('/api/v0/docs/files/:id/archive', req => tx(req, async c => {
    const r = await c.query('update pulse.doc_file set archived_at=now() where id=$1 and archived_at is null returning id', [anId(req.params.id, 'a file')]);
    return r.rowCount ? { ok: true } : fail(403, 'Files are archived by whoever added them, the doc\'s editors and admins');
  }));
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/v0/docs/:id', req => tx(req, async c => {
    const doc = await getDoc(c, req.params.id);
    if (req.query.format === 'markdown') return { doc: { ...doc, html: undefined }, markdown: htmlToMarkdown(doc.html) };
    // DOCS-DRIVE: opening a doc puts it at the top of the viewer's Recent (their own row; never fails the page).
    await c.query('savepoint doc_recent_note');
    try {
      await c.query(`insert into pulse.doc_recent(org_id,person_id,doc_id) values(pulse.current_org(),pulse.current_viewer(),$1) on conflict (person_id,doc_id) do update set opened_at=now()`, [doc.id]);
      await c.query('release savepoint doc_recent_note');
    } catch { await c.query('rollback to savepoint doc_recent_note'); }
    const [shares, comments, files, folders, tags, categories] = await Promise.all([sharesOf(c, doc.id), listComments(c, doc.id),
      c.query(`select ${FILE} from pulse.doc_file f left join pulse.person p on p.id=f.added_by where f.doc_id=$1 and f.archived_at is null order by f.added_at`, [doc.id]).then((r) => r.rows.map(fileOut)),
      listFolders(c), listTags(c), listCategories(c)]);
    // DOCS-MCP: the folder picker and the tag and category suggestions under the title.
    return { doc, shares, comments, files, folders: folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId, access: f.access })), tags: tags.map((t) => t.tag), categories: categories.map((k) => k.category) };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/docs/:id', { schema: { body }, bodyLimit: 2_200_000 }, req => tx(req, async c => {
    const doc = await getDoc(c, await saveDoc(c, docId(req.params.id), req.body ?? {}));
    return { doc: { ...doc, html: undefined }, version: doc.version, updatedAt: doc.updatedAt };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/docs/:id/share', { schema: { body } }, req => tx(req, async c => {
    const doc = await shareDoc(c, docId(req.params.id), req.body ?? {});
    return { doc: { ...doc, html: undefined }, shares: await sharesOf(c, doc.id) };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/docs/:id/archive', { schema: { body } }, req => tx(req, async c =>
    ({ doc: { ...(await archiveDoc(c, docId(req.params.id), req.body?.archived !== false)), html: undefined } })));
  // DOCS-POLISH: "Make this doc richer": what could change (GET) and making the chosen upgrades (POST, its own History version).
  app.get<{ Params: { id: string } }>('/api/v0/docs/:id/richer', req => tx(req, async c => richerOf(c, docId(req.params.id))));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/docs/:id/richer', { schema: { body } }, req => tx(req, async c => {
    const b = req.body ?? {};
    return makeRicher(c, docId(req.params.id), b.apply === 'all' ? 'all' : Array.isArray(b.apply) ? b.apply.map(String).slice(0, 200) : [], b.baseVersion);
  }));
  app.get<{ Params: { id: string } }>('/api/v0/docs/:id/versions', req => tx(req, async c => ({ versions: await listVersions(c, req.params.id) })));
  app.get<{ Params: { id: string; vid: string } }>('/api/v0/docs/:id/versions/:vid', req => tx(req, async c => ({ version: await getVersion(c, req.params.id, req.params.vid) })));
  app.post<{ Params: { id: string; vid: string } }>('/api/v0/docs/:id/versions/:vid/restore', req => tx(req, async c => ({ doc: await restoreVersion(c, docId(req.params.id), req.params.vid) })));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/docs/:id/comments', { schema: { body } }, req => tx(req, async c => {
    await addComment(c, docId(req.params.id), req.body ?? {});
    return { comments: await listComments(c, req.params.id) };
  }));
  app.post<{ Params: { id: string; cid: string; action: string } }>('/api/v0/docs/:id/comments/:cid/:action', req => tx(req, async c => {
    const action = ['resolve', 'reopen', 'remove'].includes(req.params.action) ? req.params.action as 'resolve' : fail(404, 'Not found');
    await setComment(c, docId(req.params.id), req.params.cid, action);
    return { comments: await listComments(c, req.params.id) };
  }));
}

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
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col', 'a', 'img', 'span', 'div', 'label', 'input', 'sub', 'sup'],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'title', 'width', 'height'],
    span: ['data-type', 'data-kind', 'data-id', 'data-label', 'class'], div: ['data-type', 'data-tone'],
    ul: ['data-type'], ol: ['start'], li: ['data-type', 'data-checked'], input: ['type', 'checked', 'disabled'],
    pre: ['class'], code: ['class'], th: ['colspan', 'rowspan', 'colwidth'], td: ['colspan', 'rowspan', 'colwidth'], col: ['span'],
  },
  allowedClasses: { code: [/^language-[a-z0-9+#-]{1,30}$/], pre: [/^language-[a-z0-9+#-]{1,30}$/], span: ['mention'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['https'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  exclusiveFilter: (frame) => frame.tag === 'input' && frame.attribs.type !== 'checkbox',
  transformTags: {
    a: (tag, attribs) => ({ tagName: tag, attribs: { ...attribs, rel: 'noopener noreferrer nofollow', ...(attribs.target ? { target: '_blank' } : {}) } }),
    img: (tag, attribs) => ({ tagName: tag, attribs: /^(\/api\/v0\/docs\/files\/[0-9a-f-]{36}|https:\/\/)/.test(attribs.src ?? '') ? attribs : { alt: attribs.alt ?? '' } }),
    div: (tag, attribs) => ({ tagName: tag, attribs: (attribs['data-type'] === 'callout'
      ? { 'data-type': 'callout', 'data-tone': ['info', 'tip', 'warning', 'danger'].includes(attribs['data-tone'] ?? '') ? attribs['data-tone']! : 'info' } : {}) as Record<string, string> }),
  },
};
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
  const withMentions = String(md ?? '').replace(new RegExp(`@\\[([^\\]\\n]{1,200})\\]\\((${MENTION_KINDS.join('|')}):([0-9a-f-]{36})\\)`, 'g'),
    (_, label: string, kind: string, id: string) => mentionHtml(kind, id, label));
  const html = marked.parse(withMentions, { async: false, gfm: true }) as string;
  // GitHub-style checklists ("- [ ] item") become the editor's checklist.
  return html.replace(/<ul>\s*(<li><input (?:checked="" )?disabled="" type="checkbox">)/g, '<ul data-type="taskList">$1')
    .replace(/<li><input (checked="" )?disabled="" type="checkbox">\s*/g, (_, on?: string) => `<li data-type="taskItem" data-checked="${on ? 'true' : 'false'}">`);
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
turndown.addRule('mention', { filter: (n) => n.nodeName === 'SPAN' && (n as unknown as { getAttribute(k: string): string | null }).getAttribute('data-type') === 'mention',
  replacement: (_c, n) => { const el = n as unknown as { getAttribute(k: string): string | null }; return `@[${el.getAttribute('data-label') ?? ''}](${el.getAttribute('data-kind')}:${el.getAttribute('data-id')})`; } });
turndown.addRule('taskItem', { filter: (n) => n.nodeName === 'LI' && (n as unknown as { getAttribute(k: string): string | null }).getAttribute('data-type') === 'taskItem',
  replacement: (content, n) => `- [${(n as unknown as { getAttribute(k: string): string | null }).getAttribute('data-checked') === 'true' ? 'x' : ' '}] ${content.replace(/^\s+|\s+$/g, '').replace(/\n+/g, ' ')}\n` });
turndown.addRule('checkbox', { filter: (n) => n.nodeName === 'INPUT' || n.nodeName === 'LABEL', replacement: () => '' });
turndown.addRule('callout', { filter: (n) => n.nodeName === 'DIV' && (n as unknown as { getAttribute(k: string): string | null }).getAttribute('data-type') === 'callout',
  replacement: (content, n) => `\n> **${((n as unknown as { getAttribute(k: string): string | null }).getAttribute('data-tone') ?? 'info').replace(/^./, (c) => c.toUpperCase())}:** ${content.trim().replace(/\n/g, '\n> ')}\n\n` });
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
export const TEMPLATES: Record<string, { title: string; html: string; label: string }> = {
  meeting: { label: 'Meeting notes', title: 'Meeting notes', html: '<h1>Meeting notes</h1><p><strong>Date:</strong> </p><p><strong>People:</strong> </p>'
    + '<h2>Agenda</h2><ul><li><p></p></li></ul><h2>Notes</h2><p></p><h2>Decisions</h2><ul><li><p></p></li></ul>'
    + '<h2>Actions</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Who does what, by when</p></li></ul>' },
  brief: { label: 'Brief', title: 'Brief', html: '<h1>Brief</h1><div data-type="callout" data-tone="info"><p>One sentence: what we are making and for whom.</p></div>'
    + '<h2>Goal</h2><p></p><h2>Audience</h2><p></p><h2>What to deliver</h2><ul><li><p></p></li></ul><h2>Tone and references</h2><p></p>'
    + '<h2>Dates</h2><table><tbody><tr><th><p>Step</p></th><th><p>Date</p></th></tr><tr><td><p>First draft</p></td><td><p></p></td></tr><tr><td><p>Final</p></td><td><p></p></td></tr></tbody></table>' },
  plan: { label: 'Plan', title: 'Plan', html: '<h1>Plan</h1><h2>Why</h2><p></p><h2>Outcome we want</h2><p></p><h2>Steps</h2>'
    + '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>First step</p></li><li data-type="taskItem" data-checked="false"><p>Next step</p></li></ul>'
    + '<h2>Risks</h2><div data-type="callout" data-tone="warning"><p>What could go wrong, and what we do then.</p></div><h2>Owner and dates</h2><p></p>' },
};

// ------------------------------------------------------------------------------------------------ reading
export type DocSummary = { id: string; title: string; folderId: string | null; access: Access; createdBy: string; owner: string | null; updatedAt: string;
  updatedBy: string | null; version: number; archived: boolean; snippet: string | null };
export type Doc = DocSummary & { html: string; companyEdits: boolean; createdAt: string; canEdit: boolean; canShare: boolean };

const SUMMARY = `d.id,d.title,d.folder_id "folderId",d.access,d.created_by "createdBy",o.display_name owner,d.updated_at::text "updatedAt",u.display_name "updatedBy",
  d.version,d.archived_at is not null archived`;
const summaryOut = (r: Row): DocSummary => ({ id: String(r.id), title: String(r.title), folderId: (r.folderId as string) ?? null, access: r.access as Access,
  createdBy: String(r.createdBy), owner: (r.owner as string) ?? null, updatedAt: String(r.updatedAt), updatedBy: (r.updatedBy as string) ?? null,
  version: Number(r.version), archived: r.archived === true, snippet: (r.snippet as string) ?? null });

export type DocFilter = { q?: string; folderId?: string | null; mention?: { kind: string; id: string }; archived?: boolean; mine?: boolean; after?: string | null; take?: number };
/** Docs the viewer may see (row security), newest change first; with q, best match first (title, then words). */
export async function listDocs(c: PoolClient, f: DocFilter): Promise<DocSummary[]> {
  const q = (f.q ?? '').trim().slice(0, 200);
  const take = Math.min(Math.max(f.take ?? 100, 1), 200);
  const r = await c.query(`select ${SUMMARY},
      case when $1::text is null then null else ts_headline('simple',left(d.body_text,20000),websearch_to_tsquery('simple',$1),'MaxWords=18,MinWords=6,StartSel=«,StopSel=»') end snippet
    from pulse.doc d left join pulse.person o on o.id=d.created_by left join pulse.person u on u.id=d.updated_by
    where ($1::text is null or d.search @@ websearch_to_tsquery('simple',$1) or d.title ilike '%'||$2||'%')
      and ($3::boolean is false or d.folder_id is not distinct from $4::uuid)
      and ($5::text is null or exists(select 1 from pulse.doc_mention m where m.doc_id=d.id and m.kind=$5 and m.ref_id=$6::uuid))
      and (d.archived_at is not null)=$7 and ($8::boolean is false or d.created_by=pulse.current_viewer())
      and ($9::uuid is null or d.id>$9)
    order by ${f.after !== undefined ? 'd.id' : `case when $1::text is null then 0 else ts_rank(d.search,websearch_to_tsquery('simple',$1)) end desc,d.updated_at desc`}
    limit $10`, [q || null, q.replace(/[\\%_]/g, (m) => `\\${m}`), f.folderId !== undefined, f.folderId ?? null, f.mention?.kind ?? null, f.mention?.id ?? null,
    f.archived === true, f.mine === true, f.after ?? null, take]);
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
  return (await c.query(`select s.person_id "personId",p.display_name name,p.side,s.can_edit "canEdit" from pulse.doc_share s join pulse.person p on p.id=s.person_id
    where s.doc_id=$1 order by p.display_name`, [id])).rows as { personId: string; name: string; side: string; canEdit: boolean }[];
}

// ------------------------------------------------------------------------------------------------ writing
async function keepMentions(c: PoolClient, id: string, html: string) {
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
  if (typeof b.html === 'string') return cleanHtml(b.html);
  if (typeof b.markdown === 'string') return cleanHtml(markdownToHtml(b.markdown));
  if (typeof b.appendMarkdown === 'string') return cleanHtml(`${old ?? ''}${markdownToHtml(b.appendMarkdown)}`);
  return null;
}

/** Make a doc (id null) or change what was sent. Autosave sends baseVersion: a doc changed meanwhile by someone else
 *  answers 409 so the screen reloads instead of overwriting their words. */
export async function saveDoc(c: PoolClient, id: string | null, b: Row, reason: 'edit' | 'import' = 'edit'): Promise<string> {
  const me: string = (await c.query('select pulse.current_viewer() v')).rows[0]?.v ?? fail(403, 'Sign in with your own account to write docs');
  if (!(await c.query('select pulse.doc_member_ok() v')).rows[0]?.v) fail(403, 'Docs are for the company\'s staff and AI employees');
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  if (reason !== 'edit') await c.query(`select set_config('pulse.doc_save_reason',$1,true)`, [reason]);
  if (!id) {
    const tpl = typeof b.template === 'string' && b.template ? TEMPLATES[b.template] ?? fail(400, 'Choose a template: meeting, brief or plan') : null;
    const html = bodyFrom(b, null) ?? (tpl ? cleanHtml(tpl.html) : '');
    const title = cleanTitle(b.title) || tpl?.title || (html.match(/<h1>(.*?)<\/h1>/)?.[1] ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 200) || 'Untitled';
    const access = has('access') ? (ACCESS as readonly string[]).includes(String(b.access)) ? String(b.access) : fail(400, 'A doc is private, the company\'s or chosen people\'s') : 'private';
    const folderId = await folderOk(c, b.folderId);
    const nid: string = (await c.query(`insert into pulse.doc(org_id,folder_id,title,body_html,body_text,access,company_edits,created_by)
      values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7) returning id`, [folderId, title, html, textOf(html), access, b.companyEdits !== false, me])).rows[0].id;
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
  const r = await c.query(`update pulse.doc set title=$2,body_html=$3,body_text=$4,folder_id=$5 where id=$1 returning id`, [old.id, title, html, textOf(html), folderId]);
  if (!r.rowCount) fail(403, 'You can read this doc but not change it');
  if (html !== old.html) await keepMentions(c, old.id, html);
  return old.id;
}

/** Sharing: private, the company's (everyone edits unless companyEdits false), or chosen people (each reads or edits). */
export async function shareDoc(c: PoolClient, id: string, b: Row) {
  const old = await getDoc(c, id);
  if (!old.canShare) fail(403, 'Only the doc\'s owner (or an admin) changes who it is shared with');
  const access = (ACCESS as readonly string[]).includes(String(b.access ?? old.access)) ? String(b.access ?? old.access) : fail(400, 'A doc is private, the company\'s or chosen people\'s');
  await c.query('update pulse.doc set access=$2,company_edits=$3 where id=$1', [old.id, access, b.companyEdits === undefined ? old.companyEdits : b.companyEdits !== false]);
  if (Array.isArray(b.people)) {
    const people = (b.people as Row[]).slice(0, 200).map((p) => ({ id: anId(p.personId, 'a person'), edit: p.canEdit === true })).filter((p) => p.id !== old.createdBy);
    await c.query('delete from pulse.doc_share where doc_id=$1 and not (person_id=any($2::uuid[]))', [old.id, people.map((p) => p.id)]);
    for (const p of people) {
      await c.query(`insert into pulse.doc_share(org_id,doc_id,person_id,can_edit,added_by) values(pulse.current_org(),$1,$2,$3,pulse.current_viewer())
        on conflict (doc_id,person_id) do update set can_edit=excluded.can_edit`, [old.id, p.id, p.edit]);
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
export async function listFolders(c: PoolClient) {
  return (await c.query(`select f.id,f.name,f.parent_id "parentId",f.created_by "createdBy",(f.created_by=pulse.current_viewer() or pulse.viewer_is('admin','leadership')) "canEdit",
      (select count(*) from pulse.doc d where d.folder_id=f.id and d.archived_at is null)::int docs
    from pulse.doc_folder f where f.archived_at is null order by lower(f.name) limit 1000`)).rows as { id: string; name: string; parentId: string | null; canEdit: boolean; docs: number }[];
}
export async function saveFolder(c: PoolClient, id: string | null, b: Row): Promise<string> {
  if (!(await c.query('select pulse.doc_member_ok() v')).rows[0]?.v) fail(403, 'Docs are for the company\'s staff and AI employees');
  const name = String(b.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const parentId = b.parentId ? await folderOk(c, b.parentId) : null;
  if (!id) {
    if (!name) fail(400, 'Name the folder');
    return (await c.query(`insert into pulse.doc_folder(org_id,parent_id,name,created_by) values(pulse.current_org(),$1,$2,pulse.current_viewer()) returning id`, [parentId, name])).rows[0].id;
  }
  const fid = anId(id, 'a folder');
  const r = await c.query(`update pulse.doc_folder set name=coalesce(nullif($2,''),name),parent_id=case when $3 then $4::uuid else parent_id end,
      archived_at=case when $5 then now() else archived_at end where id=$1 returning id`, [fid, name, Object.prototype.hasOwnProperty.call(b, 'parentId'), parentId, b.archived === true]);
  return r.rows[0]?.id ?? fail(403, 'Folders are changed by whoever made them, leadership and admins');
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
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') html = markdownToHtml(data.toString('utf8'));
  else if (ext === 'html' || ext === 'htm') html = data.toString('utf8').replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '');
  else if (ext === 'docx') {
    try { html = (await mammoth.convertToHtml({ buffer: data })).value; } catch { return fail(400, 'That Word file could not be read. Save it again as .docx and retry.'); }
  } else return fail(415, 'Import a .md, .html or .docx file');
  const title = name.replace(/\.[a-z0-9]+$/i, '') || 'Imported';
  return saveDoc(c, null, { title, html, folderId: b.folderId ?? null }, 'import');
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

/** Docs that mention something (a task's, project's, goal's … page shows them). */
export const backlinks = (c: PoolClient, kind: string, id: string) =>
  (MENTION_KINDS as readonly string[]).includes(kind) && UUID.test(id) ? listDocs(c, { mention: { kind, id }, take: 50 }) : Promise.resolve([]);

// ------------------------------------------------------------------------------------------------ screens
type Body = Record<string, unknown>;
const body = { type: 'object' } as const;
export function registerDocRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // The Docs page: folders, the docs and files in the folder chosen (or found by search), and the templates.
  app.get<{ Querystring: Record<string, string> }>('/api/v0/docs', req => tx(req, async c => {
    const q = req.query;
    const folderId = q.folder === 'root' ? null : q.folder && UUID.test(q.folder) ? q.folder : undefined;
    const searching = !!(q.q && q.q.trim());
    const [docs, folders, files, me] = await Promise.all([
      listDocs(c, { q: q.q, folderId: searching ? undefined : folderId, archived: q.archived === '1', mine: q.mine === '1' }),
      listFolders(c), listFiles(c, searching ? undefined : folderId ?? undefined, searching ? q.q : undefined),
      c.query(`select pulse.current_viewer() me,pulse.doc_member_ok() ok,pulse.viewer_is('admin') admin`).then((r) => r.rows[0])]);
    if (!me?.ok) fail(403, 'Docs are for the company\'s staff and AI employees');
    return { docs, folders, files, me: me.me, admin: me.admin === true, templates: Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label })) };
  }));
  app.post<{ Body: Body }>('/api/v0/docs', { schema: { body }, bodyLimit: 2_200_000 }, req => tx(req, async c => ({ doc: await getDoc(c, await saveDoc(c, null, req.body ?? {})) })));
  app.post<{ Body: Body }>('/api/v0/docs/import', { schema: { body }, bodyLimit: 7_200_000 }, req => tx(req, async c => ({ doc: await getDoc(c, await importDoc(c, req.body ?? {})) })));
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
    const [shares, comments, files] = await Promise.all([sharesOf(c, doc.id), listComments(c, doc.id),
      c.query(`select ${FILE} from pulse.doc_file f left join pulse.person p on p.id=f.added_by where f.doc_id=$1 and f.archived_at is null order by f.added_at`, [doc.id]).then((r) => r.rows.map(fileOut))]);
    return { doc, shares, comments, files };
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

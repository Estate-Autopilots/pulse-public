// DOCS-WORKBENCH (owner, 6 Nov 2026): the company's docs over API v1 (area `docs`: docs.read / docs.write), so AI
// employees, MCP clients and the `pulse` CLI read and write docs from the same definitions as the screens (docs.ts).
// Every rule is the database's (doc_can_see / doc_can_edit / doc_id_can_share under forced row security): a key only
// reaches the docs its principal may see, and an AI employee reaches company docs and the docs shared with it.
// Bodies go in and out as Markdown (or sanitised HTML); `@[Label](task:<id>)` is a live mention.
import { addComment, getDoc, htmlToMarkdown, listComments, listDocs, listFolders, listVersions, MENTION_KINDS, saveDoc, saveFolder, sharesOf } from './docs.js';
import { pageResponse, PAGE_QUERY, pageV1 } from './v1-paging.js';
import { defineV1Operation } from './v1.js';
import { bool, int, maybe, maybeId, member, object, qText, str, text, uuid, type Row } from './v1-kit.js';

const ACCESS = { enum: ['private', 'company', 'people'] };
const SUMMARY_FIELDS = { id: uuid, title: str, folderId: maybeId, access: ACCESS, createdBy: uuid, owner: maybe, updatedAt: str, updatedBy: maybe, version: int,
  archived: bool, snippet: maybe };
const SUMMARY = object(SUMMARY_FIELDS);
const DOC = object({ ...SUMMARY_FIELDS, companyEdits: bool, createdAt: str, canEdit: bool, canShare: bool, markdown: str, html: { type: ['string', 'null'] },
  mentions: { type: 'array', items: object({ kind: { enum: [...MENTION_KINDS] }, id: uuid, label: str }) },
  sharedWith: { type: 'array', items: object({ personId: uuid, name: str, side: str, canEdit: bool }) } });
const FOLDER = object({ id: uuid, name: str, parentId: maybeId, canEdit: bool, docs: int });
const COMMENT = object({ id: uuid, body: str, quote: maybe, personId: uuid, who: str, createdAt: str, resolvedAt: maybe, mine: bool });
const VERSION = object({ id: uuid, version: int, title: str, reason: str, savedAt: str, startedAt: str, savedBy: maybe, size: int });
const BODY = { markdown: { type: 'string', maxLength: 500000, description: 'The whole body as Markdown. `@[Label](task:<id>)` (person, agent, task, project, goal, contract, client, file, doc) is a live mention.' },
  html: { type: 'string', maxLength: 1000000, description: 'The whole body as HTML instead of markdown (sanitised: headings, lists, tables, checklists, code, images, callouts).' } };
const MENTIONS = 'Mention with @[Label](kind:id): kind person, agent (an AI employee), task, project, goal, contract, client, file or doc; the id comes from the matching list_ tool.';

async function docOut(ctx: Parameters<typeof member>[0], id: string, withHtml: boolean) {
  const d = await getDoc(ctx.client, id);
  const mentions = (await ctx.client.query('select kind,ref_id::text id,label from pulse.doc_mention where doc_id=$1 order by kind,label', [d.id])).rows;
  return { ...d, html: withHtml ? d.html : null, markdown: htmlToMarkdown(d.html), mentions, sharedWith: await sharesOf(ctx.client, d.id) };
}

defineV1Operation({ operationId: 'listDocs', method: 'GET', path: '/api/v1/docs', scope: 'docs.read',
  summary: 'Docs you can see: search their words, list a folder, or find the docs that mention a task, project, person …',
  query: object({ ...PAGE_QUERY, q: qText(200), folderId: uuid, mentionKind: { enum: [...MENTION_KINDS] }, mentionId: uuid, archived: { enum: ['true', 'false'] } }, []),
  response: pageResponse(SUMMARY),
  mcp: { name: 'list_docs', title: 'List or search docs',
    description: 'Lists the company docs you can see, newest change first. q searches titles and words (best match first, with a snippet); folderId keeps one folder (from list_doc_folders); mentionKind + mentionId lists the docs that mention that task, project, goal, person, contract, client, file or doc (backlinks). archived true lists archived docs. Pages of up to 100 with nextCursor.' },
  handler: async (ctx, input) => {
    await member(ctx);
    const q = input.query;
    const mention = q.mentionKind && q.mentionId ? { kind: String(q.mentionKind), id: String(q.mentionId) } : undefined;
    return pageV1(ctx, 'listDocs', input, (after, take) => listDocs(ctx.client, { q: q.q, folderId: q.folderId, mention, archived: q.archived === 'true', after, take }));
  },
});

defineV1Operation({ operationId: 'getDoc', method: 'GET', path: '/api/v1/docs/{docId}', scope: 'docs.read',
  summary: 'One doc as Markdown (and HTML on request), with what it mentions and who it is shared with',
  params: object({ docId: uuid }),
  query: object({ html: { enum: ['true', 'false'] } }, []),
  response: object({ doc: DOC }),
  mcp: { name: 'get_doc', title: 'Read a doc', description: 'Reads one doc: its title, its body as Markdown (mentions written @[Label](kind:id)), its version (send it back as baseVersion when you update), what it mentions, its sharing, and whether you may change it. html true also returns the stored HTML.' },
  handler: async (ctx, { params, query }) => {
    await member(ctx);
    return { doc: await docOut(ctx, params.docId, query.html === 'true') };
  },
});

defineV1Operation({ operationId: 'createDoc', method: 'POST', path: '/api/v1/docs', scope: 'docs.write',
  summary: 'Write a new doc (from Markdown, HTML or a template), in a folder, private or shared with the company',
  body: object({ title: text(200), folderId: maybeId, ...BODY, template: { enum: ['meeting', 'brief', 'plan'] }, access: { enum: ['private', 'company'] } }, []),
  response: object({ doc: DOC }), authorize: member,
  mcp: { name: 'create_doc', title: 'Write a doc',
    description: `Writes a new doc you own. title; markdown (or html) for the body, or template meeting, brief or plan to start from one; folderId puts it in a folder; access private (default: only you) or company (every staff member and AI employee reads and edits it). ${MENTIONS}` },
  handler: async (ctx, { body }) => ({ doc: await docOut(ctx, await saveDoc(ctx.client, null, body as Row), false) }),
});

defineV1Operation({ operationId: 'updateDoc', method: 'PATCH', path: '/api/v1/docs/{docId}', scope: 'docs.write',
  summary: 'Change a doc: its title, its whole body, or add Markdown at the end; moves it between folders',
  params: object({ docId: uuid }),
  body: object({ title: text(200), folderId: maybeId, ...BODY, appendMarkdown: { type: 'string', maxLength: 200000, description: 'Markdown added at the end of the body.' },
    baseVersion: { type: ['integer', 'null'], description: 'The version you read; if someone changed the doc since, nothing is saved and the answer is 409.' } }, []),
  response: object({ doc: DOC }), authorize: member,
  mcp: { name: 'update_doc', title: 'Change a doc',
    description: `Changes only what is sent: title, markdown (replaces the whole body), appendMarkdown (adds at the end, e.g. a dated note), folderId. Send baseVersion from get_doc so you never overwrite someone's newer words (409 then: read it again). Every change is kept in the doc's version history. ${MENTIONS}`, idempotent: true },
  handler: async (ctx, { params, body }) => ({ doc: await docOut(ctx, await saveDoc(ctx.client, params.docId, body as Row), false) }),
});

defineV1Operation({ operationId: 'listDocFolders', method: 'GET', path: '/api/v1/docs/folders', scope: 'docs.read',
  summary: 'The company\'s doc folders', response: object({ items: { type: 'array', items: FOLDER } }),
  mcp: { name: 'list_doc_folders', title: 'List doc folders', description: 'Lists the doc folders (id, name, parentId for nesting, and how many docs each holds).' },
  handler: async (ctx) => { await member(ctx); return { items: await listFolders(ctx.client) }; },
});

defineV1Operation({ operationId: 'createDocFolder', method: 'POST', path: '/api/v1/docs/folders', scope: 'docs.write',
  summary: 'Make a doc folder (inside another one when parentId is sent)',
  body: object({ name: text(120), parentId: maybeId }, ['name']),
  response: object({ folder: FOLDER }), authorize: member,
  mcp: { name: 'create_doc_folder', title: 'Make a doc folder', description: 'Makes a folder for docs and files; parentId (from list_doc_folders) puts it inside another folder.' },
  handler: async (ctx, { body }) => {
    const id = await saveFolder(ctx.client, null, body as Row);
    return { folder: (await listFolders(ctx.client)).find((f) => f.id === id)! };
  },
});

defineV1Operation({ operationId: 'listDocComments', method: 'GET', path: '/api/v1/docs/{docId}/comments', scope: 'docs.read',
  summary: 'Comments on a doc', params: object({ docId: uuid }), response: object({ items: { type: 'array', items: COMMENT } }),
  mcp: { name: 'list_doc_comments', title: 'Read a doc\'s comments', description: 'Lists the comments on a doc you can see, oldest first, with the words each one quotes and whether it is resolved.' },
  handler: async (ctx, { params }) => { await member(ctx); return { items: await listComments(ctx.client, params.docId) }; },
});

defineV1Operation({ operationId: 'addDocComment', method: 'POST', path: '/api/v1/docs/{docId}/comments', scope: 'docs.write',
  summary: 'Comment on a doc', params: object({ docId: uuid }), body: object({ body: text(4000), quote: { type: 'string', maxLength: 500 } }, ['body']),
  response: object({ items: { type: 'array', items: COMMENT } }), authorize: member,
  mcp: { name: 'add_doc_comment', title: 'Comment on a doc', description: 'Adds a comment to a doc you can see; quote names the words it is about. Answers with all the doc\'s comments.' },
  handler: async (ctx, { params, body }) => {
    await addComment(ctx.client, params.docId, body as Row);
    return { items: await listComments(ctx.client, params.docId) };
  },
});

defineV1Operation({ operationId: 'listDocVersions', method: 'GET', path: '/api/v1/docs/{docId}/versions', scope: 'docs.read',
  summary: 'A doc\'s version history', params: object({ docId: uuid }), response: object({ items: { type: 'array', items: VERSION } }),
  mcp: { name: 'list_doc_versions', title: 'A doc\'s history', description: 'Lists a doc\'s saved versions, newest first: who saved each, when, and why (edit, restore, import, create). People restore one from the doc\'s History.' },
  handler: async (ctx, { params }) => { await member(ctx); return { items: (await listVersions(ctx.client, params.docId)).map((v) => ({ ...v, size: Number(v.size) })) }; },
});

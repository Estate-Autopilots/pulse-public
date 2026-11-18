// DOCS-WORKBENCH (owner, 6 Nov 2026): the company's docs over API v1 (area `docs`: docs.read / docs.write), so AI
// employees, MCP clients and the `pulse` CLI read and write docs from the same definitions as the screens (docs.ts).
// Every rule is the database's (doc_can_see / doc_can_edit / doc_id_can_share under forced row security): a key only
// reaches the docs its principal may see, and an AI employee reaches company docs and the docs shared with it.
// Bodies go in and out as Markdown (or sanitised HTML); `@[Label](task:<id>)` is a live mention.
import { addComment, CATEGORIES, getDoc, htmlToMarkdown, importTree, listCategories, listComments, listDocs, listFolders, listTags, listVersions, makeRicher, MENTION_KINDS, richerOf, saveDoc, saveFolder, shareDoc, sharesOf,
  TEMPLATE_KEYS } from './docs.js';
import { addLink, answerRequest, docReads, linksOf, listRequests, sendDoc } from './doc-interactive.js';
import { bulkItems, cleanItems, moveItems } from './doc-drive.js';
import { BULK_ACTIONS, SHARE_ROLES, type BulkAction } from './doc-drive-lists.js';
import { pageResponse, PAGE_QUERY, pageV1 } from './v1-paging.js';
import { defineV1Operation, v1Fail } from './v1.js';
import { bool, int, maybe, maybeId, member, num, object, qText, str, text, uuid, type Row } from './v1-kit.js';
import { replaceBlock } from './doc-rich.js';

const ACCESS = { enum: ['private', 'company', 'people'] };
const SUMMARY_FIELDS = { id: uuid, title: str, folderId: maybeId, access: ACCESS, createdBy: uuid, owner: maybe, updatedAt: str, updatedBy: maybe, version: int,
  archived: bool, snippet: maybe, tags: { type: 'array', items: str }, category: maybe, preview: str };
const SUMMARY = object(SUMMARY_FIELDS);
const DOC = object({ ...SUMMARY_FIELDS, companyEdits: bool, createdAt: str, canEdit: bool, canShare: bool, markdown: str, html: { type: ['string', 'null'] },
  mentions: { type: 'array', items: object({ kind: { enum: [...MENTION_KINDS] }, id: uuid, label: str }) },
  sharedWith: { type: 'array', items: object({ personId: uuid, name: str, side: str, canEdit: bool, canComment: bool }) },
  links: { type: 'array', items: object({ id: uuid, kind: { enum: ['task', 'project', 'goal'] }, refId: uuid, role: { enum: ['brief', 'related'] }, label: str, sub: maybe, href: str, hidden: bool }) } });
// DOCS-MCP: createdBy is declared too: listFolders has always returned it, and the closed schema refused the whole answer
// (list_doc_folders answered 500 "Pulse data is temporarily unavailable" on pulse-dev, 7 Nov).
const FOLDER = object({ id: uuid, name: str, parentId: maybeId, createdBy: uuid, canEdit: bool, docs: int, files: int, access: { enum: ['company', 'people'] }, canShare: bool,
  people: { type: 'array', items: object({ personId: uuid, name: str }) } });
const COMMENT = object({ id: uuid, body: str, quote: maybe, personId: uuid, who: str, createdAt: str, resolvedAt: maybe, mine: bool });
const VERSION = object({ id: uuid, version: int, title: str, reason: str, savedAt: str, startedAt: str, savedBy: maybe, size: int });
const BODY = { markdown: { type: 'string', maxLength: 500000, description: 'The whole body as Markdown. `@[Label](task:<id>)` (person, agent, task, project, goal, contract, client, file, doc) is a live mention.' },
  html: { type: 'string', maxLength: 1000000, description: 'The whole body as HTML instead of markdown (sanitised: headings, lists, tables, checklists, code, images, callouts).' } };
// DOCS-MCP (1716): tags and one category, the way Kazuk's Claude reads "the latest docs tagged offer".
const TAG_LIST = (description: string) => ({ type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 }, description });
const LABELS = { tags: TAG_LIST('Tags (short lowercase words such as offer, sop, stage 2). Replaces the doc\'s tags.'),
  category: { type: ['string', 'null'], maxLength: 40, description: `One category, e.g. ${CATEGORIES.join(', ')} (a company may use its own).` } };
const MENTIONS = 'Mention with @[Label](kind:id): kind person, agent (an AI employee), task, project, goal, contract, client, file or doc; the id comes from the matching list_ tool.';

async function docOut(ctx: Parameters<typeof member>[0], id: string, withHtml: boolean) {
  const d = await getDoc(ctx.client, id);
  const mentions = (await ctx.client.query('select kind,ref_id::text id,label from pulse.doc_mention where doc_id=$1 order by kind,label', [d.id])).rows;
  return { ...d, html: withHtml ? d.html : null, markdown: htmlToMarkdown(d.html), mentions, sharedWith: await sharesOf(ctx.client, d.id), links: await linksOf(ctx.client, d.id) };
}

// DOCS-INTERACTIVE (1715): interactive blocks in Markdown, docs sent to a person, reading receipts, links to work.
const BLOCKS = 'Interactive blocks are fenced code blocks of kind pulse-block holding one JSON object: {"kind":"approval","question":"…","onApprove":{"createTask":"title"}} | '
  + '{"kind":"checklist","title":"…","items":["…"]} | {"kind":"form","title":"…","fields":[{"label":"…","type":"text|long|number|date|choice","options":["…"]}]} | '
  + '{"kind":"actions","title":"…","rows":["…"]} | {"kind":"quote","text":"…","who":"…","role":"…"} | {"kind":"chart","title":"…","unit":"…","rows":[{"label":"…","value":1}]} | '
  + '{"kind":"timeline","title":"…","steps":[{"date":"…","text":"…","done":false}]}. People answer approvals, checklists, forms and action rows in the doc. '
  // DOCS-RICH (owner, 9 Nov 2026): charts, diagrams, web pages and big numbers, so an agent writes rich docs directly.
  + 'Rich blocks: CHART {"kind":"chart","type":"line|bar|area|pie|scatter|table|kpi","title":"Revenue vs cost","unit":"₹ lakh","columns":["Month","Revenue","Cost"],'
  + '"rows":[["Jan",2.4,1.8],["Feb",2.7,1.9]],"stacked":false,"horizontal":false,"note":"Source: …"}: the first column names each row (for scatter it is the x number), '
  + 'every other column is one series of numbers (null for a gap); up to 12 columns and 500 rows; kpi shows the first series\' last value and its change from the row before; '
  + 'table shows the numbers as a table; at most 5 series are drawn (the table keeps all). '
  + 'DIAGRAM {"kind":"diagram","title":"Launch plan","code":"timeline\\n  title Launch\\n  04 Nov : Prepare\\n  11 Nov : Pilot"} with Mermaid code (flowchart TD, timeline, gantt, mindmap, sequenceDiagram …). '
  + 'BIG NUMBERS {"kind":"stat","items":[{"value":"₹42.6 L","label":"Revenue","delta":"+12% vs Sep","tone":"good|bad|neutral"}]} (1 to 6). '
  + 'WEB PAGE {"kind":"html","title":"Pipeline analysis","source":"<!doctype html>…"}: a whole HTML page (up to about 400 KB here) that runs sealed in the doc '
  + '(scripts run; no network except scripts, styles and fonts from cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com, cdn.plot.ly, d3js.org and cdn.tailwindcss.com; '
  + 'no cookies, no access to the doc or Pulse). Saving keeps the page as a file and the block then reads {"kind":"html","title":"…","fileId":"…"}. '
  + 'Layout in Markdown: a callout is a quote starting **Info:**, **Tip:**, **Warning:** or **Danger:**; a toggle (hidden until opened) is '
  + '<details data-type="toggle">\\n<summary>Title</summary><div data-type="toggle-content">\\n\\nMarkdown\\n\\n</div></details>; '
  + 'columns are <div data-type="columns" data-count="2">\\n<div data-type="column">\\n\\nMarkdown\\n\\n</div>\\n<div data-type="column">\\n\\nMarkdown\\n\\n</div>\\n</div> '
  + '(2 or 3 columns; blank lines around the Markdown inside). To change one block later, use update_doc_block with its id from get_doc.';
const REQUEST = object({ id: uuid, docId: uuid, title: str, ask: { enum: ['read', 'approve', 'review'] }, status: { enum: ['waiting', 'read', 'approved', 'declined', 'changes', 'cancelled'] },
  note: maybe, dueAt: maybe, from: str, fromId: uuid, to: str, toId: uuid, sentAt: str, answeredAt: maybe, answerNote: maybe, openedAt: maybe });
const SECTION = object({ id: str, title: str, words: int, ms: int, views: int, state: { enum: ['read', 'skimmed', 'skipped'] } });
const READ = object({ personId: uuid, name: str, sessions: int, activeMs: int, depth: num, readPct: int, reReads: int, firstAt: maybe, lastAt: maybe,
  sections: { type: 'array', items: SECTION }, summary: str,
  request: { anyOf: [{ type: 'null' }, object({ id: uuid, ask: str, status: str, sentAt: str, answeredAt: maybe, openedAt: maybe })] } });
const SEND = { to: { ...uuid, description: 'The person or AI employee (from list_people) who should read it.' }, ask: { enum: ['read', 'approve', 'review'] },
  note: { type: 'string', maxLength: 2000 }, dueAt: { type: 'string', maxLength: 40, description: 'ISO date or date-time it is needed by.' } };

defineV1Operation({ operationId: 'listDocs', method: 'GET', path: '/api/v1/docs', scope: 'docs.read',
  summary: 'Docs you can see: search their words, list a folder, or find the docs that mention a task, project, person …',
  query: object({ ...PAGE_QUERY, q: qText(200), folderId: uuid, mentionKind: { enum: [...MENTION_KINDS] }, mentionId: uuid, archived: { enum: ['true', 'false'] },
    tag: { type: 'string', minLength: 1, maxLength: 200, description: 'Keep docs holding this tag (several: comma-separated, all must match).' }, category: qText(40),
    view: { enum: ['shared', 'recent', 'starred'], description: 'shared: docs others shared with you; recent: the ones you opened or changed lately; starred: your stars.' },
    underFolderId: { ...uuid, description: 'Keep docs anywhere under this folder, its sub-folders included.' } }, []),
  response: pageResponse(SUMMARY),
  mcp: { name: 'list_docs', title: 'List or search docs',
    description: 'Lists the company docs you can see, newest change first, each with its tags and category. q searches titles, words and tags (best match first, with a snippet); tag keeps docs with that tag (comma-separated: all of them); category keeps one category; folderId keeps one folder (from list_doc_folders); mentionKind + mentionId lists the docs that mention that task, project, goal, person, contract, client, file or doc (backlinks). archived true lists archived docs. Pages of up to 100 with nextCursor. To read the newest docs with a tag in full, use read_latest_docs.' },
  handler: async (ctx, input) => {
    await member(ctx);
    const q = input.query;
    const mention = q.mentionKind && q.mentionId ? { kind: String(q.mentionKind), id: String(q.mentionId) } : undefined;
    const tags = q.tag ? String(q.tag).split(',') : undefined;
    return pageV1(ctx, 'listDocs', input, (after, take) => listDocs(ctx.client, { q: q.q, folderId: q.folderId, mention, archived: q.archived === 'true', after, take, tags, category: q.category ?? null,
      view: (q.view as 'shared' | 'recent' | 'starred' | undefined) ?? null, under: q.underFolderId ?? null }));
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

// ARTHA-FIX (owner, 17 Nov 2026: a Finance doc an AI employee made in a group stayed private to it, so nobody in the group
// could open it): a doc written in a chat is shared with the chat's people, as edit (staff, active; never a client or a
// guest; not the doc's maker). The writer must be in that chat (row security on chat_member decides what it sees).
async function shareWithChat(ctx: Parameters<typeof member>[0], docId: string, chatId: string) {
  const inChat = (await ctx.client.query('select 1 from pulse.chat_member where channel_id=$1 and person_id=pulse.current_viewer()', [chatId])).rowCount;
  if (!inChat) v1Fail(403, 'shareWithChat must be a chat you are in');
  const people = (await ctx.client.query(`select m.person_id id from pulse.chat_member m join pulse.person p on p.id=m.person_id
    where m.channel_id=$1 and p.side='staff' and p.status='active' and m.person_id<>pulse.current_viewer() order by p.display_name limit 200`, [chatId])).rows as { id: string }[];
  if (!people.length) return;
  await shareDoc(ctx.client, docId, { access: 'people', people: people.map((p) => ({ personId: p.id, role: 'edit' })) });
}

defineV1Operation({ operationId: 'createDoc', method: 'POST', path: '/api/v1/docs', scope: 'docs.write',
  summary: 'Write a new doc (from Markdown, HTML or a template), in a folder, private or shared with the company',
  body: object({ title: text(200), folderId: maybeId, ...BODY, ...LABELS, template: { enum: TEMPLATE_KEYS }, access: { enum: ['private', 'company'] },
    sendTo: object(SEND, ['to']),
    shareWithChat: { ...uuid, description: 'A chat you are in: the doc is shared with its people (they read and edit it). An AI employee\'s runtime fills it with the chat it is answering in.' } }, []),
  response: object({ doc: DOC, requestId: maybeId, openBeside: str }), authorize: member,
  mcp: { name: 'create_doc', title: 'Write a doc',
    description: `Writes a new doc you own. title; markdown (or html) for the body, or a template (${TEMPLATE_KEYS.join(', ')}) to start from one; folderId puts it in a folder; tags and category label it; access private (only you, unless shareWithChat) or company (every staff member and AI employee who may open its folder reads and edits it). A doc you write while answering in a chat is shared with that chat's people (shareWithChat, filled in for you). sendTo {to, ask read|approve|review, note, dueAt} also pushes it to that person in the same call (see send_doc). openBeside is its address: to show it to the person you are answering, call screen_open_side_panel with target openBeside and the doc's title; put the same address in your reply so others open it beside the chat. Then call make_doc_richer to see upgrades (number tables → charts, key numbers → big numbers, dated steps → a timeline). ${MENTIONS} ${BLOCKS}` },
  handler: async (ctx, { body }) => {
    const b = body as Row;
    const id = await saveDoc(ctx.client, null, b);
    if (b.shareWithChat && b.access !== 'company') await shareWithChat(ctx, id, String(b.shareWithChat));
    const requestId = b.sendTo ? await sendDoc(ctx.client, id, b.sendTo as Row) : null;
    return { doc: await docOut(ctx, id, false), requestId, openBeside: `/docs/${id}` };
  },
});

defineV1Operation({ operationId: 'sendDoc', method: 'POST', path: '/api/v1/docs/{docId}/requests', scope: 'docs.write',
  summary: 'Send a doc to a person to read, approve or review; they get a notification and answer in the doc',
  params: object({ docId: uuid }), body: object(SEND, ['to']),
  response: object({ request: REQUEST }), authorize: member,
  mcp: { name: 'send_doc', title: 'Send a doc to someone',
    description: 'Pushes a doc into a person\'s space with a notification: ask read ("here, read this"), approve (they approve, decline or ask for changes) or review (they may edit). The doc is shared with them. Their reading is measured (time, depth, sections read or skipped) and get_doc_reads tells you how carefully they read it; list_doc_requests shows the answer. A new ask replaces an unanswered one to the same person.' },
  handler: async (ctx, { params, body }) => {
    const rid = await sendDoc(ctx.client, params.docId, body as Row);
    // WL-DOCS (18 Nov 2026): the sender's list carries each reader's reading summary ("reads"), which is not part of
    // this answer: with it every send_doc answered 500 ("API v1 answer outside its schema") and the send was rolled
    // back, for a person and an AI employee alike. list_doc_requests has the summary.
    const sent = (await listRequests(ctx.client, 'all')).find((r) => r.id === rid)!;
    delete sent.reads;
    return { request: sent };
  },
});

defineV1Operation({ operationId: 'listDocRequests', method: 'GET', path: '/api/v1/docs/requests', scope: 'docs.read',
  summary: 'Docs you sent to people (with their answer and a reading summary) or that people sent you',
  query: object({ direction: { enum: ['from', 'to'] }, status: { enum: ['waiting', 'read', 'approved', 'declined', 'changes'] } }, []),
  response: object({ items: { type: 'array', items: object({ ...REQUEST.properties, reads: { type: 'string' } }, Object.keys(REQUEST.properties)) } }),
  mcp: { name: 'list_doc_requests', title: 'Docs sent and their answers',
    description: 'direction from (default): the docs you sent, each with its status (waiting, read, approved, declined, changes), the answer note and a reading summary such as "Read 92 %, 6 min, skipped §4". direction to: docs people sent you to read or approve. status filters.' },
  handler: async (ctx, { query }) => { await member(ctx); return { items: await listRequests(ctx.client, query.direction === 'to' ? 'to' : 'from', query.status as string | undefined) }; },
});

defineV1Operation({ operationId: 'answerDocRequest', method: 'POST', path: '/api/v1/docs/requests/{requestId}/answer', scope: 'docs.write',
  summary: 'Answer a doc someone sent you: approve, decline, ask for changes, or mark it read',
  params: object({ requestId: uuid }), body: object({ answer: { enum: ['approve', 'decline', 'changes', 'read'] }, note: { type: 'string', maxLength: 2000 } }, ['answer']),
  response: object({ request: REQUEST }), authorize: member,
  mcp: { name: 'answer_doc_request', title: 'Answer a doc sent to you', description: 'Answers a request sent to you (from list_doc_requests direction to): approve, decline, changes (with a note saying what) or read. The sender is notified.' },
  handler: async (ctx, { params, body }) => ({ request: await answerRequest(ctx.client, params.requestId, body as Row) }),
});

defineV1Operation({ operationId: 'getDocReads', method: 'GET', path: '/api/v1/docs/{docId}/reads', scope: 'docs.read',
  summary: 'How each person read a doc: read %, active minutes, depth, sections read, skimmed or skipped, re-reads, the answer',
  params: object({ docId: uuid }), response: object({ items: { type: 'array', items: READ } }),
  mcp: { name: 'get_doc_reads', title: 'How carefully a doc was read',
    description: 'Reading receipts for a doc you own or sent: per person, the share of the words in sections actually read (readPct), active time on screen (activeMs; idle and hidden time is not counted), the deepest point reached (depth 0–1), each section read, skimmed or skipped, re-reads, and the request\'s answer and when. Use it to know whether the person truly read something before acting on their approval. Only the doc\'s owner and the sender see this.' },
  handler: async (ctx, { params }) => { await member(ctx); await getDoc(ctx.client, params.docId); return { items: await docReads(ctx.client, params.docId) }; },
});

defineV1Operation({ operationId: 'linkDoc', method: 'POST', path: '/api/v1/docs/{docId}/links', scope: 'docs.write',
  summary: 'Link a doc to a task, project or goal (as its brief, or related)',
  params: object({ docId: uuid }), body: object({ kind: { enum: ['task', 'project', 'goal'] }, id: uuid, role: { enum: ['brief', 'related'] } }, ['kind', 'id']),
  response: object({ doc: DOC }), authorize: member,
  mcp: { name: 'link_doc', title: 'Link a doc to work', description: 'Links a doc to a task, project or goal so each shows the other. role brief makes it that task\'s (project\'s, goal\'s) brief, replacing an earlier brief; related (default) adds it to its docs. list_docs with mentionKind + mentionId lists a task\'s docs (linked or mentioning it).' },
  handler: async (ctx, { params, body }) => { await addLink(ctx.client, params.docId, body as Row); return { doc: await docOut(ctx, params.docId, false) }; },
});

defineV1Operation({ operationId: 'updateDoc', method: 'PATCH', path: '/api/v1/docs/{docId}', scope: 'docs.write',
  summary: 'Change a doc: its title, its whole body, or add Markdown at the end; moves it between folders',
  params: object({ docId: uuid }),
  body: object({ title: text(200), folderId: maybeId, ...BODY, ...LABELS, addTags: TAG_LIST('Tags added to the ones it has.'), removeTags: TAG_LIST('Tags taken off.'),
    appendMarkdown: { type: 'string', maxLength: 200000, description: 'Markdown added at the end of the body.' },
    baseVersion: { type: ['integer', 'null'], description: 'The version you read; if someone changed the doc since, nothing is saved and the answer is 409.' } }, []),
  response: object({ doc: DOC }), authorize: member,
  mcp: { name: 'update_doc', title: 'Change a doc',
    description: `Changes only what is sent: title, markdown (replaces the whole body), appendMarkdown (adds at the end, e.g. a dated note), folderId, tags (replaces them) or addTags/removeTags, category. Send baseVersion from get_doc so you never overwrite someone's newer words (409 then: read it again). Every change is kept in the doc's version history. To change one chart, diagram or other block, use update_doc_block. After a big change, make_doc_richer shows upgrades (charts, big numbers, timelines). ${MENTIONS} ${BLOCKS}`, idempotent: true },
  handler: async (ctx, { params, body }) => ({ doc: await docOut(ctx, await saveDoc(ctx.client, params.docId, body as Row), false) }),
});

// DOCS-RICH: one block changed in place (a chart's data, a diagram's code, a page), the rest of the doc untouched.
const CELL = { type: ['string', 'number', 'null'] };
const STAT_ITEM = object({ value: { type: 'string', maxLength: 24 }, label: { type: 'string', maxLength: 60 }, delta: { type: 'string', maxLength: 40 }, tone: { enum: ['good', 'bad', 'neutral'] } }, ['value']);
const BLOCK_PATCH = object({ title: { type: 'string', maxLength: 120 }, type: { enum: ['line', 'bar', 'area', 'pie', 'scatter', 'table', 'kpi'] }, unit: { type: 'string', maxLength: 16 },
  columns: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 60 } }, rows: { type: 'array', maxItems: 500, items: { type: 'array', maxItems: 12, items: CELL } },
  stacked: bool, horizontal: bool, note: { type: 'string', maxLength: 300 }, code: { type: 'string', maxLength: 20000 },
  source: { type: 'string', maxLength: 450000, description: 'A whole HTML page (web page blocks).' }, height: int, items: { type: 'array', maxItems: 6, items: STAT_ITEM } }, []);
const BLOCK_OUT = object({ ...BLOCK_PATCH.properties, kind: str, id: str, fileId: str, items: { type: 'array', items: { anyOf: [{ type: 'string' }, STAT_ITEM] } },
  rows: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'array', items: CELL }] } }, question: str, text: str, who: str, role: str,
  onApprove: object({ createTask: str, assignee: str, taskId: str }, []), steps: { type: 'array', items: object({ date: str, text: str, done: bool }) },
  fields: { type: 'array', items: object({ label: str, type: str, options: { type: 'array', items: str } }, ['label', 'type']) } }, ['kind', 'id']);
defineV1Operation({ operationId: 'updateDocBlock', method: 'PATCH', path: '/api/v1/docs/{docId}/blocks/{blockId}', scope: 'docs.write',
  summary: 'Change one block of a doc (a chart\'s data, a diagram\'s code, a web page, big numbers …) and keep the rest',
  params: object({ docId: uuid, blockId: { type: 'string', pattern: '^b_[A-Za-z0-9]{4,24}$' } }),
  body: object({ block: { ...BLOCK_PATCH, description: 'The block\'s fields to change, e.g. {"rows":[["Jan",2.4]]} or {"type":"line"} for a chart, {"code":"…"} for a diagram, {"source":"<!doctype html>…"} for a web page, {"items":[…]} for big numbers. Its kind and id stay.' },
    baseVersion: { type: ['integer', 'null'], description: 'The version you read; if someone changed the doc since, nothing is saved and the answer is 409.' } }, ['block']),
  response: object({ doc: DOC, block: BLOCK_OUT }), authorize: member,
  mcp: { name: 'update_doc_block', title: 'Change one block in a doc',
    description: `Changes one block of a doc, found by its id (the "id" inside each \`\`\`pulse-block fence that get_doc returns), and leaves every other word alone. Send only the fields to change; they are checked like a new block. Send baseVersion from get_doc. The change is kept in the doc's history. ${BLOCKS}`, idempotent: true },
  handler: async (ctx, { params, body }) => {
    const b = body as Row, old = await getDoc(ctx.client, params.docId);
    const { html, block } = replaceBlock(old.html, String(params.blockId), (b.block ?? {}) as Row);
    await saveDoc(ctx.client, old.id, { html, ...(b.baseVersion !== undefined ? { baseVersion: b.baseVersion } : {}) });
    return { doc: await docOut(ctx, old.id, false), block };
  },
});

// DOCS-POLISH (owner, 14 Nov 2026): docs Claude writes come out as plain words; this offers and makes the upgrades a person
// gets from "Make this doc richer" (doc-richer.ts): charts from number tables, big numbers, timelines, flow diagrams, toggles.
const RICHER = object({ id: str, kind: { enum: ['chart', 'stat', 'timeline', 'diagram', 'toggle', 'numbers'] }, title: str, detail: str, on: bool }, ['id', 'kind', 'title', 'detail', 'on']);
defineV1Operation({ operationId: 'makeDocRicher', method: 'POST', path: '/api/v1/docs/{docId}/richer', scope: 'docs.write',
  summary: 'Look at, or make, the upgrades that make a doc richer: charts from number tables, big numbers, timelines, diagrams, toggles',
  params: object({ docId: uuid }),
  body: object({ apply: { anyOf: [{ type: 'array', maxItems: 200, items: { type: 'string', maxLength: 40 } }, { enum: ['all'] }],
    description: 'Leave out (or send []) to only look. Send the ids from a look to make those upgrades, or "all" for every upgrade that starts ticked (on).' },
    baseVersion: { type: ['integer', 'null'], description: 'The version you read; if someone changed the doc since, nothing is saved and the answer is 409.' } }, []),
  response: object({ suggestions: { type: 'array', items: RICHER }, applied: { type: 'array', items: RICHER }, keptTables: int, version: int, undoVersionId: { type: ['string', 'null'] }, doc: { anyOf: [DOC, { type: 'null' }] } }),
  authorize: member,
  mcp: { name: 'make_doc_richer', title: 'Make a doc richer',
    description: 'After writing or importing a doc, call this with only docId to see what could look better: a table of numbers gets a chart under it (the table stays), a "Key numbers" list or a table\'s Total row becomes big numbers, a list of dated steps ("Week 1: …") becomes a timeline, a numbered list of steps under "Process" or "How it works" gets a flow diagram, an Appendix / Method / FAQ section folds into a toggle, and amounts in tables are written the Indian way (12,34,567). Nothing is invented: every number and label comes from the doc. Then call again with apply (the ids you want, or "all") and baseVersion. The change is its own version in History ("Made richer"); restoring undoVersionId undoes it.' },
  handler: async (ctx, { params, body }) => {
    const b = body as Row, apply = b.apply === 'all' ? 'all' as const : Array.isArray(b.apply) ? (b.apply as unknown[]).map(String) : [];
    if (apply !== 'all' && !apply.length) {
      const r = await richerOf(ctx.client, params.docId);
      return { suggestions: r.suggestions.map(richerOut), applied: [], keptTables: r.kept.tables, version: r.version, undoVersionId: null, doc: null };
    }
    const r = await makeRicher(ctx.client, params.docId, apply, b.baseVersion);
    const next = await richerOf(ctx.client, params.docId);
    return { suggestions: next.suggestions.map(richerOut), applied: r.applied.map(richerOut), keptTables: next.kept.tables, version: r.version, undoVersionId: r.undo, doc: await docOut(ctx, params.docId, false) };
  },
});
function richerOut(s: { id: string; kind: string; title: string; detail: string; on: boolean }) { return { id: s.id, kind: s.kind, title: s.title, detail: s.detail, on: s.on }; }

defineV1Operation({ operationId: 'listDocFolders', method: 'GET', path: '/api/v1/docs/folders', scope: 'docs.read',
  summary: 'The company\'s doc folders', response: object({ items: { type: 'array', items: FOLDER } }),
  mcp: { name: 'list_doc_folders', title: 'List doc folders', description: 'Lists the doc folders you can see (id, name, parentId for nesting, how many docs each holds, and who it is for: company, or people for a private folder with its people). Each project usually has its own folder.' },
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

// ------------------------------------------------------------------------------------------------ DOCS-MCP (1716)
defineV1Operation({ operationId: 'listDocTags', method: 'GET', path: '/api/v1/docs/tags', scope: 'docs.read',
  summary: 'The tags and categories used on the docs you can see',
  response: object({ tags: { type: 'array', items: object({ tag: str, docs: int, lastAt: str }) }, categories: { type: 'array', items: object({ category: str, docs: int }) } }),
  mcp: { name: 'list_doc_tags', title: 'List doc tags', description: 'Lists every tag on the docs you can see (most used first, with how many docs hold it and when one last changed), and the categories in use plus the suggested ones. Use a tag with list_docs or read_latest_docs.' },
  handler: async (ctx) => { await member(ctx); const [tags, categories] = await Promise.all([listTags(ctx.client), listCategories(ctx.client)]); return { tags, categories }; },
});

const LATEST = object({ ...SUMMARY_FIELDS, markdown: str });
defineV1Operation({ operationId: 'readLatestDocs', method: 'GET', path: '/api/v1/docs/latest', scope: 'docs.read',
  summary: 'The newest docs with a tag (or in a folder, or of a category), each in full as Markdown',
  query: object({ tag: { type: 'string', minLength: 1, maxLength: 200 }, category: qText(40), folderId: uuid, q: qText(200), limit: { type: 'string', pattern: '^([1-9]|1[0-9]|20)$' } }, []),
  response: object({ items: { type: 'array', items: LATEST }, total: int }),
  mcp: { name: 'read_latest_docs', title: 'Read the latest docs',
    description: 'Reads the newest docs (last changed first) with a tag, of a category, in a folder or matching words, in full as Markdown, ready to use as context: e.g. tag offer for "the latest docs tagged offer". limit 1–20 (default 5). Several tags comma-separated: all must match. Long docs are cut at about 40,000 characters each; get_doc reads one in full.' },
  handler: async (ctx, { query }) => {
    await member(ctx);
    const take = Math.min(Number(query.limit ?? 5) || 5, 20);
    const list = await listDocs(ctx.client, { q: query.q, folderId: query.folderId, tags: query.tag ? String(query.tag).split(',') : undefined, category: query.category ?? null, take });
    const items = [];
    for (const d of list) {
      const md = htmlToMarkdown((await getDoc(ctx.client, d.id)).html);
      items.push({ ...d, markdown: md.length > 40000 ? `${md.slice(0, 40000)}\n\n[… cut here: read the whole doc with get_doc ${d.id}]` : md });
    }
    return { items, total: items.length };
  },
});

defineV1Operation({ operationId: 'importDocs', method: 'POST', path: '/api/v1/docs/import', scope: 'docs.write',
  summary: 'Bring in a folder of Markdown files and keep its folder tree',
  body: object({ folderId: maybeId, replace: bool, access: { enum: ['private', 'company'] },
    files: { type: 'array', minItems: 1, maxItems: 100, items: object({ path: text(600), markdown: { type: 'string', maxLength: 2000000 } }) } }, ['files']),
  response: object({ created: int, updated: int, folders: int, skipped: { type: 'array', items: object({ path: str, why: str }) },
    docs: { type: 'array', items: object({ id: uuid, title: str, path: str, action: { enum: ['created', 'updated'] } }) } }),
  authorize: member,
  mcp: { name: 'import_docs', title: 'Import a folder of docs',
    description: 'Brings in Markdown files and keeps their folders: a path like "Vitals/Offer/Stage 1.md" makes (or finds) the folders Vitals → Offer and a doc "Stage 1" inside, under folderId when sent. Front matter (title, tags, category) is read. replace true (default) updates a doc of the same name already in that folder instead of making a copy, so the same folder can be sent again after changes (the old words stay in its history). access company (default: everyone who may open the folder) or private. At most 100 files and 20 MB per call; send the rest in more calls.', idempotent: true },
  handler: async (ctx, { body }) => {
    const b = body as Row;
    return importTree(ctx.client, { folderId: b.folderId ?? null, replace: b.replace !== false, access: b.access, items: (b.files as Row[]).map((f) => ({ path: f.path, markdown: f.markdown })) });
  },
});

// ------------------------------------------------------------------------------------------------ DOCS-DRIVE (1893)
// Claude organises folders too: move many docs, folders and files at once, rename, nest or archive a folder, and change
// many docs in one call. A move that would let more people see something (out of a private folder) is not made until
// allowWiderAccess is true, so an AI never opens a private folder's docs by accident: ask the person first.
const ITEM_IDS = (what: string) => ({ type: 'array', maxItems: 200, items: uuid, description: `The ${what} (ids from list_docs / list_doc_folders).` });
const REFUSED = { type: 'array', items: object({ kind: { enum: ['doc', 'folder', 'file'] }, id: uuid, name: str, why: str }) };
const ITEM = object({ kind: { enum: ['doc', 'folder', 'file'] }, id: uuid });
const MOVE_RESULT = object({ moved: { type: 'array', items: ITEM }, failed: REFUSED, to: object({ id: maybeId, name: str, private: bool }),
  needsConfirm: { anyOf: [{ type: 'null' }, object({ message: str, names: { type: 'array', items: str } })] } });

defineV1Operation({ operationId: 'moveDocs', method: 'POST', path: '/api/v1/docs/move', scope: 'docs.write',
  summary: 'Move docs, folders and files into a folder (or to the top of Docs), many at once',
  body: object({ docIds: ITEM_IDS('docs'), folderIds: ITEM_IDS('folders, each with everything inside it'), fileIds: ITEM_IDS('files'),
    to: { ...maybeId, description: 'The folder to move them into; null moves them to the top of Docs (in no folder).' },
    allowWiderAccess: { type: 'boolean', description: 'Only after the person agreed: move even when more people would then see it (it leaves a private folder).' } }, ['to']),
  response: MOVE_RESULT, authorize: member,
  mcp: { name: 'move_docs', title: 'Move docs and folders',
    description: 'Moves docs (docIds), folders with everything inside them (folderIds) and files (fileIds) into the folder `to` (from list_doc_folders), or to the top of Docs with to null. Use it to organise: e.g. put every offer doc into Offer, or nest Stage 1 under Offer. A folder never goes inside itself. If a move would let more people see something (it leaves a private folder), nothing is moved and needsConfirm says who would see it: ask the person, and only then send the same call with allowWiderAccess true. failed lists what you may not move and why; the rest is moved.', idempotent: true },
  handler: async (ctx, { body }) => {
    const b = body as Row;
    return moveItems(ctx.client, cleanItems(b), (b.to as string | null) ?? null, b.allowWiderAccess === true);
  },
});

defineV1Operation({ operationId: 'updateDocFolder', method: 'PATCH', path: '/api/v1/docs/folders/{folderId}', scope: 'docs.write',
  summary: 'Rename a doc folder, put it inside another folder (nest it), or archive or restore it',
  params: object({ folderId: uuid }),
  body: object({ name: text(120), parentId: { ...maybeId, description: 'The folder to put it inside; null puts it at the top.' }, archived: bool,
    allowWiderAccess: { type: 'boolean', description: 'Only after the person agreed: nest it even when more people would then see what is inside.' } }, []),
  response: object({ folder: { anyOf: [{ type: 'null' }, FOLDER] }, needsConfirm: { anyOf: [{ type: 'null' }, object({ message: str, names: { type: 'array', items: str } })] } }), authorize: member,
  mcp: { name: 'update_doc_folder', title: 'Rename, nest or archive a folder',
    description: 'Changes a doc folder: name renames it; parentId moves it (and everything inside) under another folder, or to the top with null; archived true archives it (its docs stay and are found in search), false brings it back. Folders are changed by whoever made them, leadership and admins. Nesting that would let more people see what is inside answers needsConfirm and changes nothing: ask the person, then send allowWiderAccess true.', idempotent: true },
  handler: async (ctx, { params, body }) => {
    const b = body as Row;
    if (Object.prototype.hasOwnProperty.call(b, 'parentId')) {
      const r = await moveItems(ctx.client, [{ kind: 'folder', id: params.folderId }], (b.parentId as string | null) ?? null, b.allowWiderAccess === true);
      if (r.needsConfirm) return { folder: null, needsConfirm: r.needsConfirm };
      if (r.failed.length) v1Fail(403, r.failed[0].why);
    }
    if (typeof b.name === 'string' || typeof b.archived === 'boolean') await saveFolder(ctx.client, params.folderId, { ...(typeof b.name === 'string' ? { name: b.name } : {}), ...(typeof b.archived === 'boolean' ? { archived: b.archived } : {}) });
    const folder = (await listFolders(ctx.client)).find((f) => f.id === params.folderId) ?? null;
    return { folder, needsConfirm: null };
  },
});

defineV1Operation({ operationId: 'bulkUpdateDocs', method: 'POST', path: '/api/v1/docs/bulk', scope: 'docs.write',
  summary: 'Change many docs at once: archive or restore them, add or take off tags, or share them',
  body: object({ docIds: ITEM_IDS('docs'), folderIds: ITEM_IDS('folders (archive and restore only)'), fileIds: ITEM_IDS('files (archive and restore only)'),
    action: { enum: [...BULK_ACTIONS] }, tags: TAG_LIST('The tags to add or take off (addTags, removeTags).'),
    access: { enum: ['private', 'company', 'people'], description: 'share: private (only the owner), company (everyone who may open its folder) or people (chosen people).' },
    people: { type: 'array', maxItems: 100, items: object({ personId: uuid, role: { enum: [...SHARE_ROLES] } }, ['personId']), description: 'share: people added (role view, comment or edit; default comment).' } }, ['action']),
  response: object({ done: { type: 'array', items: ITEM }, failed: REFUSED }), authorize: member,
  mcp: { name: 'bulk_update_docs', title: 'Change many docs at once',
    description: 'One action on many docs (docIds; archive and restore also take folderIds and fileIds): archive (hidden from lists, kept, found under Archived), restore, addTags or removeTags (tags), or share (access private | company | people, and people [{personId, role view|comment|edit}] added to who it is shared with; only a doc\'s owner or an admin shares it). Each item is tried on its own: done lists what changed, failed what you may not change and why.', idempotent: true },
  handler: async (ctx, { body }) => { const b = body as Row; return bulkItems(ctx.client, cleanItems(b), b.action as BulkAction, b); },
});

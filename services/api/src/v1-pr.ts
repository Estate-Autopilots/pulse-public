// PR-STUDIO (owner, 6 Nov 2026): PR Studio over API v1, area `pr` (pr.read / pr.write), so AI employees (a PR manager,
// a creative strategist …), MCP clients and the `pulse` CLI keep the Story, write briefs and draft creatives from the same
// definitions as the screens (pr-studio.ts). Who may is decided in the database (pulse.pr_can under row security: admins,
// leadership and AI employees). Nothing here sends a message: drafts are copied and sent by a person.
import { addEntry, collect, createDraft, getEntry, listAudiences, listBriefs, listDrafts, listStory, prGate, saveAudience, updateDraft, updateEntry, writeBrief } from './pr-studio.js';
import { BRIEF_KINDS, CHANNELS, KINDS, RATIOS, TONES } from './pr-copy.js';
import { pageResponse, PAGE_QUERY, pageV1 } from './v1-paging.js';
import { defineV1Operation, type V1Context } from './v1.js';
import { bool, day, int, maybe, maybeId, member, object, qBool, str, text, uuid, type Row } from './v1-kit.js';

const KIND = { enum: [...KINDS] }, BRIEF_KIND = { enum: [...BRIEF_KINDS] }, TONE = { enum: [...TONES] }, CHANNEL = { enum: [...CHANNELS] }, RATIO = { enum: [...RATIOS] };
const STATUS = { enum: ['draft', 'planned', 'posted', 'skipped'] }, BY = { enum: ['auto', 'ai', 'person'] };
const IDS = { type: 'array', maxItems: 200, items: uuid };
const ENTRY = object({ id: uuid, happenedOn: str, kind: KIND, title: str, body: str, edited: bool, hidden: bool, toldAt: maybe, collected: bool, createdAt: str });
const BRIEF = object({ id: uuid, kind: BRIEF_KIND, personId: maybeId, day: str, title: str, body: str, entryIds: IDS, writtenBy: BY, author: maybe, createdAt: str });
const AUDIENCE = object({ id: uuid, name: str, tone: TONE, channel: CHANNEL, ratio: RATIO, note: str, archived: bool });
const IMAGE = object({ template: { enum: ['headline', 'list', 'number'] }, ratio: RATIO, kicker: str, title: str, lines: { type: 'array', items: str }, big: maybe });
const DRAFT = object({ id: uuid, audienceId: uuid, audience: str, channel: CHANNEL, tone: TONE, ratio: RATIO, briefId: maybeId, entryIds: IDS, headline: str, copy: str,
  longPost: str, images: { type: 'array', maxItems: 3, items: IMAGE }, status: STATUS, planOn: maybe, taskId: maybeId, postedAt: maybe, writtenBy: BY, createdAt: str, updatedAt: str });
const BODY_TEXT = (max: number) => ({ type: 'string', maxLength: max });
const MAYBE_DAY = { type: ['string', 'null'], pattern: day.pattern };

const may = async (ctx: V1Context) => { await member(ctx); await prGate(ctx.client); };
const by = (ctx: V1Context) => ctx.principal.kind === 'ai' ? 'ai' as const : 'person' as const;
const WHO = 'For a company\'s admins, leadership and AI employees.';

defineV1Operation({ operationId: 'listPrStory', method: 'GET', path: '/api/v1/pr/story', scope: 'pr.read',
  summary: 'The Story: what happened in the company, one line per release, feature, bug fixed, tasks done, goal, meeting or note',
  query: object({ ...PAGE_QUERY, from: day, to: day, kind: KIND, untold: qBool }, []),
  response: pageResponse(ENTRY),
  mcp: { name: 'list_pr_story', title: 'Read the Story',
    description: `Lists Story lines, newest first: happenedOn, kind (release, feature, bug, task, goal, meeting, note), title and body. from/to are days (YYYY-MM-DD); untold "true" keeps what is done but not yet told to any audience. ${WHO}` },
  handler: async (ctx, input) => {
    await may(ctx);
    const q = input.query;
    return pageV1(ctx, 'listPrStory', input, (after, take) => listStory(ctx.client, { from: q.from, to: q.to, kind: q.kind, untold: q.untold === 'true', after, take }));
  },
});

defineV1Operation({ operationId: 'addPrStoryEntry', method: 'POST', path: '/api/v1/pr/story', scope: 'pr.write',
  summary: 'Add a line to the Story: a feature landed, a meeting, a decision, a note (what happened, never code)',
  body: object({ happenedOn: day, kind: KIND, title: text(200), body: BODY_TEXT(4000) }, ['title']),
  response: object({ entry: ENTRY }), authorize: may,
  mcp: { name: 'add_pr_story_entry', title: 'Add to the Story',
    description: 'Adds one line to the company\'s Story. kind: feature (summarise landed commits per feature in plain words: what a person can now do, never code or file names), meeting (what was decided), release, bug, task, goal or note. happenedOn defaults to today. Keep title to one plain sentence; body may hold a few short lines.' },
  handler: async (ctx, { body }) => ({ entry: await getEntry(ctx.client, await addEntry(ctx.client, body as Row)) }),
});

defineV1Operation({ operationId: 'updatePrStoryEntry', method: 'PATCH', path: '/api/v1/pr/story/{entryId}', scope: 'pr.write',
  summary: 'Change a Story line: its words, day or kind, or hide it',
  params: object({ entryId: uuid }),
  body: object({ title: text(200), body: BODY_TEXT(4000), happenedOn: day, kind: KIND, hidden: bool }, []),
  response: object({ entry: ENTRY }), authorize: may,
  mcp: { name: 'update_pr_story_entry', title: 'Edit a Story line', description: 'Changes only the fields sent. A line whose words were edited is kept as written (the collector never overwrites it). hidden true takes it out of the Story without deleting it.', idempotent: true },
  handler: async (ctx, { params, body }) => ({ entry: await updateEntry(ctx.client, params.entryId, body as Row) }),
});

defineV1Operation({ operationId: 'collectPrStory', method: 'POST', path: '/api/v1/pr/story/collect', scope: 'pr.write',
  summary: 'Gather into the Story what the company\'s records say happened: tasks done, bugs fixed, goals moved, releases',
  body: object({ from: day, to: day }),
  response: object({ added: int }), authorize: may,
  mcp: { name: 'collect_pr_story', title: 'Collect the Story', description: 'Adds Story lines for tasks done (one per project and day), bugs fixed, company and team goals reached or moved, and product versions released, between two days (at most 92). Safe to repeat: nothing is added twice and edited lines are kept.', idempotent: true },
  handler: async (ctx, { body }) => { const b = body as Row; return { added: await collect(ctx.client, String(b.from), String(b.to)) }; },
});

defineV1Operation({ operationId: 'listPrBriefs', method: 'GET', path: '/api/v1/pr/briefs', scope: 'pr.read',
  summary: 'Morning, evening, weekly and update briefs, newest first',
  query: object({ ...PAGE_QUERY, day, kind: BRIEF_KIND }, []),
  response: pageResponse(BRIEF),
  mcp: { name: 'list_pr_briefs', title: 'List briefs', description: `Lists the company's briefs (and briefs for one person): kind morning, evening, weekly or update; day; title; body (WhatsApp formatting: *bold*); who wrote it (auto, ai or person). ${WHO}` },
  handler: async (ctx, input) => {
    await may(ctx);
    return pageV1(ctx, 'listPrBriefs', input, (after, take) => listBriefs(ctx.client, { day: input.query.day, kind: input.query.kind, after, take }));
  },
});

defineV1Operation({ operationId: 'writePrBrief', method: 'POST', path: '/api/v1/pr/briefs', scope: 'pr.write',
  summary: 'Write a brief: your own words, or composed from the Story when no body is given',
  body: object({ kind: BRIEF_KIND, day, title: text(160), body: BODY_TEXT(8000), personId: uuid, entryIds: IDS }, ['kind']),
  response: object({ brief: BRIEF }), authorize: may,
  mcp: { name: 'write_pr_brief', title: 'Write a brief',
    description: 'Stores a brief shown on PR Studio\'s dashboard. kind morning (since yesterday and what is due today), evening (done today), weekly, or update (after a release or when enough happened). Read the Story first (list_pr_story), then write in plain, warm words: lead with the result, be specific with numbers, short lines, WhatsApp *bold* for the key phrases. personId writes it for one person (they can read it). Without body, Pulse composes one from the Story.' },
  handler: async (ctx, { body }) => ({ brief: await writeBrief(ctx.client, body as Row, by(ctx)) }),
});

defineV1Operation({ operationId: 'listPrAudiences', method: 'GET', path: '/api/v1/pr/audiences', scope: 'pr.read',
  summary: 'The audiences the company tells: name, tone, channel and image shape',
  response: object({ items: { type: 'array', items: AUDIENCE } }),
  mcp: { name: 'list_pr_audiences', title: 'List audiences', description: 'Lists audiences (a team, testers, clients, the public …) with tone (warm, formal, bold, plain), channel (whatsapp, telegram, email, linkedin, x) and image ratio (1:1, 4:5, 9:16, 16:9).' },
  handler: async (ctx) => { await may(ctx); return { items: await listAudiences(ctx.client, true) }; },
});

const AUD_FIELDS = { name: text(80), tone: TONE, channel: CHANNEL, ratio: RATIO, note: BODY_TEXT(500) };
defineV1Operation({ operationId: 'createPrAudience', method: 'POST', path: '/api/v1/pr/audiences', scope: 'pr.write',
  summary: 'Add an audience with its tone, channel and image shape',
  body: object(AUD_FIELDS, ['name']),
  response: object({ audience: AUDIENCE }), authorize: may,
  mcp: { name: 'create_pr_audience', title: 'Add an audience', description: 'Adds a named audience. tone warm, formal, bold or plain; channel whatsapp, telegram, email, linkedin or x; ratio 1:1, 4:5, 9:16 (stories) or 16:9; note says who they are and what they care about.' },
  handler: async (ctx, { body }) => ({ audience: await saveAudience(ctx.client, null, body as Row) }),
});

defineV1Operation({ operationId: 'updatePrAudience', method: 'PATCH', path: '/api/v1/pr/audiences/{audienceId}', scope: 'pr.write',
  summary: 'Change an audience, or archive it',
  params: object({ audienceId: uuid }),
  body: object({ ...AUD_FIELDS, archived: bool }, []),
  response: object({ audience: AUDIENCE }), authorize: may,
  mcp: { name: 'update_pr_audience', title: 'Edit an audience', description: 'Changes only the fields sent; archived true takes it off the lists (its drafts stay).', idempotent: true },
  handler: async (ctx, { params, body }) => ({ audience: await saveAudience(ctx.client, params.audienceId, body as Row) }),
});

defineV1Operation({ operationId: 'listPrDrafts', method: 'GET', path: '/api/v1/pr/drafts', scope: 'pr.read',
  summary: 'Creative drafts and the content calendar: headline, copy, long post, images, status and the day planned',
  query: object({ ...PAGE_QUERY, status: STATUS, from: day, to: day }, []),
  response: pageResponse(DRAFT),
  mcp: { name: 'list_pr_drafts', title: 'List drafts', description: 'Lists drafts with their audience, words, image specs, status (draft, planned, posted, skipped) and planOn. from/to filter by the day planned (the content calendar).' },
  handler: async (ctx, input) => {
    await may(ctx);
    const q = input.query;
    return pageV1(ctx, 'listPrDrafts', input, (after, take) => listDrafts(ctx.client, { status: q.status, from: q.from, to: q.to, after, take }));
  },
});

defineV1Operation({ operationId: 'createPrDraft', method: 'POST', path: '/api/v1/pr/drafts', scope: 'pr.write',
  summary: 'Draft a creative pack for one audience from Story lines or a brief (Pulse composes what you leave out)',
  body: object({ audienceId: uuid, entryIds: IDS, briefId: uuid, headline: text(160), copy: BODY_TEXT(4000), longPost: BODY_TEXT(8000), planOn: day }, ['audienceId']),
  response: object({ draft: DRAFT }), authorize: may,
  mcp: { name: 'create_pr_draft', title: 'Draft a creative',
    description: 'Makes a draft for one audience (audienceId from list_pr_audiences) from entryIds (Story lines) or a briefId; with neither, from everything done but not yet told. Pulse composes a headline, a WhatsApp copy (*bold*), a LinkedIn-style long post and up to three brand images; send your own headline, copy or longPost to replace them (match the audience\'s tone and channel). planOn (YYYY-MM-DD) puts it on the content calendar. Nothing is sent: a person copies and posts it.' },
  handler: async (ctx, { body }) => ({ draft: await createDraft(ctx.client, body as Row, by(ctx)) }),
});

defineV1Operation({ operationId: 'updatePrDraft', method: 'PATCH', path: '/api/v1/pr/drafts/{draftId}', scope: 'pr.write',
  summary: 'Rewrite a draft, plan it on a day, or mark it posted or skipped',
  params: object({ draftId: uuid }),
  body: object({ headline: text(160), copy: BODY_TEXT(4000), longPost: BODY_TEXT(8000), planOn: MAYBE_DAY, status: STATUS }, []),
  response: object({ draft: DRAFT }), authorize: may,
  mcp: { name: 'update_pr_draft', title: 'Edit a draft', description: 'Changes only the fields sent. planOn moves it on the calendar (null takes it off). status posted marks its Story lines told (only after a person really posted it); skipped drops it.', idempotent: true },
  handler: async (ctx, { params, body }) => ({ draft: await updateDraft(ctx.client, params.draftId, body as Row, by(ctx)) }),
});

// AGENT-UI-CONTROL (owner, 7 Nov 2026: "every AI employee must be able to control the whole Pulse screen for the person
// it is helping, the way a human would"). The screen actions as API v1 operations, so AI employees (their own key, through
// MCP: screen_open_side_panel, screen_sidebar, …), a person's connected app and the CLI get the same typed tools. Each call
// becomes one checked, audited row (pulse.agent_ui_request, migration 1745): only for the person it is helping (they
// wrote to it in the last 30 minutes; a person's own token: their own screen), within its screen level at once, above it
// a prompt in the top bar (Allow once / Always). The person's browser hears about it over the realtime channel
// (/api/v0/screen/events, agent-ui.ts) and reports what happened (screen_action_status).
// The catalogue is services/api/data/agent-ui-actions.json (levels and words; the database decides the level).
import { readFileSync } from 'node:fs';
import { defineV1Operation, type Closed, type V1Context } from './v1.js';
import { bool, maybe, member, object, one, str, text, uuid, type Row } from './v1-kit.js';

type Catalogue = { levels: { key: string; label: string; says: string }[]; actions: { name: string; level: string; asks: string; did: string }[];
  forms: Record<string, string>; cards: Record<string, string> };
export const SCREEN: Catalogue = JSON.parse(readFileSync(new URL('../data/agent-ui-actions.json', import.meta.url), 'utf8')) as Catalogue;

/** Every screen call: whom it is for (the runtime fills it from who wrote; a person's own token leaves it out) and one line
 *  that the prompt shows when it must ask. */
const FOR = { forPersonId: { ...uuid, description: 'The person whose screen it is: the one you are helping (your runtime fills it from who wrote). Leave it out with your own personal token: your own screen.' },
  why: { ...text(300, 0), description: 'One short line shown to them if Pulse must ask first, e.g. "to show you the draft quotation".' } };
const ACTION = object({ id: uuid, action: str, state: { enum: ['asked', 'sent', 'claimed', 'done', 'failed', 'refused', 'expired'] }, needed: str, for: maybe,
  message: maybe, result: maybe, error: maybe });
const actionOut = (r: Row) => ({ id: String(r.id), action: String(r.action), state: String(r.state) as 'sent', needed: String(r.needed),
  for: ((r.target as Row | undefined)?.name as string) ?? null, message: (r.message as string) ?? stateWords(String(r.state)),
  result: r.result ? JSON.stringify(r.result).slice(0, 4000) : null, error: (r.error as string) ?? null });
const stateWords = (s: string) => ({ asked: 'Waiting for a yes in the top bar.', sent: 'Sent; their screen has not taken it yet.', claimed: 'Their screen is doing it.',
  done: 'Done on their screen.', failed: 'It did not work on their screen.', refused: 'They (or an admin) said no.', expired: 'Nobody took it in time; their screen may be closed.' } as Record<string, string>)[s] ?? null;

async function send(ctx: V1Context, action: string, body: unknown, args: Row) {
  const b = (body ?? {}) as Row;
  const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const r = await one<Row>(ctx, 'select pulse.agent_ui_request($1,$2,$3::jsonb,$4) v', [b.forPersonId ?? null, action, JSON.stringify(clean), b.why ?? null]);
  return { action: actionOut(r) };
}
const pick = (body: unknown, ...keys: string[]) => Object.fromEntries(keys.map((k) => [k, ((body ?? {}) as Row)[k]]));
const PATH = { type: 'string', minLength: 1, maxLength: 500, pattern: '^/(?!/)[^\\s]*$', description: 'A Pulse address starting with /, e.g. /tasks?scope=me or /erp/documents/<id>.' };
const RULES = 'Only for the person you are helping (they wrote to you in the last 30 minutes). Within your screen level it happens at once; above it they see a prompt (Allow once / Always) and state is "asked": tell them you asked.';

const screenOp = (def: { operationId: string; path: string; tool: string; title: string; summary: string; description: string; action: string | ((b: Row) => string);
    body: Closed['properties']; required?: string[]; args: (b: Row) => Row }) => defineV1Operation({
  operationId: def.operationId, method: 'POST', path: def.path, scope: 'chats.write', summary: def.summary,
  body: object({ ...def.body, ...FOR }, def.required ?? []), response: object({ action: ACTION }), authorize: member,
  mcp: { name: def.tool, title: def.title, description: `${def.description} ${RULES}`, idempotent: false },
  handler: async (ctx, { body }) => send(ctx, typeof def.action === 'string' ? def.action : def.action(body as Row), body, def.args(body as Row)),
});

screenOp({ operationId: 'screenOpenPage', path: '/api/v1/chats/screen/page', tool: 'screen_open_page', title: 'Open a page on their screen', action: 'page.open',
  summary: 'Take the person you are helping to a Pulse page', description: 'Moves their screen to a Pulse page (path), as if they clicked a link. Settings and admin screens need the admin level.',
  body: { path: PATH }, required: ['path'], args: (b) => pick(b, 'path') });
screenOp({ operationId: 'screenOpenSidePanel', path: '/api/v1/chats/screen/side-panel', tool: 'screen_open_side_panel', title: 'Open something beside the chat', action: 'panel.open',
  summary: 'Open a page, a quotation, a file or a link in the side panel beside their chat',
  description: 'Opens target in the side panel (the side browser) next to their chat, as a tab: a Pulse address (/tasks, /erp/documents/<id> for a quotation or invoice), "quote:<id>" for a quotation by id, "file:<id>" for a chat file, a quotation PDF address (/api/v0/erp/documents/<id>/versions/<n>/pdf), a Google Doc or Drive link, or any https link. background true opens it behind the current tab.',
  body: { target: text(2000), title: text(80, 0), background: bool }, required: ['target'], args: (b) => pick(b, 'target', 'title', 'background') });
screenOp({ operationId: 'screenCloseSidePanel', path: '/api/v1/chats/screen/side-panel/close', tool: 'screen_close_side_panel', title: 'Close the side panel', action: 'panel.close',
  summary: 'Close the side panel on their screen', description: 'Hides the side panel beside their chat (its tabs stay for later).', body: {}, args: () => ({}) });
screenOp({ operationId: 'screenSidebar', path: '/api/v1/chats/screen/sidebar', tool: 'screen_sidebar', title: 'Open or close the sidebar', action: 'sidebar.set',
  summary: 'Open or close the navigation sidebar on their screen', description: 'open true shows the navigation sidebar on the left; false folds it away for more room.',
  body: { open: bool }, required: ['open'], args: (b) => pick(b, 'open') });
screenOp({ operationId: 'screenOpenTab', path: '/api/v1/chats/screen/tab', tool: 'screen_open_tab', title: 'Open a new browser tab', action: 'tab.open',
  summary: 'Open a Pulse page or a link in a new browser tab for them', description: 'Opens path (a Pulse address or an https link) in a new browser tab. If their browser blocks it, they get a one-tap "Open" button instead.',
  body: { path: { type: 'string', minLength: 1, maxLength: 2000, pattern: '^(/(?!/)|https://)[^\\s]*$' } }, required: ['path'], args: (b) => pick(b, 'path') });
screenOp({ operationId: 'screenPointAt', path: '/api/v1/chats/screen/point', tool: 'screen_point_at', title: 'Point at a button', action: 'point.at',
  summary: 'Point at a button, link or heading on their screen', description: 'Scrolls to the first button, link, tab or heading whose words match text and makes it glow for a few seconds, to show them where to click.',
  body: { text: text(80) }, required: ['text'], args: (b) => pick(b, 'text') });
screenOp({ operationId: 'screenTypeInMessageBox', path: '/api/v1/chats/screen/message-box', tool: 'screen_type_in_message_box', title: 'Type in their message box', action: 'composer.insert',
  summary: 'Put words into the message box they are typing in (never sends)', description: 'Adds text at the cursor of the message box they have open (the chat or the chat dock). It never sends: they read it and press Send.',
  body: { text: text(2000) }, required: ['text'], args: (b) => pick(b, 'text') });
screenOp({ operationId: 'screenInsertEmoji', path: '/api/v1/chats/screen/emoji', tool: 'screen_insert_emoji', title: 'Add an emoji', action: 'emoji.insert',
  summary: 'Add an emoji to the message they are writing', description: 'Adds one emoji (e.g. 🎉) at the cursor of their message box. It never sends.',
  body: { emoji: { type: 'string', minLength: 1, maxLength: 16, pattern: '^[^\\sA-Za-z0-9<>]+$' } }, required: ['emoji'], args: (b) => pick(b, 'emoji') });
screenOp({ operationId: 'screenOpenForm', path: '/api/v1/chats/screen/form', tool: 'screen_open_form', title: 'Open a form for them', action: 'form.open',
  summary: 'Open a Pulse form on their screen, filled in where you know the answers', description: `Opens a form they then check and save themselves: form ${Object.keys(SCREEN.forms).map((k) => `"${k}"`).join(', ')}. title fills the name (a task's or project's title, the client's name). Adding a person or an AI employee needs the admin level.`,
  body: { form: { enum: Object.keys(SCREEN.forms) }, title: text(200, 0), phone: text(40, 0), email: text(200, 0), city: text(80, 0), company: text(200, 0), notes: text(2000, 0) },
  required: ['form'], args: (b) => pick(b, 'form', 'title', 'phone', 'email', 'city', 'company', 'notes') });
screenOp({ operationId: 'screenAskForFile', path: '/api/v1/chats/screen/file', tool: 'screen_ask_for_file', title: 'Ask them for a file', action: 'file.pick',
  summary: 'Ask them to choose a file from their device; it is attached in your chat', description: 'Shows them a one-tap "Choose a file" (browsers only open the file picker on a tap). What they pick is attached to their chat with you, and the result names the files. purpose says what it is for; accept narrows the kinds (".pdf,image/*").',
  body: { purpose: text(160), accept: { type: 'string', maxLength: 120, pattern: '^[A-Za-z0-9.,/*+ -]*$' }, multiple: bool }, required: ['purpose'], args: (b) => pick(b, 'purpose', 'accept', 'multiple') });
screenOp({ operationId: 'screenMicrophone', path: '/api/v1/chats/screen/microphone', tool: 'screen_microphone', title: 'Start or stop the microphone', action: (b) => (b.on === true ? 'mic.start' : 'mic.stop'),
  summary: 'Start (they tap once to agree) or stop the microphone on their screen', description: 'on true asks them to start recording a voice note in your chat (they tap once: Pulse never turns a microphone on by itself); on false stops it at once. purpose says why.',
  body: { on: bool, purpose: text(160, 0) }, required: ['on'], args: (b) => pick(b, 'purpose') });

// FIX-CHAT-AI (owner walkthrough, 10 Nov 2026: "it should visibly work on screen like a human: open pages, click, fill";
// "typed, cheap tools for every screen action with a screen map: element ids, forms and actions; compact page state"):
// read the page as a short map, then click or fill by the map's ids, visibly (the AI cursor glides there first).
screenOp({ operationId: 'screenRead', path: '/api/v1/chats/screen/read', tool: 'screen_read', title: 'Read their screen', action: 'screen.read',
  summary: 'Read the page on their screen as a short map: where they are, its buttons, fields and rows, each with an id',
  description: 'Returns (in screen_action_status, a moment later) a short map of the page in front of them: path, title, headings, actions [{id, text}] (buttons, links, tabs), fields [{id, label, kind, value}] and rows [{text, actions: ["id:words"]}] of its table or list. Use the ids with screen_click and screen_fill. Read again after the page changes.',
  body: {}, args: () => ({}) });
screenOp({ operationId: 'screenClick', path: '/api/v1/chats/screen/click', tool: 'screen_click', title: 'Click a button on their screen', action: 'element.click',
  summary: 'Click a button, link or tab on their screen, visibly, by its id from screen_read',
  description: 'target is an id from screen_read (e.g. "b7") or the button\'s words; text is its words as they read them (e.g. "Remove"). Their cursor shows yours gliding there first. A click whose words send, pay, delete, remove, approve or sign is asked every time: the person whose screen it is says yes first (state "asked"; tell them you asked).',
  body: { target: text(80), text: text(80) }, required: ['target', 'text'], args: (b) => pick(b, 'target', 'text') });
screenOp({ operationId: 'screenFill', path: '/api/v1/chats/screen/fill', tool: 'screen_fill', title: 'Fill in a field on their screen', action: 'field.fill',
  summary: 'Type into a field on their screen (or pick a choice, tick a box), visibly, by its id from screen_read',
  description: 'target is a field id from screen_read (e.g. "f2") or its label; field is its label as they read it; value the words to type (a choice\'s words for a select; on/off for a checkbox). It types, it never saves: say what to press, or click Save with screen_click.',
  body: { target: text(80), field: text(80), value: text(500, 0) }, required: ['target', 'field', 'value'], args: (b) => pick(b, 'target', 'field', 'value') });

// AGENT-OPERATOR (owner, 13 Nov 2026, P4.2: "downloading, adding things, everything is happening on the platform"):
// uploads and downloads through the page's own file fields and links (in the operator view, inside its framed page).
screenOp({ operationId: 'screenUploadFile', path: '/api/v1/chats/screen/upload', tool: 'screen_upload_file', title: 'Add a file to a page on their screen', action: 'file.upload',
  summary: 'Put a file already shared in your chat into a file field on the page (an upload through the page itself)',
  description: 'file is a chat file ("file:<id>", from a message in your chat with them or from screen_download_file); target is the words or id of the file field or its button (e.g. "Attach a file"). The page uploads it as if they had picked it. To get a file from them first, use screen_ask_for_file.',
  body: { file: { type: 'string', minLength: 7, maxLength: 120, pattern: '^file:[\\w-]{6,80}$' }, target: text(80, 0) }, required: ['file'], args: (b) => pick(b, 'file', 'target') });
screenOp({ operationId: 'screenDownloadFile', path: '/api/v1/chats/screen/download', tool: 'screen_download_file', title: 'Download a file from a page on their screen', action: 'file.download',
  summary: 'Download a file the page links to (a PDF, a sheet) into your chat with them',
  description: 'target is the id from screen_read or the words of the download link (e.g. "Download PDF"); text is its words as they read them. The file is fetched in their browser and attached in your chat; the result names it as "file:<id>" for screen_upload_file.',
  body: { target: text(80), text: text(80) }, required: ['target', 'text'], args: (b) => pick(b, 'target', 'text') });

// DOCS-EDITOR-8 (owner, 17 Nov 2026: "if someone asks 'how do I add a bank statement / a task', the agent should show it
// on the screen"): "show me how". Their browser finds the walkthrough that answers the question (the Learn tutorials) and
// plays it on the page: the page beside your chat (or their whole screen once they tap to allow it), each step's button
// glowing, the step's words with Back / Next, and "Do it for me" (which comes to you as a message).
screenOp({ operationId: 'screenShowMeHow', path: '/api/v1/chats/screen/guide', tool: 'screen_show_me_how', title: 'Show them how, step by step', action: 'guide.play',
  summary: 'Answer "how do I …" by playing a step-by-step walkthrough on their screen',
  description: 'question is what they asked, in their words ("how do I add a bank statement"); tutorial is a walkthrough id if you know it (e.g. "tasks-basics", "add-a-bank-statement"). Their screen opens the right page beside your chat, points at each button and shows the steps with Back / Next; it never clicks for them. The result (screen_action_status) names the walkthrough and its steps, or shown false when none fits: then explain in words and point with screen_point_at. If they then say "do it" (or press Do it for me, which comes to you as a message), do the steps yourself with screen_read, screen_click and screen_fill.',
  body: { question: text(200), tutorial: { type: 'string', maxLength: 60, pattern: '^[a-z0-9-]*$' } }, required: ['question'], args: (b) => pick(b, 'question', 'tutorial') });

const CARD = object({ id: uuid, messageId: uuid, channelId: uuid, state: str });
defineV1Operation({ operationId: 'screenShowCard', method: 'POST', path: '/api/v1/chats/screen/cards', scope: 'chats.write',
  summary: 'Show an interactive card in your chat with them (Add client, Add task, Add project, Pick one) instead of failing',
  body: object({ kind: { enum: Object.keys(SCREEN.cards) }, title: text(160), message: text(2000), name: text(200, 0), company: text(200, 0), phone: text(40, 0), email: text(200, 0),
    city: text(80, 0), notes: text(2000, 0), dueOn: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, options: { type: 'array', items: text(80), minItems: 2, maxItems: 6 }, ...FOR }, ['kind', 'title', 'message']),
  response: object({ card: CARD }), authorize: member,
  mcp: { name: 'screen_show_card', title: 'Show a card in the chat',
    description: 'When something you need is missing, do not stop: post a card in your chat with them that they fill in. kind "client.add" (the client is not in Clients: name, phone, email, city, company filled in where known), "task.add" (name is the task title, notes, dueOn), "project.add" (name, notes) or "choice" (2 to 6 options, e.g. which of several clients). message is what you say above the card. They save it as themselves; you then get a chat message such as "Added the client …" and carry on.' },
  handler: async (ctx, { body }) => {
    const b = body as Row;
    const fields = Object.fromEntries(Object.entries({ name: b.name, company: b.company, phone: b.phone, email: b.email, city: b.city, notes: b.notes, dueOn: b.dueOn, options: b.options,
      ...(b.kind === 'task.add' && b.name ? { title: b.name } : {}) }).filter(([, v]) => v !== undefined && v !== ''));
    const r = await one<Row>(ctx, 'select pulse.agent_ui_card_post($1,$2,$3,$4,$5::jsonb,null) v', [b.forPersonId ?? null, b.kind, b.message, b.title, JSON.stringify(fields)]);
    return { card: { id: String(r.cardId), messageId: String(r.messageId), channelId: String(r.channelId), state: String(r.state) } };
  },
});

defineV1Operation({ operationId: 'screenActionStatus', method: 'GET', path: '/api/v1/chats/screen/actions/{actionId}', scope: 'chats.read',
  summary: 'How a screen action went: waiting for a yes, sent, done (with what happened), failed, refused or expired',
  params: object({ actionId: uuid }), response: object({ action: ACTION }), authorize: member,
  mcp: { name: 'screen_action_status', title: 'Screen action status',
    description: 'How one of your screen actions went (its id from the screen_* tool): asked (waiting for a yes), sent, claimed, done (result says what happened: e.g. the files they picked), failed, refused or expired.' },
  handler: async (ctx, { params }) => { await member(ctx); return { action: actionOut(await one<Row>(ctx, 'select pulse.agent_ui_status($1) v', [params.actionId])) }; },
});

defineV1Operation({ operationId: 'screenControls', method: 'GET', path: '/api/v1/chats/screen', scope: 'chats.read',
  summary: 'What you may do on the screen of the person you help: your level, each action and the level it needs',
  response: object({ level: str, levels: { type: 'array', items: object({ key: str, label: str, says: str }) },
    actions: { type: 'array', items: object({ name: str, level: str, now: bool }) }, alwaysAllowed: { type: 'array', items: str } }),
  authorize: member,
  mcp: { name: 'screen_controls', title: 'What I may do on their screen',
    description: 'Your screen level (off, view, act or admin), what each level allows, and each screen action with the level it needs and whether it runs at once for you (now) or asks first. A click that sends, pays, deletes or approves always asks the person first. An admin or leadership changes the level on your profile (AI → Capabilities).' },
  handler: async (ctx) => {
    await member(ctx);
    const m = await one<Row>(ctx, 'select pulse.agent_ui_mine() v');
    const rank = (l: string) => ['off', 'view', 'act', 'admin'].indexOf(l), level = String(m.level), allows = (m.allows as Row[]) ?? [];
    return { level, levels: SCREEN.levels, alwaysAllowed: allows.map((a) => String(a.action)),
      actions: SCREEN.actions.map((a) => ({ name: a.name, level: a.level, now: rank(level) >= rank(a.level) || allows.some((x) => x.action === a.name && rank(String(x.level)) >= rank(a.level)) })) };
  },
});

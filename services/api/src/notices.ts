import { ORG_TZ, orgZone } from './org-time.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { attendanceEnabled } from './attendance-policy.js';
import { IMPORTANT_UNREAD, INBOX_VISIBLE } from './companion-inbox.js';
import { pingSettings } from './notification-policy.js';
import { fail, hr, type Tx, type Viewer } from './routes.js';
import { noticeCard, type NoticeAction } from './work.js';

// Rows straight from SQL, read by column name.
type Row = Record<string, any>;

// The notification panel (UX-NOTIFY): the R27 outbox as three groups, Needs your action, Mentions and Updates, each
// card carrying the actions its reader may take right there. Authorization is rechecked by every action's own route;
// this read only offers what the viewer could do. Chat messages fold into one card per conversation.

type Priority = 'urgent' | 'needs_you' | 'fyi';
type Card = Row & { group: 'action' | 'mention' | 'update'; actions: NoticeAction[]; state: string; open: { label: string; href: string }; ids: string[]; priority?: Priority; family?: string; stack?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHOTO = (alias: string) => `(select ph.updated_at from pulse.person_photo ph where ph.person_id=${alias}.id)`;
const MENTIONS = new Set(['chat.mention', 'chat.reply', 'task.mention', 'project.mention', 'task.reply']);
const FLOW_KIND: Record<string, string> = { leave: 'leave', correction: 'an attendance correction', work: 'to work on a day off', request: 'an HR request' };
const FLOW_LABEL: Record<string, string> = { leave: 'Leave', correction: 'Attendance correction', work: 'Work on a day off', request: 'HR request' };
const first = (name: unknown) => String(name ?? 'Someone').replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, '').split(' ')[0];
const day = (iso: unknown) => typeof iso === 'string' ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';
const span = (from: unknown, to: unknown) => from ? (to && to !== from ? `${day(from)} – ${day(to)}` : day(from)) : '';

/** Unread conversations, one card each: the newest message, its author and how many are waiting. */
async function chatCards(c: PoolClient, rows: Row[]): Promise<Card[]> {
  const byChannel = new Map<string, Row[]>();
  for (const n of rows) { const list = byChannel.get(String(n.channelId)) ?? []; list.push(n); byChannel.set(String(n.channelId), list); }
  if (!byChannel.size) return [];
  const newest = [...byChannel.values()].map((list) => list[0].messageId).filter(Boolean);
  const messages = new Map((await c.query(`select m.id,m.channel_id "channelId",left(regexp_replace(m.body,'\\s+',' ','g'),180) body,m.created_at "messageAt",a.id "authorId",a.display_name "authorName",${PHOTO('a')} "authorPhotoAt",
    ch.kind "channelKind",case when ch.kind='direct' then null else ch.name end "channelName"
   from pulse.chat_message m join pulse.chat_channel ch on ch.id=m.channel_id left join pulse.person a on a.id=m.author_id where m.id=any($1::uuid[]) and m.removed_at is null`, [newest])).rows.map((m) => [m.channelId, m]));
  return [...byChannel.entries()].map(([channel, list]) => {
    const n = list[0], m = messages.get(channel);
    const unread = list.filter((x) => !x.readAt);
    const mention = list.some((x) => MENTIONS.has(String(x.eventType)) && !x.readAt) || MENTIONS.has(String(n.eventType));
    const who = m?.authorName ? first(m.authorName) : 'Someone';
    const where = m?.channelName ? ` in ${m.channelName}` : '';
    const title = mention ? `${who} mentioned you${where}` : unread.length > 1 ? `${unread.length} new messages${where || ` from ${who}`}` : `${who}${where ? ` wrote${where}` : ' sent you a message'}`;
    return {
      id: String(n.id), ids: list.map((x) => String(x.id)), kind: n.kind, eventType: n.eventType, title, body: m?.body || null, href: n.href, at: n.at, readAt: unread.length ? null : n.readAt,
      active: true, unread: unread.length, channelId: channel, from: m?.authorId ? { id: m.authorId, name: m.authorName, photoAt: m.authorPhotoAt } : null, subject: { type: 'chat', id: channel, title: m?.channelName ?? m?.authorName ?? 'Chats' },
      group: mention ? 'mention' : 'update', state: 'open', open: { label: 'Open chat', href: String(n.href ?? '/chats') },
      // ATT: a conversation needs you when anything unread in it does (a direct message, a mention, a reply).
      priority: mention || unread.some((x) => x.priority !== 'fyi') ? 'needs_you' : 'fyi', family: mention ? 'mentions' : 'chats',
      actions: [{ key: 'reply', label: 'Reply', tone: 'primary', method: 'POST', path: `/api/v0/chats/${channel}/messages`, body: { clientId: 'new', ...(n.href && /[?&]thread=([0-9a-f-]{36})/.test(String(n.href)) ? { parentId: String(n.href).match(/[?&]thread=([0-9a-f-]{36})/)![1] } : {}) },
        fields: [{ key: 'body', label: `Reply to ${who}`, type: 'text' }], done: 'Sent' }],
    };
  });
}

/** HR requests waiting on the viewer: Approve, or Reject with a reason (the decision route requires one). */
async function flowCards(c: PoolClient, v: Viewer, rows: Row[]): Promise<Card[]> {
  if (!rows.length) return [];
  const attendance = await attendanceEnabled(c);
  const flows = new Map((await c.query(`select f.id,f.kind,f.status,f.stage,f.needs_hr "needsHr",f.person_id "personId",p.display_name name,${PHOTO('p')} "photoAt",f.from_date::text "fromDate",f.to_date::text "toDate",
    (f.person_id<>$1 and f.status='pending' and ((f.stage='cofounder' and pulse.hr_is_cofounder()) or (f.stage='hr' and $2) or (f.stage='pod_head' and ($2 or pulse.hr_head(f.person_id)=$1)))) "canDecide"
   from pulse.hr_flow f join pulse.person p on p.id=f.person_id where f.id=any($3::uuid[])`, [v.person, hr(v), rows.map((n) => n.subjectId)])).rows.map((f) => [f.id, f]));
  return rows.map((n) => {
    const f = flows.get(n.subjectId);
    const waiting = !!f && ['approval.waiting', 'approval.reminder'].includes(String(n.eventType));
    const decide = waiting && f.canDecide && n.active && (f.kind !== 'correction' || attendance);
    const when = f ? span(f.fromDate, f.toDate) : '';
    // "Rifob asks to work on a day off", not "asks for to work".
    const asks = f ? (f.kind === 'work' ? `asks ${FLOW_KIND.work}` : `asks for ${FLOW_KIND[f.kind] ?? 'a decision'}`) : '';
    const title = waiting && f ? `${first(f.name)} ${asks}${when ? ` · ${when}` : ''}` : String(n.title);
    const state = !f ? (n.active ? 'open' : 'expired') : f.status === 'pending' ? (n.active ? 'open' : 'expired') : String(f.status);
    // POLISH-2 (QA-E2E P1-9): someone who sees a request but does not decide it is told who does, and why (a pod head
    // saw "Ishaan asks for leave" with no buttons and no reason when the leave needed HR).
    const reasons = (f?.needsHr ?? []) as string[];
    const body = waiting && f && f.status === 'pending' && !decide && f.personId !== v.person
      ? f.stage === 'hr' ? `HR decides this one${reasons.length ? `: ${reasons.join(', ')}` : ''}. Nothing for you to do.`
        : f.stage === 'cofounder' ? 'A co-founder decides this one. Nothing for you to do.' : null
      : null;
    return {
      ...n, ids: [String(n.id)], title, body, from: f && f.personId !== v.person ? { id: f.personId, name: f.name, photoAt: f.photoAt } : null, subject: f ? { type: 'hr_flow', id: f.id, title: FLOW_LABEL[f.kind] ?? f.kind } : null,
      state, group: decide ? 'action' : 'update', open: { label: 'Open', href: String(n.href || '/me') },
      actions: decide ? [
        { key: 'approve', label: 'Approve', tone: 'primary', method: 'POST', path: `/api/v0/hr/flows/${f.id}/decision`, body: { action: 'approved' }, done: 'Approved' },
        { key: 'reject', label: 'Reject', tone: 'neutral', method: 'POST', path: `/api/v0/hr/flows/${f.id}/decision`, body: { action: 'rejected' }, fields: [{ key: 'note', label: 'Reason (shared with them)', type: 'text' }], done: 'Rejected' },
      ] : [],
    };
  });
}

const RANK: Record<Priority, number> = { urgent: 0, needs_you: 1, fyi: 2 };
/** A card's priority: the notification's own (0860), raised to "needs you" when the card asks for a decision or a reply. */
function prioritise(card: Card): Card {
  const own = (['urgent', 'needs_you', 'fyi'].includes(String(card.priority)) ? card.priority : 'fyi') as Priority;
  const asks = (card.group === 'action' || card.group === 'mention') && card.state === 'open';
  return { ...card, priority: asks && own === 'fyi' ? 'needs_you' : own };
}
/** What a folded card says: "3 tasks assigned to you" instead of three cards. */
const STACK_TITLE: Record<string, (n: number) => string> = {
  tasks_assigned: (n) => `${n} tasks for you`, task_updates: (n) => `${n} task updates`, tasks_waiting: (n) => `${n} tasks wait on yours`,
  tasks_due: (n) => `${n} tasks due soon`, reviews: (n) => `${n} reviews to do`, approvals: (n) => `${n} requests wait for your decision`,
  my_requests: (n) => `${n} updates on your requests`, attendance_reminders: (n) => `${n} check-in reminders`, attendance_questions: (n) => `${n} attendance questions`,
  mentions: (n) => `${n} mentions`, processes: (n) => `${n} process updates`, domains: (n) => `${n} work-area updates`, company_updates: (n) => `${n} updates`,
  profile: (n) => `${n} profile updates`, pay: (n) => `${n} pay updates`, attendance_confirmations: (n) => `${n} attendance confirmations`,
};
type Stack = { id: string; title: string; body: string; family: string; priority: Priority; ids: string[]; cards: string[]; unread: number; at: string; href: string };
/**
 * The bell's order (ATT): urgent, then what needs you, then for your information; newest first within each. Two or
 * more cards of one family and priority on the same day fold into one stack ("3 tasks for you"); the cards stay in
 * `rows` (each names its `stack`), so anything reading one card still finds it. Conversations are one card each
 * already. Pure, so it is tested (test/notices-order.test.mjs).
 */
export function stackCards(cards: Card[]): { rows: Card[]; stacks: Stack[] } {
  const rows = [...cards].sort((a, b) => RANK[a.priority ?? 'fyi'] - RANK[b.priority ?? 'fyi'] || String(b.at).localeCompare(String(a.at)));
  const groups = new Map<string, Card[]>();
  for (const card of rows) {
    const family = String(card.family ?? '');
    if (card.channelId || !STACK_TITLE[family]) continue;
    const key = `${card.priority}|${family}|${String(card.at).slice(0, 10)}`;
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  const stacks: Stack[] = [], member = new Map<string, string>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const id = `stack:${list[0].id}`, family = String(list[0].family);
    for (const card of list) member.set(String(card.id), id);
    stacks.push({ id, title: STACK_TITLE[family](list.length), family, priority: list[0].priority ?? 'fyi', at: String(list[0].at), href: list[0].open.href,
      body: list.slice(0, 2).map((x) => String(x.title)).join(' · ') + (list.length > 2 ? ` · and ${list.length - 2} more` : ''),
      ids: list.flatMap((x) => x.ids), cards: list.map((x) => String(x.id)), unread: list.filter((x) => !x.readAt).length });
  }
  return { rows: rows.map((card) => member.has(String(card.id)) ? { ...card, stack: member.get(String(card.id)) } as Card : card), stacks };
}

export async function noticeList(c: PoolClient, v: Viewer, limit = 60) {
  if (!v.person) fail(403, 'Use your individual Pulse account');
  await c.query('select pulse.chat_refresh_soon()');
  // ATT: the one notification policy (migration 0860): priority and family by event type; quiet ones never pinged.
  const rows = (await c.query(`select n.id,n.kind,n.event_type "eventType",n.subject_type "subjectType",n.subject_id "subjectId",n.title,n.href,n.read_at "readAt",
    coalesce(n.priority,pulse.notification_priority(n.event_type)) priority,pulse.notification_family(n.event_type) family,n.quiet,
    to_char(n.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "at",n.expires_at>clock_timestamp() active,n.channel_id "channelId",n.message_id "messageId"
   from pulse.notification n where ${INBOX_VISIBLE} order by n.created_at desc,n.id desc limit 200`)).rows;
  const work = (n: Row) => /^(task|project|domain|pool)\./.test(String(n.eventType)) || n.eventType === 'ask.answered';
  const chats = await chatCards(c, rows.filter((n) => n.channelId));
  const flows = await flowCards(c, v, rows.filter((n) => !n.channelId && n.subjectType === 'hr_flow'));
  const tasks = await Promise.all(rows.filter((n) => !n.channelId && n.subjectType !== 'hr_flow' && work(n)).slice(0, 40).map(async (n) => {
    const card = await noticeCard(c, n, v.person!);
    const live = card.state === 'open' && card.actions.length > 0;
    // TASKS-4B: the reviews nudge needs action while anything waits, though its button is the link to the queue.
    const nudge = n.eventType === 'task.review_nudge' && card.state === 'open';
    return { ...card, ids: [String(n.id)], group: MENTIONS.has(String(n.eventType)) ? 'mention' : live || nudge ? 'action' : 'update',
      open: { label: nudge ? 'Review now' : 'Open', href: String(n.href || '/tasks') } } as Card;
  }));
  const rest: Card[] = rows.filter((n) => !n.channelId && n.subjectType !== 'hr_flow' && !work(n)).map((n) => ({
    ...n, ids: [String(n.id)], body: null, from: null, subject: null, actions: [], state: n.active ? 'open' : 'expired', group: 'update', open: { label: n.kind === 'policy' ? 'Read' : 'Open', href: String(n.href || '/me') },
  }));
  const ordered = stackCards([...chats, ...flows, ...tasks, ...rest].map(prioritise));
  const cards = ordered.rows.slice(0, limit), kept = new Set(cards.map((x) => String(x.id)));
  const stacks = ordered.stacks.filter((x) => x.cards.some((id) => kept.has(id)));
  const settings = pingSettings((await c.query('select settings from pulse.companion_notification_settings where person_id=$1', [v.person])).rows[0]?.settings, await orgZone(c));
  const unread = (group?: Card['group']) => cards.filter((x) => !x.readAt && (!group || x.group === group)).length;
  // Pip's hover summary: the viewer's own open tasks due today and overdue (the company's days, as everywhere in Work).
  const today = (await c.query(`select count(*) filter(where (t.due_at at time zone ${ORG_TZ})::date=(now() at time zone ${ORG_TZ})::date)::int due,
    count(*) filter(where (t.due_at at time zone ${ORG_TZ})::date<(now() at time zone ${ORG_TZ})::date)::int overdue
   from pulse.task t where coalesce(t.assignee_person_id,t.owner_id)=$1 and t.status in ('open','in_progress','blocked')`, [v.person])).rows[0];
  const important = Number((await c.query(`select ${IMPORTANT_UNREAD} important`)).rows[0].important);
  return { rows: cards, stacks, counts: { unread: unread(), action: cards.filter((x) => x.group === 'action').length, mention: unread('mention'), update: unread('update'), important }, dnd: !!settings.dnd, today };
}

/** Mark notifications read; a conversation's card also marks the conversation read up to its newest message. */
async function markRead(c: PoolClient, ids: string[] | null) {
  const where = ids ? `${INBOX_VISIBLE} and n.id=any($1::uuid[])` : INBOX_VISIBLE;
  const chats = (await c.query(`select n.channel_id channel,max(m.created_at)::text through from pulse.notification n join pulse.chat_message m on m.id=n.message_id
   where ${where} and n.read_at is null and n.channel_id is not null group by n.channel_id`, ids ? [ids] : [])).rows;
  const result = await c.query(`update pulse.notification n set read_at=coalesce(n.read_at,clock_timestamp()) where ${where} and n.read_at is null returning n.id`, ids ? [ids] : []);
  for (const chat of chats) await c.query('select pulse.chat_read($1,$2)', [chat.channel, chat.through]);
  return { ok: true, read: result.rowCount ?? 0, conversations: chats.length };
}

export function registerNoticeRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/notices', req => tx(req, async (c, v) => noticeList(c, v, Math.max(1, Math.min(100, Number((req.query as { limit?: string }).limit) || 60)))));
  app.post<{ Body: { ids?: unknown } }>('/api/v0/notices/read', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Use your individual Pulse account');
    const ids = req.body.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some((x) => typeof x !== 'string' || !uuid.test(x)) || Object.keys(req.body).some((k) => k !== 'ids')) fail(400, 'Choose up to 200 notifications');
    await c.query('select pulse.chat_refresh()');
    return markRead(c, ids as string[]);
  }));
  app.post('/api/v0/notices/read-all', req => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Use your individual Pulse account');
    await c.query('select pulse.chat_refresh()');
    return markRead(c, null);
  }));
}

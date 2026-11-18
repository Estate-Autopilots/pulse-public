import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { FROM } from './tasks.js';
import type { Tx, Viewer } from './routes.js';
import { embedQuery } from './wa-knowledge.js';

/** UX-5A: Ctrl+K's server half. The palette answers pages, settings, actions, people, client projects, clients and
 *  contacts from what the browser already holds (under 100 ms); this streams in what only the database knows: tasks,
 *  work projects, chats, SOPs, policies, offices and places. Each term is matched on its own (the palette sends the
 *  words Pip understood, e.g. "office internet" → office, wi-fi, network, ip); row security decides what the viewer may
 *  see, and chat messages only come from conversations the viewer is in. Read-only, a few small queries. */
type Hit = { id: string; title: string; sub?: string | null; href: string; kind: string; score: number; status?: string | null };
type Group = { key: string; label: string; items: Hit[] };

const like = (t: string) => `%${t.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
const clean = (x: unknown, max: number) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** The words to look for: the query's own words (two letters or more) and the extra terms the palette sends. */
export function searchTerms(q: string, extra: string) {
  const words = q.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((w) => w.length >= 2);
  const more = extra.toLowerCase().split(',').map((t) => t.trim()).filter((t) => t.length >= 2);
  return [...new Set([...more, ...words])].slice(0, 8);
}
/** How well a title answers the terms: every term found counts, a word start counts more, the whole query most. */
export function scoreTitle(title: string, q: string, terms: string[]) {
  const t = title.toLowerCase(); let s = 0;
  for (const term of terms) { const i = t.indexOf(term); if (i < 0) continue; s += i === 0 || /[^\p{L}\p{N}]/u.test(t[i - 1]) ? 2 : 1; }
  if (q && t.includes(q.toLowerCase())) s += 3;
  return s;
}

async function rows<T>(c: PoolClient, sql: string, args: unknown[]): Promise<T[]> {
  try { await c.query('savepoint search_part'); const r = (await c.query(sql, args)).rows as T[]; await c.query('release savepoint search_part'); return r; }
  // One source failing (a module switched off, a missing grant) never takes the others with it.
  catch { await c.query('rollback to savepoint search_part'); return []; }
}

export async function search(c: PoolClient, v: Viewer, q: string, terms: string[], vec: string | null = null): Promise<Group[]> {
  if (!terms.length) return [];
  const pats = terms.map(like);
  const any = (col: string) => `(${pats.map((_, i) => `${col} ilike $${i + 1}`).join(' or ')})`;
  const groups: Group[] = [];
  const add = (key: string, label: string, items: Hit[]) => { if (items.length) groups.push({ key, label, items: items.sort((a, b) => b.score - a.score).slice(0, 6) }); };
  const tasks = await rows<{ id: string; title: string; status: string; who: string | null; project: string | null }>(c,
    `select t.id,t.title,t.status,a.display_name who,coalesce(pr.title,pr.name) project from ${FROM}
     where t.deleted_at is null and (${any('t.title')} or ${any("coalesce(t.notes,'')")})
     order by (t.status in ('open','in_progress','blocked','in_review','done')) desc,t.updated_at desc nulls last limit 30`, pats);
  add('tasks', 'Tasks', tasks.map((t) => ({ id: t.id, title: t.title, sub: [t.who, t.project, t.status === 'in_progress' ? 'doing' : t.status === 'open' ? null : t.status.replace('_', ' ')].filter(Boolean).join(' · '),
    href: `/tasks/${t.id}`, kind: 'task', status: t.status, score: scoreTitle(t.title, q, terms) + (['open', 'in_progress', 'blocked'].includes(t.status) ? 1 : 0) })));
  const projects = await rows<{ id: string; title: string; kind: string; status: string | null }>(c,
    `select p.id,coalesce(p.title,p.name) title,w.kind,w.status from pulse.work_project w join pulse.project p on p.id=w.project_id
     where w.deleted_at is null and p.deleted_at is null and (${any('coalesce(p.title,p.name)')} or ${any("coalesce(w.summary,'')")}) order by w.updated_at desc nulls last limit 20`, pats);
  add('projects', 'Projects', projects.map((p) => ({ id: p.id, title: p.title, sub: p.kind === 'fulfilment' ? 'Client fulfilment' : 'Internal project', href: `/tasks/projects/${p.id}`, kind: 'project', score: scoreTitle(p.title, q, terms) })));
  if (v.person) {
    const channels = await rows<{ id: string; name: string; kind: string }>(c,
      `select ch.id,ch.name,ch.kind from pulse.chat_channel ch join pulse.chat_member m on m.channel_id=ch.id and m.person_id=$${pats.length + 1}
       where ${any("coalesce(ch.name,'')")} limit 10`, [...pats, v.person]);
    const messages = await rows<{ id: string; channel: string; name: string | null; body: string; at: string }>(c,
      `select msg.id,msg.channel_id channel,ch.name,msg.body,msg.created_at at from pulse.chat_message msg join pulse.chat_channel ch on ch.id=msg.channel_id
       join pulse.chat_member m on m.channel_id=msg.channel_id and m.person_id=$${pats.length + 1}
       where msg.removed_at is null and ${any('msg.body')} order by msg.created_at desc limit 8`, [...pats, v.person]);
    add('chats', 'Chats', [...channels.map((ch) => ({ id: ch.id, title: ch.name, sub: ch.kind === 'group' ? 'Group chat' : 'Chat', href: `/chats?channel=${ch.id}`, kind: 'chat', score: scoreTitle(ch.name, q, terms) + 1 })),
      ...messages.map((m) => ({ id: m.id, title: clean(m.body, 90), sub: m.name ? `In ${m.name}` : 'In a chat', href: `/chats?channel=${m.channel}&message=${m.id}`, kind: 'message', score: scoreTitle(m.body, q, terms) }))]);
    // WA-MEDIA (1100): files of imported WhatsApp chats whose description, summary or readable text has every term.
    const files = await rows<{ message_id: string; channel_id: string; chat: string | null; kind: string; class: string; alt: string | null }>(c,
      'select message_id, channel_id, chat, kind, class, alt from pulse.wa_media_search($1, 8)', [terms]);
    add('files', 'Files in chats', files.map((f) => ({ id: f.message_id, title: clean(f.alt ?? f.class.replace(/_/g, ' '), 90), sub: f.chat ? `In ${f.chat}` : 'In a chat',
      href: `/chats?channel=${f.channel_id}&message=${f.message_id}`, kind: 'file', score: scoreTitle(f.alt ?? '', q, terms) })));
    // WA-DATASETS (1099): the imported WhatsApp history the viewer may read, by meaning (when the server's embedder
    // answered) and words: a conversation piece, shown by its chat, dates and first original line.
    type HistoryHit = { chunkId: string; channelId: string; chat: string; messageId: string | null; firstAt: string; lastAt: string; score: number; preview: { author: string | null; text: string }[] };
    const hist = (await rows<{ r: HistoryHit[] }>(c, 'select pulse.wa_history_search($1) r', [JSON.stringify({ q, vec, limit: 4 })]))[0]?.r ?? [];
    const day = (t: string) => new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    add('history', 'Client history', hist.map((h, i) => ({ id: h.chunkId, title: clean(h.preview[0] ? `${h.preview[0].author ?? ''}: ${h.preview[0].text}` : h.chat, 90),
      sub: `${h.chat} · ${day(h.firstAt)}`, href: `/chats?channel=${h.channelId}${h.messageId ? `&message=${h.messageId}` : ''}`, kind: 'history', score: 4 - i })));
    // WA-AUDIO (1112): imported voice notes whose transcript has every term (the line around the first one).
    const voice = await rows<{ message_id: string; channel_id: string; chat: string | null; snippet: string }>(c,
      'select message_id, channel_id, chat, snippet from pulse.wa_transcript_search($1, 8)', [terms]);
    add('voice', 'Voice notes', voice.map((t) => ({ id: t.message_id, title: clean(t.snippet, 90), sub: t.chat ? `Voice note in ${t.chat}` : 'Voice note',
      href: `/chats?channel=${t.channel_id}&message=${t.message_id}`, kind: 'voice', score: scoreTitle(t.snippet, q, terms) })));
  }
  const sops = await rows<{ id: string; title: string; purpose: string | null }>(c,
    `select id,title,purpose from pulse.sop where (${any('title')} or ${any("coalesce(purpose,'')")}) order by updated_at desc nulls last limit 10`, pats);
  add('sops', 'SOPs', sops.map((s) => ({ id: s.id, title: s.title, sub: s.purpose ? clean(s.purpose, 80) : 'SOP', href: `/sops/${s.id}`, kind: 'sop', score: scoreTitle(s.title, q, terms) })));
  const policies = await rows<{ id: string; title: string; kind: string; status: string }>(c,
    `select distinct on (kind) id,title,kind,status from pulse.policy_document where (${any('title')} or ${any("coalesce(body,'')")}) order by kind,version desc`, pats);
  add('policies', 'Policies', policies.map((p) => ({ id: p.id, title: p.title, sub: p.status === 'published' ? 'Policy' : `Policy · ${p.status}`, href: `/me?tab=policies&doc=${p.kind}`, kind: 'policy', score: scoreTitle(p.title, q, terms) })));
  const offices = await rows<{ id: string; name: string }>(c, `select id,name from pulse.presence_office where active and ${any('name')} order by name limit 6`, pats);
  const places = await rows<{ id: string; name: string; kind: string | null }>(c,
    `select id,name,kind from pulse.place where ${any('name')} or exists(select 1 from unnest(coalesce(aliases,'{}')) x where ${pats.map((_, i) => `x ilike $${i + 1}`).join(' or ')}) order by name limit 8`, pats);
  add('places', 'Places', [...offices.map((o) => ({ id: o.id, title: o.name, sub: 'Office · check-in place', href: '/map', kind: 'office', score: scoreTitle(o.name, q, terms) + 1 })),
    ...places.map((p) => ({ id: p.id, title: p.name, sub: p.kind ? p.kind.replace(/_/g, ' ') : 'Place', href: '/map', kind: 'place', score: scoreTitle(p.name, q, terms) }))]);
  return groups;
}

export function registerSearchRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/search', (req) => tx(req, async (c, v) => {
    const query = req.query as { q?: string; terms?: string };
    const q = clean(query.q, 120), started = Date.now();
    const groups = await search(c, v, q, searchTerms(q, clean(query.terms, 300)), q.length >= 3 ? await embedQuery(q, 700) : null);
    return { q, groups, took: Date.now() - started };
  }));
}

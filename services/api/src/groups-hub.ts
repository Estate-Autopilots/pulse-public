// GROUPS-HUB (owner, 25 Oct 2026): every group of the agency in one place (type, segment, services, client, project,
// pod, area, period, status, members, activity, who is waiting), with search, saved views and bulk actions; AI
// employees placed in groups with a role (observer, assistant, coordinator) and asked for a summary, the tasks in a
// group or a reply draft; and a review queue for imported groups (link client and project, map senders, accept
// tasks one by one). Data: migration 1018 (chat_group_*), read through pulse.chat_group_hub() and friends.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { leadership, fail, type Open, type Tx, type Viewer } from './routes.js';
import { agentTxFor } from './agents.js';
import { bestMatch, groupKind, parseGroupName, similarity, type Parsed } from './group-names.js';

type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (raw: unknown, what = 'group') => (UUID.test(String(raw)) ? String(raw) : fail(400, `Choose a valid ${what}`));
const ids = (raw: unknown, max = 1000) => {
  if (!Array.isArray(raw) || !raw.length) fail(400, 'Choose at least one group');
  if ((raw as unknown[]).length > max) fail(400, `Choose up to ${max} groups`);
  return [...new Set((raw as unknown[]).map((x) => id(x)))];
};
const str = (raw: unknown, max = 200) => (typeof raw === 'string' ? raw.trim().slice(0, max) : '');
const member = (v: Viewer) => { if (!v.person) fail(403, 'The groups hub needs your individual employee account'); };
const KINDS = ['client', 'pod', 'team', 'internal', 'vendor', 'other'];
const STATUSES = ['active', 'quiet', 'closed', 'archived'];
const SEGMENTS = ['residential', 'plotting', 'luxury', 'commercial', 'mid'];
const body = { type: 'object' } as const;
type Q = PoolClient;

/** Pulse's clients, projects and known areas, for the name reader and the pickers. */
async function lookups(c: Q) {
  const clients = (await c.query(`select id, display_name name from pulse.client order by display_name`)).rows as { id: string; name: string }[];
  const projects = (await c.query(`select p.id, p.name, p.client_id "clientId", p.location, p.status from pulse.project p where p.deleted_at is null order by p.name`)).rows as { id: string; name: string; clientId: string | null; location: string | null; status: string }[];
  const areas = [...new Set(projects.map((p) => (p.location ?? '').split(',')[0].trim()).filter((a) => a && a.length <= 30))];
  return { clients, projects, areas };
}

/** Read names into facts: what the name says, the client and project it most likely is, and suggestions where unsure. */
async function classify(c: Q, rows: { id: string; name: string; channel_kind: string; created_at?: string | Date; imported_first?: string | Date | null; wa_client_id?: string | null; wa_project_id?: string | null }[]) {
  if (!rows.length) return 0;
  const lk = await lookups(c);
  const known = { clients: lk.clients.map((x) => x.name), projects: lk.projects.map((x) => x.name), areas: lk.areas };
  const out: Body[] = [], suggestions: Body[] = [];
  for (const g of rows) {
    const started = g.imported_first ?? g.created_at; const p: Parsed = parseGroupName(g.name, known, started ? new Date(started).getFullYear() : undefined);
    const kind = groupKind(g.channel_kind, p, g.name);
    // WA-IMPORT (1015) already tied an imported group to its client and project: that wins over a guess from the name.
    let clientId: string | null = g.wa_client_id ?? null, projectId: string | null = g.wa_project_id ?? null;
    const parsed: Body = { ...p, raw: g.name };
    if (kind === 'client' && !projectId) {
      let pm = bestMatch(p.project, lk.projects, (x) => x.name);
      const cm = bestMatch(p.client, lk.clients, (x) => x.name);
      // Several projects with the same name (a client's next phase, another month): the one whose client the name gives.
      if (pm && pm.score - pm.next < 0.08 && p.client) {
        const close = lk.projects.filter((x) => similarity(p.project ?? '', x.name) >= pm!.score - 0.02);
        const byClient = close.map((x) => ({ x, s: similarity(p.client!, lk.clients.find((c) => c.id === x.clientId)?.name ?? '') })).sort((a, b) => b.s - a.s);
        if (byClient[0] && byClient[0].s >= 0.8 && (byClient.length < 2 || byClient[0].s - byClient[1].s >= 0.15 || byClient[0].x.clientId === byClient[1].x.clientId))
          pm = { item: byClient[0].x, score: pm.score, next: 0 };
      }
      // Linked at once only when clear: a close match well ahead of the next one. Otherwise a suggestion to review.
      if (pm && pm.score >= 0.86 && pm.score - pm.next >= 0.08) projectId = pm.item.id;
      else if (pm && pm.score >= 0.5) suggestions.push({ channelId: g.id, kind: 'link_project', dedupe: pm.item.id, title: `Link to project ${pm.item.name}?`, detail: { projectId: pm.item.id, project: pm.item.name, read: p.project }, source: 'names', confidence: Math.min(0.999, pm.score).toFixed(3) });
      const proj = projectId ? lk.projects.find((x) => x.id === projectId) : null;
      if (cm && cm.score >= 0.86 && cm.score - cm.next >= 0.08) clientId = cm.item.id;
      else if (proj?.clientId) clientId = proj.clientId;
      else if (cm && cm.score >= 0.5) suggestions.push({ channelId: g.id, kind: 'link_client', dedupe: cm.item.id, title: `Link to client ${cm.item.name}?`, detail: { clientId: cm.item.id, client: cm.item.name, read: p.client }, source: 'names', confidence: Math.min(0.999, cm.score).toFixed(3) });
      if (!clientId && proj?.clientId) clientId = proj.clientId;
      parsed.match = { project: pm ? { name: pm.item.name, score: +pm.score.toFixed(2) } : null, client: cm ? { name: cm.item.name, score: +cm.score.toFixed(2) } : null };
    }
    const services = p.services.length ? p.services : kind === 'client' ? ['marketing'] : [];
    out.push({ channelId: g.id, kind, segments: p.segments.filter((s) => SEGMENTS.includes(s)), services, clientId, projectId,
      pod: p.pod !== null ? `Pod ${p.pod}` : null, area: p.area, city: p.city, period: p.month && /^\d{4}-\d{2}$/.test(p.month) ? `${p.month}-01` : null, parsed });
  }
  for (let i = 0; i < out.length; i += 500) await c.query('select pulse.chat_group_classify($1)', [JSON.stringify(out.slice(i, i + 500))]);
  if (suggestions.length) await c.query('select pulse.chat_group_suggest($1)', [JSON.stringify(suggestions)]);
  return out.length;
}

/** History lines that read like a request or an approval (imported groups, before any AI looks): cheap, local. */
const ASK = /\b(please|pls|plz|kindly|send|share|need|required|update|change|correction|revert|confirm|by (?:today|tomorrow|eod|monday|tuesday|wednesday|thursday|friday|saturday)|kal tak|aaj|jaldi|asap|urgent)\b/i;
const APPROVE = /\b(approved?|final(?:i[sz]ed)?|go ahead|looks good|ok done|confirmed)\b/i;
function scanHistory(lines: { id: string; author: string; body: string; at: string; side: string | null }[]) {
  const found: Body[] = [];
  for (const l of lines) {
    const b = l.body.replace(/\s+/g, ' ').trim();
    if (b.length < 12 || b.length > 400) continue;
    const kind = APPROVE.test(b) && l.side !== 'staff' ? 'approval' : ASK.test(b) ? 'task' : null;
    if (!kind) continue;
    found.push({ kind, dedupe: `h:${l.id}`, title: (kind === 'approval' ? `Approval: ` : '') + b.slice(0, 140), detail: { at: l.at, by: l.author, text: b.slice(0, 400), messageId: l.id }, source: 'history', confidence: '0.400' });
  }
  return found.slice(-8); // the latest few per group: a queue people can finish
}

/** What an AI job's answer means: a JSON object (read generously), or plain words as the text. */
function readAnswer(text: string): Body {
  const t = text.trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { const j = JSON.parse(m[0]); if (j && typeof j === 'object') return j as Body; } catch { /* plain words */ } }
  return { text: t.slice(0, 4000) };
}

function prompt(job: Body): string {
  const g = (job.group ?? {}) as Body;
  const kind = job.kind as string;
  const lines = [...((job.history as Body[]) ?? []).map((m) => `[${m.at}] ${m.author}: ${m.kind === 'media' ? '(media) ' : ''}${m.body}`),
    ...((job.messages as Body[]) ?? []).map((m) => `[${m.at}] ${m.author}${m.side === 'staff' || m.side === 'agent' ? '' : ' (client side)'}: ${m.body}${Number(m.files) ? ` (+${m.files} file)` : ''}`)];
  const tasks = ((job.openTasks as Body[]) ?? []).map((t) => `- ${t.title} (${t.status}${t.who ? `, ${t.who}` : ''}${t.due ? `, due ${t.due}` : ''})`);
  const facts = [`Group: ${g.name}`, g.client ? `Client: ${g.client}` : '', g.project ? `Project: ${g.project}` : '', g.area ? `Area: ${g.area}` : '', g.pod ? `Pod: ${g.pod}` : '',
    `Members: ${((g.members as Body[]) ?? []).map((p) => `${p.name}${p.side === 'staff' ? '' : p.side === 'agent' ? ' (AI)' : ' (client side)'}`).join(', ')}`,
    `Your role here: ${g.role ?? 'member'}. Today: ${job.now}. Asked by ${job.askedBy}.`].filter(Boolean);
  const ask = kind === 'summary'
    ? 'Summarise this group for the agency team. Answer only JSON: {"happening": "2-4 sentences", "pending": ["what is pending, with who and since when"], "waiting": ["who is waiting on whom, since when"], "risks": ["anything that needs a lead\'s attention"], "health": "good|watch|at_risk"}.'
    : kind === 'extract'
      ? 'List the work this group asked for that is not done yet, and approvals asked or given. Answer only JSON: {"items": [{"kind": "task" or "approval", "title": "short imperative", "who": "who should do it (name or empty)", "due": "YYYY-MM-DD or empty", "evidence": "the words in the chat", "confidence": 0.0-1.0}]}. Only what the messages say; no invented work; at most 15 items.'
      : `Draft the next reply for the agency in this group${g.clientFacing ? ' (clients read it: polite, short, specific; a person approves before it is sent)' : ''}. Answer only JSON: {"reply": "the message", "why": "one line"}.`;
  return [...facts, '', tasks.length ? `Open tasks:\n${tasks.join('\n')}` : 'Open tasks: none known', '', 'Messages (oldest first):', ...lines.slice(-200), '',
    job.note ? `Note from ${job.askedBy}: ${job.note}` : '', ask, 'Never invent facts, names, amounts or Pulse features.'].join('\n').slice(0, 60000);
}

export function registerGroupsHubRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  const agentTx = agentTxFor(open);

  app.get('/api/v0/chats/hub', (req) => tx(req, async (c, v) => {
    member(v);
    const rows0 = (await c.query('select * from pulse.chat_group_hub()')).rows;
    // Groups new to the hub, or renamed since they were read, are read now (what people set stays).
    const stale = rows0.filter((r) => !r.info || r.info.parsed?.raw !== r.name || (r.wa_project_id && !r.info.projectId && !r.info.manual?.includes('project')));
    if (stale.length) { await classify(c, stale); }
    const rows = stale.length ? (await c.query('select * from pulse.chat_group_hub()')).rows : rows0;
    const agents = (await c.query(`select p.id, p.display_name name, am.employee_id "employeeId", am.title, am.runtime_state "runtimeState", pp.username
      from pulse.agent_member am join pulse.person p on p.id = am.person_id left join pulse.people_profile pp on pp.person_id = p.id
      where am.disabled_at is null and p.status = 'active' order by p.display_name`)).rows;
    const people = (await c.query(`select p.id, p.display_name name, pp.pod, pp.username from pulse.person p left join pulse.people_profile pp on pp.person_id = p.id
      where p.side = 'staff' and p.status = 'active' order by p.display_name`)).rows;
    const lk = await lookups(c);
    // Client-side people (points of contact), for saying who an imported sender is.
    const contacts = (await c.query(`select p.id, p.display_name name, (select cl.display_name from pulse.client_contact cc join pulse.client cl on cl.id = cc.client_id where cc.person_id = p.id limit 1) client
      from pulse.person p where p.side = 'client' and p.status = 'active' order by p.display_name`)).rows;
    const views = (await c.query(`select id, name, query, shared, person_id = pulse.current_viewer() mine from pulse.chat_group_view order by shared desc, name`)).rows;
    return { groups: rows.map(shape), agents, people, contacts, clients: lk.clients, projects: lk.projects.map(({ location: _l, ...p }) => p), views, viewer: v.person, canLead: leadership(v) };
  }));

  // Read every name again (after the naming rules or Pulse's clients and projects changed); what people set stays.
  app.post('/api/v0/chats/hub/classify', (req) => tx(req, async (c, v) => {
    member(v); if (!leadership(v)) fail(403, 'Admins and leadership re-read all groups');
    const rows = (await c.query(`select id, name, channel_kind, created_at, imported_first, wa_client_id, wa_project_id from pulse.chat_group_hub()`)).rows;
    return { classified: await classify(c, rows) };
  }));

  app.post<{ Body: Body }>('/api/v0/chats/hub/set', { schema: { body } }, (req) => tx(req, async (c, v) => {
    member(v);
    const b = req.body, f = (b.fields ?? {}) as Body, out: Body = {};
    for (const [k, x] of Object.entries(f)) {
      if (k === 'kind') out.kind = x === null ? null : KINDS.includes(String(x)) ? x : fail(400, 'Choose a type');
      else if (k === 'status') out.status = x === null ? null : STATUSES.includes(String(x)) ? x : fail(400, 'Choose a status');
      else if (k === 'segments') out.segments = x === null ? null : Array.isArray(x) && x.every((s) => SEGMENTS.includes(String(s))) ? x : fail(400, 'Choose segments');
      else if (k === 'services' || k === 'tags' || k === 'addTags' || k === 'removeTags') out[k] = x === null ? null : Array.isArray(x) ? x.map((s) => str(s, 40)).filter(Boolean).slice(0, 20) : fail(400, `Choose ${k}`);
      else if (k === 'clientId' || k === 'projectId' || k === 'ownerId') out[k] = x === null ? null : id(x, k.replace('Id', ''));
      else if (k === 'pod' || k === 'area' || k === 'city') out[k] = x === null ? null : str(x, 60);
      else if (k === 'period') out.period = x === null ? null : /^\d{4}-\d{2}$/.test(String(x)) ? `${x}-01` : fail(400, 'Choose a month');
      else fail(400, `Unknown field ${k}`);
    }
    return { changed: (await c.query('select pulse.chat_group_set($1,$2) n', [ids(b.ids), JSON.stringify(out)])).rows[0].n };
  }));

  app.post<{ Body: Body }>('/api/v0/chats/hub/agents', { schema: { body } }, (req) => tx(req, async (c, v) => {
    member(v); const b = req.body;
    const role = b.role === null ? null : ['observer', 'assistant', 'coordinator'].includes(String(b.role)) ? String(b.role) : fail(400, 'Choose observer, assistant or coordinator');
    return { changed: (await c.query('select pulse.chat_group_agent_set($1,$2,$3) n', [ids(b.ids), id(b.agentId, 'AI employee'), role])).rows[0].n };
  }));

  app.post<{ Body: Body }>('/api/v0/chats/hub/people', { schema: { body } }, (req) => tx(req, async (c, v) => {
    member(v); const b = req.body;
    const people = Array.isArray(b.personIds) ? [...new Set((b.personIds as unknown[]).map((x) => id(x, 'person')))].slice(0, 50) : fail(400, 'Choose people');
    return { added: (await c.query('select pulse.chat_group_add_people($1,$2) n', [ids(b.ids), people])).rows[0].n };
  }));

  // Message text across groups: how many matches in each group the viewer is in (live and imported).
  app.get('/api/v0/chats/hub/search', (req) => tx(req, async (c, v) => {
    member(v); const q = str((req.query as Body).q, 200);
    if (q.length < 2) return { hits: [] };
    return { hits: (await c.query(`select channel_id "channelId", hits, imported from pulse.chat_group_search($1) order by hits desc limit 500`, [q])).rows };
  }));

  app.post<{ Body: Body }>('/api/v0/chats/hub/views', { schema: { body } }, (req) => tx(req, async (c, v) => {
    member(v); const b = req.body; const name = str(b.name, 60) || fail(400, 'Name the view');
    const query = b.query && typeof b.query === 'object' ? b.query : fail(400, 'Nothing to save');
    return { id: (await c.query('select pulse.chat_group_view_save($1,$2,$3,$4) id', [b.id ? id(b.id, 'view') : null, name, JSON.stringify(query), !!b.shared])).rows[0].id };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/chats/hub/views/:id/delete', (req) => tx(req, async (c, v) => {
    member(v); await c.query('select pulse.chat_group_view_delete($1)', [id(req.params.id, 'view')]); return { ok: true };
  }));

  // One group: facts, members, AI employees, tasks, files, open suggestions and the latest AI answers.
  app.get<{ Params: { id: string } }>('/api/v0/chats/hub/groups/:id', (req) => tx(req, async (c, v) => {
    member(v); const gid = id(req.params.id);
    const g = (await c.query('select * from pulse.chat_group_hub() where id = $1', [gid])).rows[0] ?? fail(404, 'Group not found');
    const members = (await c.query(`select p.id, p.display_name name, p.side, cm.role, pp.pod, pp.username, (select role from pulse.chat_group_agent ga where ga.channel_id = $1 and ga.agent_id = p.id) "aiRole"
      from pulse.chat_member cm join pulse.person p on p.id = cm.person_id left join pulse.people_profile pp on pp.person_id = p.id
      where cm.channel_id = $1 and p.status = 'active' order by p.side = 'agent', p.side <> 'staff', cm.role = 'admin' desc, p.display_name`, [gid])).rows;
    const tasks = (await c.query(`select t.id, t.title, t.status, t.due_at "dueAt", (select display_name from pulse.person where id = t.assignee_person_id) assignee
      from pulse.task t left join pulse.chat_group_info g on g.channel_id = $1
      where t.deleted_at is null and ((g.project_id is not null and t.project_id = g.project_id) or exists (select 1 from pulse.chat_task_follow f where f.task_id = t.id and f.channel_id = $1))
      order by t.status in ('done','accepted','cancelled'), t.due_at nulls last limit 30`, [gid])).rows;
    const files = g.member ? (await c.query(`select a->>'id' id, a->>'name' name, a->>'mime' mime, m.created_at at from pulse.chat_message m, jsonb_array_elements(m.attachments) a
      where m.channel_id = $1 and m.removed_at is null order by m.created_at desc limit 12`, [gid])).rows : [];
    const suggestions = (await c.query(`select id, kind, title, detail, source, confidence, created_at "createdAt" from pulse.chat_group_suggestion where channel_id = $1 and state = 'open' order by kind, created_at limit 60`, [gid])).rows;
    const jobs = (await c.query(`select distinct on (kind) j.id, j.kind, j.status, j.result, j.error, j.created_at "createdAt", j.finished_at "finishedAt", p.display_name agent, j.agent_id "agentId"
      from pulse.chat_group_ai_job j join pulse.person p on p.id = j.agent_id where j.channel_id = $1 order by kind, j.created_at desc`, [gid])).rows;
    const talkers = g.member ? (await c.query(`select p.display_name name, p.side, count(*)::int n from pulse.chat_message m join pulse.person p on p.id = m.author_id
      where m.channel_id = $1 and m.removed_at is null and m.kind = 'text' and m.created_at > now() - interval '30 days' group by 1, 2 order by 3 desc limit 5`, [gid])).rows : [];
    const unmapped = (await c.query(`select label, messages, first_at "firstAt", last_at "lastAt" from pulse.chat_group_unmapped_senders() where channel_id = $1 order by messages desc limit 40`, [gid])).rows;
    return { group: shape(g), members, tasks, files, suggestions, jobs, talkers, unmapped, canManage: (await c.query('select pulse.chat_group_manages($1) m', [gid])).rows[0].m };
  }));

  // The review queue across groups (open suggestions, unmapped senders, client groups not linked yet).
  app.get('/api/v0/chats/hub/review', (req) => tx(req, async (c, v) => {
    member(v);
    const suggestions = (await c.query(`select s.id, s.channel_id "channelId", ch.name "group", s.kind, s.title, s.detail, s.source, s.confidence, s.created_at "createdAt"
      from pulse.chat_group_suggestion s join pulse.chat_channel ch on ch.id = s.channel_id where s.state = 'open'
      order by case s.kind when 'link_project' then 0 when 'link_client' then 1 when 'map_sender' then 2 when 'approval' then 3 else 4 end, s.confidence desc nulls last, s.created_at limit 600`)).rows;
    const senders = (await c.query(`select u.channel_id "channelId", ch.name "group", u.label, u.messages, u.first_at "firstAt", u.last_at "lastAt"
      from pulse.chat_group_unmapped_senders() u join pulse.chat_channel ch on ch.id = u.channel_id order by u.messages desc limit 600`)).rows;
    const done = (await c.query(`select count(*) filter (where state = 'accepted')::int accepted, count(*) filter (where state = 'dismissed')::int dismissed,
      count(*) filter (where state <> 'open' and decided_at > now() - interval '1 day')::int today from pulse.chat_group_suggestion`)).rows[0];
    return { suggestions, senders, done };
  }));

  // Look through a group's imported history for requests and approvals (members of the group only).
  app.post<{ Params: { id: string } }>('/api/v0/chats/hub/groups/:id/scan', (req) => tx(req, async (c, v) => {
    member(v); const gid = id(req.params.id);
    const lines = (await c.query(`select id, author, body, at, side from pulse.chat_group_history_lines($1, 600)`, [gid])).rows;
    if (!lines.length) return { added: 0, note: 'No imported history you can read here (only the group\'s members read it).' };
    const found = scanHistory(lines).map((s) => ({ ...s, channelId: gid }));
    return { added: found.length ? (await c.query('select pulse.chat_group_suggest($1) n', [JSON.stringify(found)])).rows[0].n : 0, looked: lines.length };
  }));

  // Every imported group the viewer reads, looked through at once (up to 300 groups; members and admins only).
  app.post('/api/v0/chats/hub/scan-all', (req) => tx(req, async (c, v) => {
    member(v);
    const groups = (await c.query(`select id from pulse.chat_group_hub() where imported > 0 order by last_at desc nulls last limit 300`)).rows;
    let added = 0, looked = 0, read = 0;
    for (const g of groups) {
      const lines = (await c.query(`select id, author, body, at, side from pulse.chat_group_history_lines($1, 600)`, [g.id])).rows;
      if (!lines.length) continue;
      read++; looked += lines.length;
      const found = scanHistory(lines).map((s) => ({ ...s, channelId: g.id }));
      if (found.length) added += (await c.query('select pulse.chat_group_suggest($1) n', [JSON.stringify(found)])).rows[0].n;
    }
    return { added, looked, groups: read };
  }));

  // Accept a suggestion: link, map, or make the task (assignee, due, project) and follow it in the group.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/chats/hub/suggestions/:id/accept', { schema: { body } }, (req) => tx(req, async (c, v) => {
    member(v); const sid = id(req.params.id, 'suggestion'); const b = req.body;
    const s = (await c.query('select * from pulse.chat_group_suggestion where id = $1', [sid])).rows[0] ?? fail(404, 'Suggestion not found');
    if (s.state !== 'open') fail(409, 'Already decided');
    let result: string | null = null;
    if (s.kind === 'link_project') {
      const pid = id(b.projectId ?? s.detail.projectId, 'project');
      const client = (await c.query('select client_id from pulse.project where id = $1', [pid])).rows[0]?.client_id ?? null;
      await c.query('select pulse.chat_group_set($1,$2)', [[s.channel_id], JSON.stringify({ projectId: pid, ...(client ? { clientId: client } : {}) })]);
      result = pid;
    } else if (s.kind === 'link_client') {
      result = id(b.clientId ?? s.detail.clientId, 'client');
      await c.query('select pulse.chat_group_set($1,$2)', [[s.channel_id], JSON.stringify({ clientId: result })]);
    } else if (s.kind === 'map_sender') {
      result = id(b.personId ?? s.detail.personId, 'person');
      await c.query('select pulse.chat_group_map_sender($1,$2,$3)', [s.channel_id, s.detail.label, result]);
    } else {
      const g = (await c.query('select project_id from pulse.chat_group_info where channel_id = $1', [s.channel_id])).rows[0];
      const fields: Body = { title: str(b.title, 200) || String(s.title).replace(/^Approval: /, '').slice(0, 200) };
      if (b.assigneeId) fields.assigneeId = id(b.assigneeId, 'person');
      if (b.dueOn && /^\d{4}-\d{2}-\d{2}$/.test(String(b.dueOn))) fields.dueOn = b.dueOn;
      if (g?.project_id) fields.projectId = g.project_id;
      fields.notes = `From the group "${(await c.query('select name from pulse.chat_channel where id = $1', [s.channel_id])).rows[0].name}"${s.detail.by ? `, ${s.detail.by}` : ''}${s.detail.at ? ` on ${s.detail.at}` : ''}: ${String(s.detail.text ?? s.detail.evidence ?? '').slice(0, 600)}`;
      result = (await c.query('select pulse.task_save(null,$1) id', [JSON.stringify(fields)])).rows[0].id;
      // Its updates post in the group when the viewer may follow it there (a savepoint: a refusal must not undo the task).
      await c.query('savepoint follow');
      try { await c.query('select pulse.chat_task_follow_set($1,$2,true)', [result, s.channel_id]); await c.query('release savepoint follow'); }
      catch { await c.query('rollback to savepoint follow'); }
    }
    await c.query('select pulse.chat_group_suggestion_decide($1,$2,$3)', [sid, 'accepted', result]);
    return { ok: true, result };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/chats/hub/suggestions/:id/dismiss', { schema: { body } }, (req) => tx(req, async (c, v) => {
    member(v); await c.query('select pulse.chat_group_suggestion_decide($1,$2,null)', [id(req.params.id, 'suggestion'), req.body.undo ? 'open' : 'dismissed']); return { ok: true };
  }));
  // Map an imported sender (no suggestion row needed: the queue lists senders straight from the history).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/chats/hub/groups/:id/map-sender', { schema: { body } }, (req) => tx(req, async (c, v) => {
    member(v); const label = str(req.body.label, 80) || fail(400, 'Choose a sender');
    return { mapped: (await c.query('select pulse.chat_group_map_sender($1,$2,$3) n', [id(req.params.id), label, id(req.body.personId, 'person')])).rows[0].n };
  }));

  // Ask an AI employee in the group (summary, tasks, draft); poll the job.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/chats/hub/groups/:id/ask', { schema: { body } }, (req) => tx(req, async (c, v) => {
    member(v); const b = req.body;
    return { id: (await c.query('select pulse.chat_group_ai_ask($1,$2,$3,$4) id', [id(req.params.id), id(b.agentId, 'AI employee'), str(b.kind, 20), str(b.note, 500) || null])).rows[0].id };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/chats/hub/jobs/:id', (req) => tx(req, async (c, v) => {
    member(v);
    return (await c.query(`select j.id, j.kind, j.status, j.result, j.error, j.engine, j.created_at "createdAt", j.finished_at "finishedAt", p.display_name agent
      from pulse.chat_group_ai_job j join pulse.person p on p.id = j.agent_id where j.id = $1`, [id(req.params.id, 'job')])).rows[0] ?? fail(404, 'Not found');
  }));

  // The AI employee's runtime: claim a job (with the prompt Pulse built), hand back the answer.
  app.post('/api/v0/agent/groups/claim', (req) => agentTx(req, async (c) => {
    const job = (await c.query('select pulse.chat_group_ai_claim($1) j', [process.env.PULSE_GROUP_AI_HISTORY === '1'])).rows[0].j as Body | null;
    if (!job) return { job: null };
    return { job: { id: job.id, kind: job.kind, prompt: prompt(job), maxOut: job.maxOut, tier: job.kind === 'draft' ? 'fast' : 'strong' } };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/groups/jobs/:id', { schema: { body: { type: 'object', maxProperties: 10 } }, bodyLimit: 200_000 }, (req) => agentTx(req, async (c) => {
    const b = req.body, jid = id(req.params.id, 'job');
    const done = b.state === 'done';
    const result = done ? readAnswer(String(b.text ?? '')) : null;
    const kind = (await c.query('select kind from pulse.chat_group_ai_job where id = $1', [jid])).rows[0]?.kind;
    await c.query('select pulse.chat_group_ai_finish($1,$2,$3,$4,$5,$6,$7) ch', [jid, done ? 'done' : 'failed', result ? JSON.stringify(result) : null,
      done ? null : str(b.error, 300) || 'No AI engine was free', str(b.engine, 80) || null, Number.isFinite(Number(b.tokensIn)) ? Math.round(Number(b.tokensIn)) : null,
      Number.isFinite(Number(b.tokensOut)) ? Math.round(Number(b.tokensOut)) : null]);
    if (done && kind === 'extract' && Array.isArray(result?.items)) {
      const rows = (result.items as Body[]).filter((x) => x && typeof x.title === 'string').slice(0, 15).map((x) => ({
        kind: x.kind === 'approval' ? 'approval' : 'task', dedupe: `ai:${String(x.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120)}`,
        title: String(x.title).slice(0, 200), detail: { who: str(x.who, 80), due: /^\d{4}-\d{2}-\d{2}$/.test(String(x.due)) ? x.due : null, evidence: str(x.evidence, 400), text: str(x.evidence, 400) },
        confidence: Math.max(0, Math.min(0.999, Number(x.confidence) || 0.6)).toFixed(3) }));
      if (rows.length) await c.query('select pulse.chat_group_ai_suggest($1,$2)', [jid, JSON.stringify(rows)]);
    }
    // A summary's health is kept on the group inside chat_group_ai_finish (1027).
    return { ok: true };
  }));
}

/** One row of the hub, in the web's words. */
function shape(r: Body) {
  const info = (r.info ?? {}) as Body;
  const last = r.last_at ? new Date(String(r.last_at)).getTime() : 0;
  const days = last ? (Date.now() - last) / 86400000 : Infinity;
  const status = (info.status as string) ?? (days <= 14 ? 'active' : 'quiet');
  // Health: what a person or an AI summary set, else read from WA-IMPORT's signals (churn risk; complaints).
  const ins = (r.insight ?? null) as { signals?: Record<string, number>; sentiment?: number; stages?: string[] } | null;
  const sig = ins?.signals ?? {}, msgs = Number(r.imported) || 1;
  const derived = !ins ? null : (sig.churn_risk ?? 0) > 0 ? 'at_risk' : (sig.complaint ?? 0) >= 3 && (sig.complaint ?? 0) / msgs > 0.03 ? 'watch' : 'good';
  return {
    id: r.id, name: r.name, channelKind: r.channel_kind, createdAt: r.created_at, member: r.member, myRole: r.my_role, members: r.members, clientSide: r.clients,
    memberIds: r.member_ids ?? [], agents: r.agents ?? [], lastAt: r.last_at, lastLiveAt: r.last_live_at, messages7: r.messages_7d, messages30: r.messages_30d, messages: r.messages,
    unread: r.unread, waitingSince: r.waiting_since, waitingWho: r.waiting_who, imported: r.imported, importedFirst: r.imported_first, importedLast: r.imported_last,
    unmapped: r.unmapped, suggestions: r.open_suggestions, openTasks: r.open_tasks, files: r.files, archivedByMe: r.archived_by_me, preview: r.preview,
    kind: info.kind ?? null, segments: info.segments ?? [], services: info.services ?? [], clientId: info.clientId ?? null, client: info.client ?? null,
    projectId: info.projectId ?? null, project: info.project ?? null, pod: info.pod ?? null, area: info.area ?? null, city: info.city ?? null, period: info.period ?? null,
    status, statusSet: !!info.status, ownerId: info.ownerId ?? null, owner: info.owner ?? null, tags: info.tags ?? [], health: info.health ?? derived, sentiment: info.sentiment ?? ins?.sentiment ?? null,
    stage: ins?.stages?.length ? ins.stages[ins.stages.length - 1] : null, insight: ins,
    healthNote: info.healthNote ?? null, parsed: info.parsed ?? null, manual: info.manual ?? [],
  };
}

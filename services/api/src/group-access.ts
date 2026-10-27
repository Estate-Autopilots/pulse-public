// GROUP-ACCESS (owner, 25 Oct 2026): who reads the company's client group conversations is an organisation setting
// (migration 1098): members only (the default), members + admins and leadership + pod heads for their pod's groups, or
// all staff. Admins and leadership change it in Settings → Chats. A colleague who may read a group they are not in
// browses it read-only (Chats → All client groups, the groups hub) and joins it to post. The database decides every read:
// a browsed conversation's rows open for one request and one conversation only (pulse.chat_browse).
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, leadership, type Tx, type Viewer } from './routes.js';
import { readNewNames } from './groups-hub.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (raw: unknown) => UUID.test(String(raw)) ? String(raw) : fail(400, 'Choose a valid conversation');
const member = (v: Viewer) => { if (!v.person) fail(403, 'Chats requires your individual employee account'); };
export const READERS = ['members', 'leaders', 'staff'] as const;
type Body = Record<string, unknown>;

/** How the viewer reads a conversation: as a member (or an admin's moderation, chat_has), by browsing it through the
 *  setting, or not at all. Browsing opens its rows for the rest of this transaction only. */
export async function readable(c: PoolClient, cid: string): Promise<'member' | 'browse' | null> {
  const r = (await c.query(`select case when pulse.chat_has($1) then 'member' when pulse.chat_browse($1) then 'browse' end r`, [cid])).rows[0]?.r ?? null;
  if (r === 'browse') await c.query("select set_config('pulse.chat_browse',$1,true)", [cid]);
  return r;
}

/** The setting and who it opens groups to, for Settings → Chats (counts only). */
async function summary(c: PoolClient, v: Viewer) {
  const r = (await c.query(`select pulse.chat_group_readers() readers, a.changed_at "changedAt", (select display_name from pulse.person where id = a.changed_by) "changedBy",
    pulse.chat_group_access_counts() counts, (select count(*)::int from pulse.person p where p.side = 'staff' and p.status = 'active') staff
    from (select 1) x left join pulse.chat_group_access a on a.org_id = pulse.current_org()`)).rows[0];
  const { counts, ...rest } = r;
  return { ...rest, clientGroups: counts?.clientGroups ?? 0, untyped: counts?.untyped ?? 0, canChange: leadership(v) };
}

export function registerGroupAccessRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const body = { type: 'object' } as const;
  // Settings → Chats: admins and leadership read and change the setting.
  app.get('/api/v0/chats/group-access', (req) => tx(req, async (c, v) => {
    member(v); if (!leadership(v)) fail(403, 'Admins and leadership decide who reads client group conversations');
    return summary(c, v);
  }));
  app.post<{ Body: Body }>('/api/v0/chats/group-access', { schema: { body } }, (req) => tx(req, async (c, v) => {
    member(v); if (!leadership(v)) fail(403, 'Admins and leadership decide who reads client group conversations');
    const readers = String(req.body.readers ?? '');
    if (!(READERS as readonly string[]).includes(readers)) fail(400, 'Choose members only, admins and leadership, or all staff');
    // Opening groups beyond their members: groups the hub has not typed yet are read from their names first, as the
    // groups hub does when it opens (an admin or leadership sees every group), so the setting covers them.
    if (readers !== 'members') await readNewNames(c, (await c.query('select * from pulse.chat_group_hub()')).rows, true);
    // The function checks the role again and records the change (record_change: org / chat_group_readers).
    await c.query('select pulse.chat_group_access_set($1)', [readers]);
    return summary(c, v);
  }));

  // Chats → All client groups: every client group the viewer reads, as a member or through the setting, latest first.
  app.get('/api/v0/chats/client-groups', (req) => tx(req, async (c, v) => {
    member(v);
    const groups = (await c.query(`select id, name, member, members, last_at "lastAt", photo_at "photoAt", client, pod, imported
      from pulse.chat_client_groups() order by last_at desc nulls last, name`)).rows;
    return { readers: (await c.query('select pulse.chat_group_readers() r')).rows[0].r, groups };
  }));

  // A group the viewer reads but is not in (not in their chat list): the conversation's header, read-only. A member
  // gets {member: true} (their list has it). An admin's moderation of a group they are not in opens the same way.
  app.get<{ Params: { id: string } }>('/api/v0/chats/:id/browse', (req) => tx(req, async (c, v) => {
    member(v); const cid = id(req.params.id);
    if (v.nativeDevice) fail(404, 'Conversation unavailable');
    if ((await c.query('select 1 from pulse.chat_member where channel_id=$1 and person_id=$2', [cid, v.person])).rows[0]) return { member: true };
    const how = await readable(c, cid);
    if (!how) fail(404, 'Conversation unavailable');
    const channel = (await c.query(`select ch.id, true "moderationOnly", $2::boolean browsing, ch.name, ch.kind, ch.description, ch.address, ch.photo_at "photoAt",
      pulse.connect_chat_label(ch.id) "withOrg", 0 unread, 0 mentions, pulse.chat_client_facing(ch.id) "clientFacing", 0 imported,
      (select count(*)::int from pulse.chat_member cm join pulse.person p on p.id = cm.person_id where cm.channel_id = ch.id and pulse.chat_current(p.id)) members,
      (select max(m.created_at) from pulse.chat_message m where m.channel_id = ch.id) "lastAt",
      case when ch.key like 'wa:%' then pulse.wa_native_channel(ch.id) end whatsapp
      from pulse.chat_channel ch where ch.id = $1 and ch.kind <> 'direct'`, [cid, how === 'browse'])).rows[0];
    if (!channel) fail(404, 'Conversation unavailable');
    return { channel };
  }));

  // "Join to post": the reader becomes a member (the database checks they may read it; members only stays closed).
  app.post<{ Params: { id: string } }>('/api/v0/chats/:id/join', (req) => tx(req, async (c, v) => {
    member(v); await c.query('select pulse.chat_group_join($1)', [id(req.params.id)]); return { ok: true };
  }));
}

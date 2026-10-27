-- migrate:up
-- GROUP-ACCESS (owner, 25 Oct 2026): who reads a company's client group conversations is an organisation setting.
-- "Client group conversations can be read by": members only (the default for every organisation: nothing changes when
-- this ships) / members, admins and leadership, and pod heads for their pod's groups / all staff. Changed only by an
-- admin or leadership, through pulse.chat_group_access_set, recorded in record_change (org / chat_group_readers).
--  * A client group is a group people made or imported from WhatsApp (key custom: or wa:, kind custom) whose type in
--    the groups hub is Client (chat_group_info.kind; the hub reads it from the name, a person may set it). DMs, pods,
--    teams, Google groups, operator chats and every group typed anything else stay with their members.
--  * Only active staff read through the setting. AI employees keep their own group roles (an agent session never
--    browses); client-side people, freelancers and seats of other organisations are unchanged (members + opt-in).
--  * Reading is read-only "browsing": nothing is written for the reader (no membership, read point or notification).
--    "Join to post" (pulse.chat_group_join) makes them a member. Every writer keeps chat_has (members), unchanged.
--  * Row security: the read policies of the conversation tables take one more branch, chat_browsing(channel): true
--    only for the one conversation a read request names in the transaction setting pulse.chat_browse and only while
--    chat_browse() allows it, so every other query reads exactly what it read before. One-object reads (a file, the
--    group photo, voice notes, the WhatsApp people and files) check chat_reads / chat_browse themselves.
--  * The groups hub lists the client groups a viewer may read (chat_group_hub's groups; their chat_group_info row).
--    The hub's other tables (suggestions, AI jobs, AI roles) stay with members and leaders.
-- Functions re-written here are their latest repository definitions with only the read check widened: chat_file_read
-- (0022), chat_group_photo_read (0148), chat_voice_state (0895), wa_file_open (1015), wa_native_channel,
-- wa_native_people, wa_native_voice (1051), chat_group_hub (1057).

create table pulse.chat_group_access (                       -- one row per organisation that has used the setting
 org_id uuid primary key references pulse.org(id),
 readers text not null default 'members' check (readers in ('members', 'leaders', 'staff')),
 changed_by uuid,                                           -- no foreign key (as 1048: smoke cleanups delete people)
 changed_at timestamptz not null default now());
alter table pulse.chat_group_access enable row level security;
alter table pulse.chat_group_access force row level security;
create policy tenant_isolation on pulse.chat_group_access using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse.chat_group_access from public;
grant select on pulse.chat_group_access to pulse_api;          -- read for Settings; written only by the function below
create trigger ea_ai_no_delete before delete on pulse.chat_group_access for each statement execute function pulse.agent_guard();
create trigger ea_ai_no_write before insert or update on pulse.chat_group_access for each statement execute function pulse.agent_guard();

create function pulse.chat_group_readers() returns text
 language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce((select readers from chat_group_access where org_id = current_org()), 'members')
$$;

-- The rule for one group from its own hub facts (type and pod are passed in, so the policy on chat_group_info can use it
-- without reading that table again). Whether the viewer is a member does not matter here.
create function pulse.chat_browse_allowed(p_channel uuid, p_kind text, p_pod text) returns boolean
 language sql stable security definer set search_path = pulse, pg_temp as $$
 select case when p_kind is distinct from 'client' then false else coalesce((
  select case when a.readers = 'members' or agent_session() is not null then false   -- the default costs one lookup
   else exists (select 1 from chat_channel ch where ch.org_id = current_org() and ch.id = p_channel and ch.kind = 'custom'
                 and (ch.key like 'custom:%' or ch.key like 'wa:%'))
    and exists (select 1 from person p where p.org_id = current_org() and p.id = current_viewer() and p.status = 'active' and p.side = 'staff')
    and (a.readers = 'staff' or viewer_is('admin', 'leadership') or (p_pod is not null and p_pod = any(work_head_pods())))
   end
  from (select chat_group_readers() readers) a), false) end
$$;

-- The hub record of a client group is seen by whoever may read the group through the setting, as well as before.
-- (The browse branch comes first: a single-row read then never builds the visible-groups list.)
drop policy sees on pulse.chat_group_info;
create policy sees on pulse.chat_group_info as restrictive for select
 using (pulse.chat_browse_allowed(channel_id, kind, pod) or channel_id in (select pulse.chat_group_visible()));

-- May the viewer read this group through the setting (member or not)?
create function pulse.chat_browse(p_channel uuid) returns boolean
 language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce((select chat_browse_allowed(g.channel_id, g.kind, g.pod) from chat_group_info g
   where g.org_id = current_org() and g.channel_id = p_channel), false)
$$;

-- Every client group the viewer may read through the setting.
create function pulse.chat_browse_ids() returns setof uuid
 language sql stable security definer set search_path = pulse, pg_temp as $$
 select g.channel_id from chat_group_info g
  where (select chat_group_readers()) <> 'members' and g.org_id = current_org() and g.kind = 'client'
    and chat_browse_allowed(g.channel_id, g.kind, g.pod)
$$;

-- Reads a conversation: its members (and admins' moderation, chat_has) or the setting.
create function pulse.chat_reads(p_channel uuid) returns boolean
 language sql stable security definer set search_path = pulse, pg_temp as $$
 select chat_has(p_channel) or chat_browse(p_channel)
$$;

-- The row-security branch: the one conversation this transaction asked to browse (pulse.chat_browse), if allowed.
create function pulse.chat_browsing(p_channel uuid) returns boolean
 language sql stable security definer set search_path = pulse, pg_temp as $$
 select case when p_channel::text is distinct from nullif(current_setting('pulse.chat_browse', true), '') then false
  else chat_browse(p_channel) end
$$;

alter policy member_read on pulse.chat_channel using (pulse.chat_has(id) or pulse.chat_browsing(id));
alter policy member_read on pulse.chat_message using (pulse.chat_has(channel_id) or pulse.chat_browsing(channel_id));
alter policy member_read on pulse.chat_member using (pulse.chat_has(channel_id) or pulse.chat_browsing(channel_id));
alter policy member_read on pulse.chat_poll using (pulse.chat_has(channel_id) or pulse.chat_browsing(channel_id));
alter policy member_read on pulse.chat_poll_vote using (pulse.chat_has(channel_id) or pulse.chat_browsing(channel_id));
alter policy member_read on pulse.chat_annotation using (pulse.chat_has(channel_id) or pulse.chat_browsing(channel_id));
alter policy member_read on pulse.chat_approval using (pulse.chat_has(channel_id) or pulse.chat_browsing(channel_id));
alter policy member_read on pulse.chat_guest using ((pulse.chat_has(channel_id) or pulse.chat_browsing(channel_id)) and pulse.chat_import_reads());
alter policy visible on pulse.chat_former_member using (pulse.chat_has(channel_id) or pulse.viewer_is('admin') or pulse.chat_browsing(channel_id));

-- The organisation's setting: an admin or leadership changes it; a change is recorded (record_change: org /
-- chat_group_readers, old -> new); asking for the value it already has changes and records nothing.
create function pulse.chat_group_access_set(p_readers text) returns text
 language plpgsql security definer set search_path = pulse, pg_temp as $$
declare was text;
begin
 if current_viewer() is null or agent_session() is not null or not viewer_is('admin', 'leadership')
  or not exists (select 1 from person where org_id = current_org() and id = current_viewer() and status = 'active' and side = 'staff') then
  raise exception 'Only an organisation admin or leadership changes who reads client group conversations' using errcode = '42501'; end if;
 if p_readers is null or p_readers not in ('members', 'leaders', 'staff') then
  raise exception 'Choose members only, admins and leadership, or all staff' using errcode = '22023'; end if;
 insert into chat_group_access(org_id) values (current_org()) on conflict (org_id) do nothing;
 select readers into was from chat_group_access where org_id = current_org() for update;
 if was is distinct from p_readers then
  update chat_group_access set readers = p_readers, changed_by = current_viewer(), changed_at = now() where org_id = current_org();
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
   values (current_org(), 'org', current_org(), 'chat_group_readers', was, p_readers, current_viewer());
 end if;
 return p_readers;
end $$;

-- "Join to post": a reader becomes a member, read up to now (what they read while browsing is not unread).
create function pulse.chat_group_join(p_channel uuid) returns void
 language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if exists (select 1 from chat_member where org_id = current_org() and channel_id = p_channel and person_id = current_viewer()) then return; end if;
 if not chat_browse(p_channel) then raise exception 'conversation unavailable' using errcode = '42501'; end if;
 insert into chat_member(org_id, channel_id, person_id, read_through) values (current_org(), p_channel, current_viewer(), clock_timestamp())
  on conflict do nothing;
 perform chat_event_line(p_channel, current_viewer(), 'joined');
end $$;

-- The client groups the viewer reads (as a member or through the setting), for Chats → Client groups. Staff only.
create function pulse.chat_client_groups() returns table (id uuid, name text, member boolean, members int, last_at timestamptz,
  photo_at timestamptz, client text, pod text, imported boolean)
 language sql stable security definer set search_path = pulse, pg_temp as $$
 with me as (select current_viewer() v where exists (select 1 from person p where p.org_id = current_org() and p.id = current_viewer()
   and p.status = 'active' and p.side = 'staff') and agent_session() is null),
 readable as (select cm.channel_id from chat_member cm, me where cm.org_id = current_org() and cm.person_id = me.v
   union select x from chat_browse_ids() x)
 select ch.id, ch.name, mine.person_id is not null,
   (select count(*)::int from chat_member cm join person p on p.id = cm.person_id where cm.channel_id = ch.id and p.status = 'active' and p.side <> 'agent'),
   (select max(m.created_at) from chat_message m where m.org_id = ch.org_id and m.channel_id = ch.id),
   ch.photo_at, (select display_name from client where id = g.client_id), g.pod, ch.key like 'wa:%'
  from chat_group_info g join chat_channel ch on ch.org_id = g.org_id and ch.id = g.channel_id cross join me
  left join chat_member mine on mine.channel_id = ch.id and mine.person_id = me.v
  where g.org_id = current_org() and g.kind = 'client' and ch.kind = 'custom' and (ch.key like 'custom:%' or ch.key like 'wa:%')
    and ch.id in (select channel_id from readable)
$$;

-- For Settings → Chats (admins and leadership): how many groups are client groups, and how many the hub has not typed.
create function pulse.chat_group_access_counts() returns jsonb
 language sql stable security definer set search_path = pulse, pg_temp as $$
 select case when viewer_is('admin', 'leadership') then jsonb_build_object(
   'clientGroups', (select count(*) from chat_channel ch join chat_group_info g on g.org_id = ch.org_id and g.channel_id = ch.id
      where ch.org_id = current_org() and ch.kind = 'custom' and (ch.key like 'custom:%' or ch.key like 'wa:%') and g.kind = 'client'),
   'untyped', (select count(*) from chat_channel ch where ch.org_id = current_org() and ch.kind = 'custom' and (ch.key like 'custom:%' or ch.key like 'wa:%')
      and not exists (select 1 from chat_group_info g where g.org_id = ch.org_id and g.channel_id = ch.id))) end
$$;

revoke all on function pulse.chat_group_readers(), pulse.chat_browse_allowed(uuid, text, text), pulse.chat_browse(uuid), pulse.chat_browse_ids(),
 pulse.chat_reads(uuid), pulse.chat_browsing(uuid), pulse.chat_group_access_set(text), pulse.chat_group_join(uuid), pulse.chat_client_groups(), pulse.chat_group_access_counts() from public;
grant execute on function pulse.chat_group_readers(), pulse.chat_browse_allowed(uuid, text, text), pulse.chat_browse(uuid), pulse.chat_browse_ids(),
 pulse.chat_reads(uuid), pulse.chat_browsing(uuid), pulse.chat_group_access_set(text), pulse.chat_group_join(uuid), pulse.chat_client_groups(), pulse.chat_group_access_counts() to pulse_api;

-- One-object reads: members or the setting.
create or replace function pulse.chat_file_read(p_file uuid) returns table(name text,mime text,bytes bytea) language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 return query select f.name,f.mime,f.bytes from pulse_priv.chat_file f where f.id=p_file and chat_reads(f.channel_id) and
 (f.person_id=current_viewer() or exists(select 1 from chat_message m where m.channel_id=f.channel_id and m.removed_at is null and m.attachments @> jsonb_build_array(jsonb_build_object('id',p_file::text))));
 perform audit_write('download','chat_file',p_file::text);
end $$;

create or replace function pulse.chat_group_photo_read(p_channel uuid) returns table(mime text,bytes bytea) language sql stable security definer set search_path=pulse,pg_temp as $$
 select f.mime,f.bytes from pulse_priv.chat_channel_photo f where f.org_id=current_org() and f.channel_id=p_channel and chat_reads(p_channel)
$$;

create or replace function pulse.chat_voice_state(p_channel uuid) returns table(message_id uuid,played boolean,played_by int,transcript text,transcript_state text)
 language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if not chat_reads(p_channel) then raise exception 'conversation unavailable' using errcode='42501'; end if;
 return query select m.id,
  exists(select 1 from chat_voice_play p where p.message_id=m.id and p.person_id=current_viewer()),
  (select count(*)::int from chat_voice_play p where p.message_id=m.id and p.person_id<>m.author_id),
  t.body, t.state
 from chat_message m left join pulse_priv.chat_voice_transcript t on t.message_id=m.id
 where m.org_id=current_org() and m.channel_id=p_channel and m.removed_at is null and m.created_at>clock_timestamp()-interval '400 days'
  and m.attachments @> '[{}]' and exists(select 1 from jsonb_array_elements(m.attachments) a where a ? 'voice')
 order by m.created_at desc limit 500;
end $$;

create or replace function pulse.wa_file_open(p_sha text) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object('sha256', f.sha256, 'mime', f.mime, 'size', f.size, 'kind', f.kind, 'parts', f.parts, 'meta', f.meta,
   'name', (select m.file_name from pulse_priv.wa_message m where m.org_id = f.org_id and m.file_sha256 = f.sha256 and m.file_name is not null limit 1))
 from pulse_priv.wa_file f where f.org_id = current_org() and f.sha256 = p_sha and f.complete and exists (
   select 1 from pulse_priv.wa_file o join pulse_priv.wa_message m on m.org_id = o.org_id and m.file_sha256 = o.sha256
   join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
   where o.org_id = f.org_id and o.sha256 = f.sha256
     and (wa_reader(m.chat_id) or exists (select 1 from pulse_priv.wa_chat c where c.org_id = m.org_id and c.id = m.chat_id and chat_browse(c.channel_id)))
   union all
   select 1 from pulse_priv.wa_file o join pulse_priv.wa_message m on m.org_id = o.org_id and m.file_sha256 = o.sha256
   join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
   where o.org_id = f.org_id and (o.meta->>'poster' = f.sha256 or o.meta->>'playable' = f.sha256)
     and (wa_reader(m.chat_id) or exists (select 1 from pulse_priv.wa_chat c where c.org_id = m.org_id and c.id = m.chat_id and chat_browse(c.channel_id))))
$$;

create or replace function pulse.wa_native_channel(p_channel uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object('chatId', c.id, 'messages', c.messages, 'firstAt', c.first_at, 'lastAt', c.last_at,
   'native', n.chat_id is not null, 'nativeMessages', n.messages, 'syncedAt', n.synced_at,
   'guests', (select count(*)::int from chat_guest g where g.org_id = c.org_id and g.channel_id = c.channel_id))
 from pulse_priv.wa_chat c left join pulse_priv.wa_native n on n.org_id = c.org_id and n.chat_id = c.id
 where c.org_id = current_org() and c.channel_id = p_channel and (wa_reader(c.id) or chat_browse(p_channel)) and chat_import_reads()
$$;

create or replace function pulse.wa_native_people(p_channel uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('participantId', pa.id, 'personId', pa.person_id, 'name', coalesce(p.display_name, pa.label),
     'kind', pa.kind, 'side', p.side, 'messages', pa.messages, 'firstAt', pa.first_at, 'lastAt', pa.last_at,
     'member', exists (select 1 from chat_member cm where cm.channel_id = c.channel_id and cm.person_id = pa.person_id),
     'optIn', (select o.state from client_contact_optin o where o.org_id = c.org_id and o.person_id = pa.person_id and viewer_is('admin', 'leadership')))
   order by pa.messages desc, pa.label), '[]'::jsonb)
 from pulse_priv.wa_chat c join pulse_priv.wa_participant pa on pa.org_id = c.org_id and pa.chat_id = c.id left join person p on p.id = pa.person_id
 where c.org_id = current_org() and c.channel_id = p_channel and (wa_reader(c.id) or chat_browse(p_channel)) and chat_import_reads() and pa.messages > 0
$$;

create or replace function pulse.wa_native_voice(p_channel uuid) returns table (message_id uuid, transcript text, language text)
language sql stable security definer set search_path = pulse, pg_temp as $$
 select m.id, t.text, t.language from chat_message m join pulse_priv.wa_transcript t on t.org_id = m.org_id and t.sha256 = m.attachments->0->>'wa'
 where m.org_id = current_org() and m.channel_id = p_channel and m.import_ref is not null and m.attachments->0 ? 'voice' and m.removed_at is null
   and chat_import_reads() and (exists (select 1 from pulse_priv.wa_chat c where c.org_id = m.org_id and c.channel_id = p_channel and wa_reader(c.id)) or chat_browse(p_channel))
$$;

-- The groups hub (1057's definition; the visible groups gain the client groups the viewer may read).
create or replace function pulse.chat_group_hub(p_only uuid default null) returns table (
  id uuid, name text, channel_kind text, created_at timestamptz, member boolean, my_role text, members int, clients int,
  member_ids uuid[], agents jsonb, last_at timestamptz, last_live_at timestamptz, messages_7d int, messages_30d int, messages int,
  unread int, waiting_since timestamptz, waiting_who text, imported int, imported_first timestamptz, imported_last timestamptz,
  unmapped int, open_suggestions int, open_tasks int, files int, info jsonb, archived_by_me boolean, preview text, wa_client_id uuid, wa_project_id uuid, insight jsonb)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  with v as (select current_viewer() me, viewer_is('admin', 'leadership') lead),
  chs as (select ch.* from chat_channel ch, v where ch.org_id = current_org() and ch.kind <> 'direct' and chat_active()
            and (p_only is null or ch.id = p_only)
            and (v.lead or exists (select 1 from chat_member cm where cm.channel_id = ch.id and cm.person_id = v.me)
                 -- GROUP-ACCESS: and the client groups the organisation lets this viewer read (read-only until they join).
                 or ch.id in (select pulse.chat_browse_ids()))),
  -- Imported history: R47's text imports (chat_import_*) and WA-IMPORT's lossless chats (1015 wa_*); unmapped = senders.
  imp0 as (select m.channel_id, count(*)::int n, min(m.sent_at) f, max(m.sent_at) l, count(distinct m.author_label) filter (where m.author_id is null)::int un, null::uuid cl, null::uuid pr, 0 fi
            from pulse_priv.chat_import_message m join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
           where m.org_id = current_org() and m.channel_id in (select chs.id from chs) group by 1
           union all
           select c.channel_id, c.messages, c.first_at, c.last_at,
             (select count(*)::int from pulse_priv.wa_participant pa where pa.org_id = c.org_id and pa.chat_id = c.id and pa.person_id is null and pa.kind in ('number', 'unknown')),
             c.client_id, c.project_id,
             (select coalesce(sum(f.value::int), 0)::int from jsonb_each_text(coalesce(c.counts->'files', '{}')) f where f.key like '%:attached')
            from pulse_priv.wa_chat c where c.org_id = current_org() and c.channel_id in (select chs.id from chs)),
  imp as (select channel_id, sum(n)::int n, min(f) f, max(l) l, sum(un)::int un, (array_agg(cl) filter (where cl is not null))[1] cl, (array_agg(pr) filter (where pr is not null))[1] pr,
            sum(fi)::int files from imp0 group by 1),
  -- WA-IMPORT's analysis (1016): the service stages seen in the chat, answer times and its sales and service signals.
  ins as (select c.channel_id, jsonb_strip_nulls(jsonb_build_object('stages', i.metrics->'stage_sequence', 'teamMin', i.metrics->'team_median_answer_min',
              'clientMin', i.metrics->'client_median_answer_min', 'daysToLive', i.metrics->'days_start_to_live', 'revisions', i.metrics->'revisions',
              'signals', (select jsonb_object_agg(z.kind, z.n) from (select s.kind, count(*) n from pulse_priv.wa_signal s where s.org_id = c.org_id and s.chat_id = c.id group by 1) z),
              'sentiment', (select round(avg(ms.sentiment)::numeric, 3) from pulse_priv.wa_message_signal ms where ms.org_id = c.org_id and ms.chat_id = c.id))) j
            from pulse_priv.wa_chat c left join pulse_priv.wa_insight i on i.org_id = c.org_id and i.subject = 'chat' and i.subject_id = c.id
           where c.org_id = current_org() and c.channel_id in (select chs.id from chs)),
  -- WA-NATIVE: imported messages are chat messages now; counted once (as imported: their files from the import's counts),
  -- never unread, waiting only when recent. Live counts read only live rows (chat_message_live, 1054).
  msg as (select m.channel_id, max(m.created_at) l, count(*) filter (where m.kind = 'text')::int n,
            count(*) filter (where m.kind = 'text' and m.created_at > now() - interval '7 days')::int n7,
            count(*) filter (where m.kind = 'text' and m.created_at > now() - interval '30 days')::int n30,
            coalesce(sum(jsonb_array_length(m.attachments)), 0)::int files
            from chat_message m where m.org_id = current_org() and m.removed_at is null and m.import_ref is null and m.channel_id in (select chs.id from chs) group by 1),
  tp as (select t.project_id, count(*)::int n from task t where t.org_id = current_org() and t.deleted_at is null and t.status not in ('done', 'accepted', 'cancelled')
           and t.project_id is not null group by 1),
  tf as (select f.channel_id, count(*)::int n from chat_task_follow f join task t on t.id = f.task_id
          where t.org_id = current_org() and t.deleted_at is null and t.status not in ('done', 'accepted', 'cancelled') group by 1),
  sg as (select s.channel_id, count(*)::int n from chat_group_suggestion s where s.org_id = current_org() and s.state = 'open' group by 1)
  select ch.id, ch.name, ch.kind, ch.created_at, mine.person_id is not null, mine.role,
    (select count(*)::int from chat_member cm join person p on p.id = cm.person_id where cm.channel_id = ch.id and p.status = 'active' and p.side <> 'agent'),
    (select count(*)::int from chat_member cm join person p on p.id = cm.person_id where cm.channel_id = ch.id and p.status = 'active' and p.side not in ('staff', 'agent')),
    (select array_agg(cm.person_id order by cm.joined_at) from (select cm.person_id, cm.joined_at from chat_member cm join person p on p.id = cm.person_id
       where cm.channel_id = ch.id and p.status = 'active' and p.side = 'staff' order by cm.role = 'admin' desc, cm.joined_at limit 6) cm),
    (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'role', coalesce(ga.role, 'profile')) order by p.display_name), '[]')
       from chat_member cm join person p on p.id = cm.person_id and p.side = 'agent'
       left join chat_group_agent ga on ga.channel_id = ch.id and ga.agent_id = p.id where cm.channel_id = ch.id),
    greatest(msg.l, imp.l), msg.l, coalesce(msg.n7, 0), coalesce(msg.n30, 0), coalesce(msg.n, 0) + coalesce(imp.n, 0),
    case when mine.person_id is null then 0 else (select count(*)::int from chat_message m where m.channel_id = ch.id and m.author_id <> v.me and m.import_ref is null
       and m.created_at > mine.read_through and m.removed_at is null and m.kind = 'text' and m.parent_id is null) end,
    w.at, w.who, coalesce(imp.n, 0), imp.f, imp.l, coalesce(imp.un, 0), coalesce(sg.n, 0),
    coalesce(case when g.project_id is not null then (select n from tp where tp.project_id = g.project_id) end, 0) + coalesce(tf.n, 0),
    coalesce(msg.files, 0) + coalesce(imp.files, 0),
    case when g.channel_id is null then null else jsonb_build_object('kind', g.kind, 'segments', g.segments, 'services', g.services,
      'clientId', g.client_id, 'client', (select display_name from client where id = g.client_id),
      'projectId', g.project_id, 'project', (select name from project where id = g.project_id),
      'pod', g.pod, 'area', g.area, 'city', g.city, 'period', to_char(g.period, 'YYYY-MM'), 'status', g.status,
      'ownerId', g.owner_id, 'owner', (select display_name from person where id = g.owner_id), 'tags', g.tags,
      'health', g.health, 'sentiment', g.sentiment, 'healthNote', g.health_note, 'parsed', g.parsed, 'manual', g.manual, 'classifiedAt', g.classified_at) end,
    mine.archived_at is not null,
    case when mine.person_id is not null then (select left(regexp_replace(m.body, '\s+', ' ', 'g'), 120) from chat_message m where m.channel_id = ch.id and m.removed_at is null and m.kind = 'text' order by m.created_at desc limit 1) end,
    imp.cl, imp.pr, ins.j
  from chs ch cross join v
  left join chat_member mine on mine.channel_id = ch.id and mine.person_id = v.me
  left join chat_group_info g on g.channel_id = ch.id
  left join imp on imp.channel_id = ch.id
  left join ins on ins.channel_id = ch.id
  left join msg on msg.channel_id = ch.id
  left join tf on tf.channel_id = ch.id
  left join sg on sg.channel_id = ch.id
  left join lateral (select r.created_at at from chat_message r join person rp on rp.id = r.author_id
       where r.org_id = current_org() and r.channel_id = ch.id and r.removed_at is null and r.kind = 'text' and rp.side in ('staff', 'agent')
       order by r.created_at desc limit 1) ls on true
  left join lateral (select c.created_at at, coalesce((select g.label || ' (WhatsApp)' from chat_guest g where g.id = c.guest_id), p.display_name) who
       from chat_message c join person p on p.id = c.author_id
       where c.channel_id = ch.id and c.removed_at is null and c.kind = 'text' and p.side not in ('staff', 'agent')
         and (c.import_ref is null or c.created_at > now() - interval '30 days')
         and c.created_at > coalesce(ls.at, '-infinity')
       order by c.created_at asc limit 1) w on true
$$;

-- migrate:down
-- Back to members only: the read policies, the hub record policy and the read functions as before (1043, 1051, 1057
-- and the definitions named above); the setting and its functions go.
alter policy member_read on pulse.chat_channel using (pulse.chat_has(id));
alter policy member_read on pulse.chat_message using (pulse.chat_has(channel_id));
alter policy member_read on pulse.chat_member using (pulse.chat_has(channel_id));
alter policy member_read on pulse.chat_poll using (pulse.chat_has(channel_id));
alter policy member_read on pulse.chat_poll_vote using (pulse.chat_has(channel_id));
alter policy member_read on pulse.chat_annotation using (pulse.chat_has(channel_id));
alter policy member_read on pulse.chat_approval using (pulse.chat_has(channel_id));
alter policy member_read on pulse.chat_guest using (pulse.chat_has(channel_id) and pulse.chat_import_reads());
alter policy visible on pulse.chat_former_member using (pulse.chat_has(channel_id) or pulse.viewer_is('admin'));
drop policy sees on pulse.chat_group_info;
create policy sees on pulse.chat_group_info as restrictive for select using (channel_id in (select pulse.chat_group_visible()));
create or replace function pulse.chat_file_read(p_file uuid) returns table(name text,mime text,bytes bytea) language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 return query select f.name,f.mime,f.bytes from pulse_priv.chat_file f where f.id=p_file and chat_has(f.channel_id) and
 (f.person_id=current_viewer() or exists(select 1 from chat_message m where m.channel_id=f.channel_id and m.removed_at is null and m.attachments @> jsonb_build_array(jsonb_build_object('id',p_file::text))));
 perform audit_write('download','chat_file',p_file::text);
end $$;
create or replace function pulse.chat_group_photo_read(p_channel uuid) returns table(mime text,bytes bytea) language sql stable security definer set search_path=pulse,pg_temp as $$
 select f.mime,f.bytes from pulse_priv.chat_channel_photo f where f.org_id=current_org() and f.channel_id=p_channel and chat_has(p_channel)
$$;
create or replace function pulse.chat_voice_state(p_channel uuid) returns table(message_id uuid,played boolean,played_by int,transcript text,transcript_state text)
 language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if not chat_has(p_channel) then raise exception 'conversation unavailable' using errcode='42501'; end if;
 return query select m.id,
  exists(select 1 from chat_voice_play p where p.message_id=m.id and p.person_id=current_viewer()),
  (select count(*)::int from chat_voice_play p where p.message_id=m.id and p.person_id<>m.author_id),
  t.body, t.state
 from chat_message m left join pulse_priv.chat_voice_transcript t on t.message_id=m.id
 where m.org_id=current_org() and m.channel_id=p_channel and m.removed_at is null and m.created_at>clock_timestamp()-interval '400 days'
  and m.attachments @> '[{}]' and exists(select 1 from jsonb_array_elements(m.attachments) a where a ? 'voice')
 order by m.created_at desc limit 500;
end $$;
create or replace function pulse.wa_file_open(p_sha text) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object('sha256', f.sha256, 'mime', f.mime, 'size', f.size, 'kind', f.kind, 'parts', f.parts, 'meta', f.meta,
   'name', (select m.file_name from pulse_priv.wa_message m where m.org_id = f.org_id and m.file_sha256 = f.sha256 and m.file_name is not null limit 1))
 from pulse_priv.wa_file f where f.org_id = current_org() and f.sha256 = p_sha and f.complete and exists (
   select 1 from pulse_priv.wa_file o join pulse_priv.wa_message m on m.org_id = o.org_id and m.file_sha256 = o.sha256
   join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
   where o.org_id = f.org_id and o.sha256 = f.sha256 and wa_reader(m.chat_id)
   union all
   select 1 from pulse_priv.wa_file o join pulse_priv.wa_message m on m.org_id = o.org_id and m.file_sha256 = o.sha256
   join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
   where o.org_id = f.org_id and (o.meta->>'poster' = f.sha256 or o.meta->>'playable' = f.sha256) and wa_reader(m.chat_id))
$$;
create or replace function pulse.wa_native_channel(p_channel uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object('chatId', c.id, 'messages', c.messages, 'firstAt', c.first_at, 'lastAt', c.last_at,
   'native', n.chat_id is not null, 'nativeMessages', n.messages, 'syncedAt', n.synced_at,
   'guests', (select count(*)::int from chat_guest g where g.org_id = c.org_id and g.channel_id = c.channel_id))
 from pulse_priv.wa_chat c left join pulse_priv.wa_native n on n.org_id = c.org_id and n.chat_id = c.id
 where c.org_id = current_org() and c.channel_id = p_channel and wa_reader(c.id) and chat_import_reads()
$$;
create or replace function pulse.wa_native_people(p_channel uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('participantId', pa.id, 'personId', pa.person_id, 'name', coalesce(p.display_name, pa.label),
     'kind', pa.kind, 'side', p.side, 'messages', pa.messages, 'firstAt', pa.first_at, 'lastAt', pa.last_at,
     'member', exists (select 1 from chat_member cm where cm.channel_id = c.channel_id and cm.person_id = pa.person_id),
     'optIn', (select o.state from client_contact_optin o where o.org_id = c.org_id and o.person_id = pa.person_id and viewer_is('admin', 'leadership')))
   order by pa.messages desc, pa.label), '[]'::jsonb)
 from pulse_priv.wa_chat c join pulse_priv.wa_participant pa on pa.org_id = c.org_id and pa.chat_id = c.id left join person p on p.id = pa.person_id
 where c.org_id = current_org() and c.channel_id = p_channel and wa_reader(c.id) and chat_import_reads() and pa.messages > 0
$$;
create or replace function pulse.wa_native_voice(p_channel uuid) returns table (message_id uuid, transcript text, language text)
language sql stable security definer set search_path = pulse, pg_temp as $$
 select m.id, t.text, t.language from chat_message m join pulse_priv.wa_transcript t on t.org_id = m.org_id and t.sha256 = m.attachments->0->>'wa'
 where m.org_id = current_org() and m.channel_id = p_channel and m.import_ref is not null and m.attachments->0 ? 'voice' and m.removed_at is null
   and chat_import_reads() and exists (select 1 from pulse_priv.wa_chat c where c.org_id = m.org_id and c.channel_id = p_channel and wa_reader(c.id))
$$;
create or replace function pulse.chat_group_hub(p_only uuid default null) returns table (
  id uuid, name text, channel_kind text, created_at timestamptz, member boolean, my_role text, members int, clients int,
  member_ids uuid[], agents jsonb, last_at timestamptz, last_live_at timestamptz, messages_7d int, messages_30d int, messages int,
  unread int, waiting_since timestamptz, waiting_who text, imported int, imported_first timestamptz, imported_last timestamptz,
  unmapped int, open_suggestions int, open_tasks int, files int, info jsonb, archived_by_me boolean, preview text, wa_client_id uuid, wa_project_id uuid, insight jsonb)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  with v as (select current_viewer() me, viewer_is('admin', 'leadership') lead),
  chs as (select ch.* from chat_channel ch, v where ch.org_id = current_org() and ch.kind <> 'direct' and chat_active()
            and (p_only is null or ch.id = p_only)
            and (v.lead or exists (select 1 from chat_member cm where cm.channel_id = ch.id and cm.person_id = v.me))),
  -- Imported history: R47's text imports (chat_import_*) and WA-IMPORT's lossless chats (1015 wa_*); unmapped = senders.
  imp0 as (select m.channel_id, count(*)::int n, min(m.sent_at) f, max(m.sent_at) l, count(distinct m.author_label) filter (where m.author_id is null)::int un, null::uuid cl, null::uuid pr, 0 fi
            from pulse_priv.chat_import_message m join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
           where m.org_id = current_org() and m.channel_id in (select chs.id from chs) group by 1
           union all
           select c.channel_id, c.messages, c.first_at, c.last_at,
             (select count(*)::int from pulse_priv.wa_participant pa where pa.org_id = c.org_id and pa.chat_id = c.id and pa.person_id is null and pa.kind in ('number', 'unknown')),
             c.client_id, c.project_id,
             (select coalesce(sum(f.value::int), 0)::int from jsonb_each_text(coalesce(c.counts->'files', '{}')) f where f.key like '%:attached')
            from pulse_priv.wa_chat c where c.org_id = current_org() and c.channel_id in (select chs.id from chs)),
  imp as (select channel_id, sum(n)::int n, min(f) f, max(l) l, sum(un)::int un, (array_agg(cl) filter (where cl is not null))[1] cl, (array_agg(pr) filter (where pr is not null))[1] pr,
            sum(fi)::int files from imp0 group by 1),
  -- WA-IMPORT's analysis (1016): the service stages seen in the chat, answer times and its sales and service signals.
  ins as (select c.channel_id, jsonb_strip_nulls(jsonb_build_object('stages', i.metrics->'stage_sequence', 'teamMin', i.metrics->'team_median_answer_min',
              'clientMin', i.metrics->'client_median_answer_min', 'daysToLive', i.metrics->'days_start_to_live', 'revisions', i.metrics->'revisions',
              'signals', (select jsonb_object_agg(z.kind, z.n) from (select s.kind, count(*) n from pulse_priv.wa_signal s where s.org_id = c.org_id and s.chat_id = c.id group by 1) z),
              'sentiment', (select round(avg(ms.sentiment)::numeric, 3) from pulse_priv.wa_message_signal ms where ms.org_id = c.org_id and ms.chat_id = c.id))) j
            from pulse_priv.wa_chat c left join pulse_priv.wa_insight i on i.org_id = c.org_id and i.subject = 'chat' and i.subject_id = c.id
           where c.org_id = current_org() and c.channel_id in (select chs.id from chs)),
  -- WA-NATIVE: imported messages are chat messages now; counted once (as imported: their files from the import's counts),
  -- never unread, waiting only when recent. Live counts read only live rows (chat_message_live, 1054).
  msg as (select m.channel_id, max(m.created_at) l, count(*) filter (where m.kind = 'text')::int n,
            count(*) filter (where m.kind = 'text' and m.created_at > now() - interval '7 days')::int n7,
            count(*) filter (where m.kind = 'text' and m.created_at > now() - interval '30 days')::int n30,
            coalesce(sum(jsonb_array_length(m.attachments)), 0)::int files
            from chat_message m where m.org_id = current_org() and m.removed_at is null and m.import_ref is null and m.channel_id in (select chs.id from chs) group by 1),
  tp as (select t.project_id, count(*)::int n from task t where t.org_id = current_org() and t.deleted_at is null and t.status not in ('done', 'accepted', 'cancelled')
           and t.project_id is not null group by 1),
  tf as (select f.channel_id, count(*)::int n from chat_task_follow f join task t on t.id = f.task_id
          where t.org_id = current_org() and t.deleted_at is null and t.status not in ('done', 'accepted', 'cancelled') group by 1),
  sg as (select s.channel_id, count(*)::int n from chat_group_suggestion s where s.org_id = current_org() and s.state = 'open' group by 1)
  select ch.id, ch.name, ch.kind, ch.created_at, mine.person_id is not null, mine.role,
    (select count(*)::int from chat_member cm join person p on p.id = cm.person_id where cm.channel_id = ch.id and p.status = 'active' and p.side <> 'agent'),
    (select count(*)::int from chat_member cm join person p on p.id = cm.person_id where cm.channel_id = ch.id and p.status = 'active' and p.side not in ('staff', 'agent')),
    (select array_agg(cm.person_id order by cm.joined_at) from (select cm.person_id, cm.joined_at from chat_member cm join person p on p.id = cm.person_id
       where cm.channel_id = ch.id and p.status = 'active' and p.side = 'staff' order by cm.role = 'admin' desc, cm.joined_at limit 6) cm),
    (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'role', coalesce(ga.role, 'profile')) order by p.display_name), '[]')
       from chat_member cm join person p on p.id = cm.person_id and p.side = 'agent'
       left join chat_group_agent ga on ga.channel_id = ch.id and ga.agent_id = p.id where cm.channel_id = ch.id),
    greatest(msg.l, imp.l), msg.l, coalesce(msg.n7, 0), coalesce(msg.n30, 0), coalesce(msg.n, 0) + coalesce(imp.n, 0),
    case when mine.person_id is null then 0 else (select count(*)::int from chat_message m where m.channel_id = ch.id and m.author_id <> v.me and m.import_ref is null
       and m.created_at > mine.read_through and m.removed_at is null and m.kind = 'text' and m.parent_id is null) end,
    w.at, w.who, coalesce(imp.n, 0), imp.f, imp.l, coalesce(imp.un, 0), coalesce(sg.n, 0),
    coalesce(case when g.project_id is not null then (select n from tp where tp.project_id = g.project_id) end, 0) + coalesce(tf.n, 0),
    coalesce(msg.files, 0) + coalesce(imp.files, 0),
    case when g.channel_id is null then null else jsonb_build_object('kind', g.kind, 'segments', g.segments, 'services', g.services,
      'clientId', g.client_id, 'client', (select display_name from client where id = g.client_id),
      'projectId', g.project_id, 'project', (select name from project where id = g.project_id),
      'pod', g.pod, 'area', g.area, 'city', g.city, 'period', to_char(g.period, 'YYYY-MM'), 'status', g.status,
      'ownerId', g.owner_id, 'owner', (select display_name from person where id = g.owner_id), 'tags', g.tags,
      'health', g.health, 'sentiment', g.sentiment, 'healthNote', g.health_note, 'parsed', g.parsed, 'manual', g.manual, 'classifiedAt', g.classified_at) end,
    mine.archived_at is not null,
    case when mine.person_id is not null then (select left(regexp_replace(m.body, '\s+', ' ', 'g'), 120) from chat_message m where m.channel_id = ch.id and m.removed_at is null and m.kind = 'text' order by m.created_at desc limit 1) end,
    imp.cl, imp.pr, ins.j
  from chs ch cross join v
  left join chat_member mine on mine.channel_id = ch.id and mine.person_id = v.me
  left join chat_group_info g on g.channel_id = ch.id
  left join imp on imp.channel_id = ch.id
  left join ins on ins.channel_id = ch.id
  left join msg on msg.channel_id = ch.id
  left join tf on tf.channel_id = ch.id
  left join sg on sg.channel_id = ch.id
  left join lateral (select r.created_at at from chat_message r join person rp on rp.id = r.author_id
       where r.org_id = current_org() and r.channel_id = ch.id and r.removed_at is null and r.kind = 'text' and rp.side in ('staff', 'agent')
       order by r.created_at desc limit 1) ls on true
  left join lateral (select c.created_at at, coalesce((select g.label || ' (WhatsApp)' from chat_guest g where g.id = c.guest_id), p.display_name) who
       from chat_message c join person p on p.id = c.author_id
       where c.channel_id = ch.id and c.removed_at is null and c.kind = 'text' and p.side not in ('staff', 'agent')
         and (c.import_ref is null or c.created_at > now() - interval '30 days')
         and c.created_at > coalesce(ls.at, '-infinity')
       order by c.created_at asc limit 1) w on true
$$;
drop function pulse.chat_group_access_counts();
drop function pulse.chat_client_groups();
drop function pulse.chat_group_join(uuid);
drop function pulse.chat_group_access_set(text);
drop function pulse.chat_browsing(uuid);
drop function pulse.chat_reads(uuid);
drop function pulse.chat_browse_ids();
drop function pulse.chat_browse(uuid);
drop function pulse.chat_browse_allowed(uuid, text, text);
drop function pulse.chat_group_readers();
drop table pulse.chat_group_access;

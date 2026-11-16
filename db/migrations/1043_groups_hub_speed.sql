-- migrate:up
-- GROUPS-HUB: speed. The "sees" policies of 1018 called chat_group_sees() once per row (row security stays forced inside
-- security-definer functions), so the hub of a company with ~1,000 open suggestions took 2.7 s. The groups a viewer
-- sees are now worked out once per query (a hashed sub-select), and the imported-sender list checks membership once.
create function pulse.chat_group_visible() returns setof uuid
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select ch.id from chat_channel ch where ch.org_id = current_org() and ch.kind <> 'direct' and chat_active()
     and (viewer_is('admin', 'leadership') or exists (select 1 from chat_member cm where cm.channel_id = ch.id and cm.person_id = current_viewer()))
$$;
drop policy sees on pulse.chat_group_info;
drop policy sees on pulse.chat_group_agent;
drop policy sees on pulse.chat_group_suggestion;
drop policy sees on pulse.chat_group_ai_job;
create policy sees on pulse.chat_group_info as restrictive for select using (channel_id in (select pulse.chat_group_visible()));
create policy sees on pulse.chat_group_agent as restrictive for select using (channel_id in (select pulse.chat_group_visible()));
create policy sees on pulse.chat_group_suggestion as restrictive for select using (channel_id in (select pulse.chat_group_visible()));
create policy sees on pulse.chat_group_ai_job as restrictive for select using (channel_id in (select pulse.chat_group_visible()));

create or replace function pulse.chat_group_unmapped_senders() returns table (channel_id uuid, label text, messages int, first_at timestamptz, last_at timestamptz)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  with mine as (select cm.channel_id from chat_member cm where cm.org_id = current_org() and cm.person_id = current_viewer() and chat_active()
                union select ch.id from chat_channel ch where ch.org_id = current_org() and ch.kind <> 'direct' and chat_active() and viewer_is('admin'))
  select m.channel_id, m.author_label, count(*)::int, min(m.sent_at), max(m.sent_at)
    from pulse_priv.chat_import_message m
    join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
   where m.org_id = current_org() and m.author_id is null and m.channel_id in (select channel_id from mine)
   group by 1, 2
  union all
  select c.channel_id, pa.label, pa.messages, pa.first_at, pa.last_at
    from pulse_priv.wa_participant pa join pulse_priv.wa_chat c on c.org_id = pa.org_id and c.id = pa.chat_id
   where pa.org_id = current_org() and pa.person_id is null and pa.kind in ('number', 'unknown') and c.channel_id in (select channel_id from mine)
$$;

-- One group's row (the group panel) without reading every group: the same function with an optional group.
drop function pulse.chat_group_hub();
create function pulse.chat_group_hub(p_only uuid default null) returns table (
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
  imp0 as (select m.channel_id, count(*)::int n, min(m.sent_at) f, max(m.sent_at) l, count(distinct m.author_label) filter (where m.author_id is null)::int un, null::uuid cl, null::uuid pr
            from pulse_priv.chat_import_message m join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
           where m.org_id = current_org() and m.channel_id in (select chs.id from chs) group by 1
           union all
           select c.channel_id, c.messages, c.first_at, c.last_at,
             (select count(*)::int from pulse_priv.wa_participant pa where pa.org_id = c.org_id and pa.chat_id = c.id and pa.person_id is null and pa.kind in ('number', 'unknown')),
             c.client_id, c.project_id
            from pulse_priv.wa_chat c where c.org_id = current_org() and c.channel_id in (select chs.id from chs)),
  imp as (select channel_id, sum(n)::int n, min(f) f, max(l) l, sum(un)::int un, (array_agg(cl) filter (where cl is not null))[1] cl, (array_agg(pr) filter (where pr is not null))[1] pr from imp0 group by 1),
  -- WA-IMPORT's analysis (1016): the service stages seen in the chat, answer times and its sales and service signals.
  ins as (select c.channel_id, jsonb_strip_nulls(jsonb_build_object('stages', i.metrics->'stage_sequence', 'teamMin', i.metrics->'team_median_answer_min',
              'clientMin', i.metrics->'client_median_answer_min', 'daysToLive', i.metrics->'days_start_to_live', 'revisions', i.metrics->'revisions',
              'signals', (select jsonb_object_agg(z.kind, z.n) from (select s.kind, count(*) n from pulse_priv.wa_signal s where s.org_id = c.org_id and s.chat_id = c.id group by 1) z),
              'sentiment', (select round(avg(ms.sentiment)::numeric, 3) from pulse_priv.wa_message_signal ms where ms.org_id = c.org_id and ms.chat_id = c.id))) j
            from pulse_priv.wa_chat c left join pulse_priv.wa_insight i on i.org_id = c.org_id and i.subject = 'chat' and i.subject_id = c.id
           where c.org_id = current_org() and c.channel_id in (select chs.id from chs)),
  msg as (select m.channel_id, max(m.created_at) l, count(*) filter (where m.kind = 'text')::int n,
            count(*) filter (where m.kind = 'text' and m.created_at > now() - interval '7 days')::int n7,
            count(*) filter (where m.kind = 'text' and m.created_at > now() - interval '30 days')::int n30,
            coalesce(sum(jsonb_array_length(m.attachments)), 0)::int files
            from chat_message m where m.org_id = current_org() and m.removed_at is null and m.channel_id in (select chs.id from chs) group by 1),
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
    case when mine.person_id is null then 0 else (select count(*)::int from chat_message m where m.channel_id = ch.id and m.author_id <> v.me
       and m.created_at > mine.read_through and m.removed_at is null and m.kind = 'text' and m.parent_id is null) end,
    w.at, w.who, coalesce(imp.n, 0), imp.f, imp.l, coalesce(imp.un, 0), coalesce(sg.n, 0),
    coalesce(case when g.project_id is not null then (select n from tp where tp.project_id = g.project_id) end, 0) + coalesce(tf.n, 0),
    coalesce(msg.files, 0),
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
  left join lateral (select max(r.created_at) at from chat_message r join person rp on rp.id = r.author_id
       where r.channel_id = ch.id and r.removed_at is null and r.kind = 'text' and rp.side in ('staff', 'agent')) ls on true
  left join lateral (select c.created_at at, p.display_name who from chat_message c join person p on p.id = c.author_id
       where c.channel_id = ch.id and c.removed_at is null and c.kind = 'text' and p.side not in ('staff', 'agent')
         and c.created_at > coalesce(ls.at, '-infinity')
       order by c.created_at asc limit 1) w on true
$$;

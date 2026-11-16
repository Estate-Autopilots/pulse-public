-- migrate:up
-- SPEED-2 (owner, 15 Nov 2026: "a thousand times faster"): leadership's Home card "groups waiting on us"
-- (GET /api/v0/insights/home) read the whole group hub (imports, insights, files, members, tasks, previews of every
-- group) to keep only who is waiting. On production (read-only, Estate Autopilots, 465 groups) the hub took 290-420 ms
-- warm and up to 3.2 s cold; this reads the same groups with the same rules for only the waiting part: 80-190 ms warm.
-- The groups and the wait are the hub's own (1043 / 1057 / 1098): the viewer's groups (leadership sees all; a client
-- group the company opens to them), the oldest client message after the team's last answer (an imported one only when
-- recent), not archived by the viewer.
create function pulse.chat_group_waits() returns table (id uuid, name text, waiting_since timestamptz, waiting_who text)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  with v as (select current_viewer() me, viewer_is('admin', 'leadership') lead),
  chs as (select ch.id, ch.name from chat_channel ch, v where ch.org_id = current_org() and ch.kind <> 'direct' and chat_active()
            and (v.lead or exists (select 1 from chat_member cm where cm.channel_id = ch.id and cm.person_id = v.me)
                 or ch.id in (select pulse.chat_browse_ids())))
  select ch.id, ch.name, w.at, w.who
  from chs ch cross join v
  left join chat_member mine on mine.channel_id = ch.id and mine.person_id = v.me
  left join lateral (select r.created_at at from chat_message r join person rp on rp.id = r.author_id
       where r.org_id = current_org() and r.channel_id = ch.id and r.removed_at is null and r.kind = 'text' and rp.side in ('staff', 'agent')
       order by r.created_at desc limit 1) ls on true
  join lateral (select c.created_at at, coalesce((select g.label || ' (WhatsApp)' from chat_guest g where g.id = c.guest_id), p.display_name) who
       from chat_message c join person p on p.id = c.author_id
       where c.channel_id = ch.id and c.removed_at is null and c.kind = 'text' and p.side not in ('staff', 'agent')
         and (c.import_ref is null or c.created_at > now() - interval '30 days')
         and c.created_at > coalesce(ls.at, '-infinity')
       order by c.created_at asc limit 1) w on true
  where mine.archived_at is null
  order by w.at
$$;
revoke all on function pulse.chat_group_waits() from public;
grant execute on function pulse.chat_group_waits() to pulse_api;
-- migrate:down
-- Forward-only.

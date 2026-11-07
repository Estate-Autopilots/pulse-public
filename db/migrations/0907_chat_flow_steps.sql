-- migrate:up
-- CHAT-WORK J6 (owner, 22 Oct 2026: "a step opens for me → a message in my group says so → … done → the next person is
-- told in their chat"). A live run's step that opens for someone now also says so in the pod group of the run's
-- project, naming them (an @mention in the line), next to finished / sent for review / blocked; the line is written as
-- the person whose action opened it, only when they are in that group. Additive: replaces 0905's line function.
create or replace function pulse.chat_flow_step_line() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r flow_run; cid uuid; me uuid := current_viewer(); line text; who text;
begin
  if me is null then return null; end if;
  line := case
    when new.state is distinct from old.state and new.state = 'done' then 'finished'
    when new.state is distinct from old.state and new.state = 'in_review' then 'sent for review'
    when new.blocked_at is not null and old.blocked_at is null then 'is blocked on'
    when new.state is distinct from old.state and new.state = 'open' and old.state = 'waiting' and new.person_id is not null then 'opened' end;
  if line is null then return null; end if;
  select * into r from flow_run where id = new.run_id;
  if r.mode <> 'live' or r.project_id is null then return null; end if;
  select ch.id into cid from work_project wp join unit u on u.kind = 'pod' and u.valid_to is null and u.name = wp.pod and u.org_id = wp.org_id
    join chat_channel ch on ch.org_id = wp.org_id and ch.key = 'pod:' || u.id
   where wp.org_id = new.org_id and wp.project_id = r.project_id limit 1;
  if cid is null or not exists(select 1 from chat_member where channel_id = cid and person_id = me) then return null; end if;
  if line = 'opened' then
    select coalesce('@' || pp.username, p.display_name) into who from person p left join people_profile pp on pp.person_id = p.id where p.id = new.person_id;
    perform chat_event_line(cid, me, 'moved ' || left(r.name, 120) || ' on: “' || left(new.title, 120) || '” is ready for ' || coalesce(who, 'its person'),
      case when new.task_id is not null then jsonb_build_array(jsonb_build_object('task', new.task_id::text, 'name', left(new.title, 300), 'url', '/tasks/' || new.task_id)) else '[]'::jsonb end);
    return null;
  end if;
  perform chat_event_line(cid, me, line || ' “' || left(new.title, 120) || '” in ' || left(r.name, 120),
    case when new.task_id is not null then jsonb_build_array(jsonb_build_object('task', new.task_id::text, 'name', left(new.title, 300), 'url', '/tasks/' || new.task_id)) else '[]'::jsonb end);
  return null;
end $$;
revoke all on function pulse.chat_flow_step_line() from public;

-- migrate:down
-- Forward-only.

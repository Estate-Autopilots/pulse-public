-- migrate:up
-- CHAT-WORK J6: a Flow run's steps say what happens in the groups that follow the run, not only in its project's pod
-- group: "/steps" → "Post these runs' updates here". A step that opens names its person (with a link to the step), a
-- finished, reviewed or blocked step says so; written as the person whose action did it, in groups they are in.
create table pulse.chat_flow_follow (
  org_id uuid not null references pulse.org(id),
  run_id uuid not null references pulse.flow_run(id),
  channel_id uuid not null references pulse.chat_channel(id),
  created_by uuid not null references pulse.person(id),
  created_at timestamptz not null default now(),
  primary key (run_id, channel_id)
);
alter table pulse.chat_flow_follow enable row level security;
alter table pulse.chat_flow_follow force row level security;
create policy tenant_isolation on pulse.chat_flow_follow using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy member_read on pulse.chat_flow_follow as restrictive for select to pulse_api using (pulse.chat_has(channel_id));
grant select on pulse.chat_flow_follow to pulse_api;
create trigger audit_mutation after insert or update or delete on pulse.chat_flow_follow for each row execute function pulse.audit_mutation();

-- A member of the chat who takes part in the run (started it, holds one of its roles or a step) or leads, follows it there.
create function pulse.chat_flow_follow_set(p_run uuid, p_channel uuid, p_on boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer();
begin
  if me is null or not exists(select 1 from chat_member where org_id = current_org() and channel_id = p_channel and person_id = me) then
    raise exception 'conversation unavailable' using errcode='42501'; end if;
  if not exists(select 1 from flow_run r where r.org_id = current_org() and r.id = p_run and r.mode = 'live'
                  and (r.started_by = me or agent_leader(me) or exists(select 1 from jsonb_each_text(r.people) x where x.value = me::text)
                       or exists(select 1 from flow_run_step s where s.run_id = r.id and s.person_id = me))) then
    raise exception 'Only someone in the run posts its updates into a chat' using errcode='42501'; end if;
  if p_on then insert into chat_flow_follow(org_id, run_id, channel_id, created_by) values (current_org(), p_run, p_channel, me) on conflict do nothing;
  else delete from chat_flow_follow where org_id = current_org() and run_id = p_run and channel_id = p_channel; end if;
end $$;

create or replace function pulse.chat_flow_step_line() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r flow_run; me uuid := current_viewer(); line text; who text; cid uuid; att jsonb;
begin
  if me is null then return null; end if;
  line := case
    when new.state is distinct from old.state and new.state = 'done' then 'finished'
    when new.state is distinct from old.state and new.state = 'in_review' then 'sent for review'
    when new.blocked_at is not null and old.blocked_at is null then 'is blocked on'
    when new.state is distinct from old.state and new.state = 'open' and old.state = 'waiting' and new.person_id is not null then 'opened' end;
  if line is null then return null; end if;
  select * into r from flow_run where id = new.run_id;
  if r.mode <> 'live' then return null; end if;
  if line = 'opened' then
    select coalesce('@' || pp.username, p.display_name) into who from person p left join people_profile pp on pp.person_id = p.id where p.id = new.person_id;
    line := 'moved ' || left(r.name, 120) || ' on: “' || left(new.title, 120) || '” is ready for ' || coalesce(who, 'its person');
  else line := line || ' “' || left(new.title, 120) || '” in ' || left(r.name, 120); end if;
  att := case when new.task_id is not null then jsonb_build_array(jsonb_build_object('task', new.task_id::text, 'name', left(new.title, 300), 'url', '/tasks/' || new.task_id))
              else jsonb_build_array(jsonb_build_object('name', 'Open the step', 'url', '/runs/' || new.run_id || '?step=' || new.id, 'step', new.id::text)) end;
  for cid in
    select ch.id from work_project wp join unit u on u.kind = 'pod' and u.valid_to is null and u.name = wp.pod and u.org_id = wp.org_id
      join chat_channel ch on ch.org_id = wp.org_id and ch.key = 'pod:' || u.id
     where r.project_id is not null and wp.org_id = new.org_id and wp.project_id = r.project_id
    union select f.channel_id from chat_flow_follow f where f.org_id = new.org_id and f.run_id = new.run_id
  loop
    if exists(select 1 from chat_member where channel_id = cid and person_id = me) then perform chat_event_line(cid, me, line, att); end if;
  end loop;
  return null;
end $$;
revoke all on function pulse.chat_flow_follow_set(uuid,uuid,boolean), pulse.chat_flow_step_line() from public;
grant execute on function pulse.chat_flow_follow_set(uuid,uuid,boolean) to pulse_api;

-- migrate:down
-- Forward-only.

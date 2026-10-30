-- migrate:up
-- CHAT-V5 (owner, 24 Oct 2026: "chat mode needs a far greater upgrade"): a Threads inbox. Every thread I am in (I started
-- it, replied in it or was mentioned in it) in one list, the ones with replies I have not read first. How far I have
-- read each thread is mine alone (nobody else sees it); opening the thread marks it read.
-- Additive: one new table with row security and one new function. Uses only objects defined in this repository.

create table pulse.chat_thread_read (
  org_id uuid not null references pulse.org(id),
  person_id uuid not null references pulse.person(id),
  root_id uuid not null,
  read_through timestamptz not null default clock_timestamp(),
  primary key (org_id, person_id, root_id),
  foreign key (org_id, root_id) references pulse.chat_message(org_id, id) on delete cascade
);
alter table pulse.chat_thread_read enable row level security;
alter table pulse.chat_thread_read force row level security;
create policy tenant_isolation on pulse.chat_thread_read using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy own_rows on pulse.chat_thread_read as restrictive for all to pulse_api using (person_id = pulse.current_viewer()) with check (person_id = pulse.current_viewer());
grant select on pulse.chat_thread_read to pulse_api;

-- Mine: a thread read up to now (its first message must be one I can read in a conversation I am in).
create function pulse.chat_thread_seen(p_root uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform chat_member_message(p_root);
  if exists(select 1 from chat_message where org_id = current_org() and id = p_root and parent_id is not null) then
    raise exception 'thread unavailable' using errcode = '22023'; end if;
  insert into chat_thread_read(org_id, person_id, root_id) values (current_org(), current_viewer(), p_root)
  on conflict (org_id, person_id, root_id) do update set read_through = greatest(chat_thread_read.read_through, excluded.read_through);
end $$;
revoke all on function pulse.chat_thread_seen(uuid) from public;
grant execute on function pulse.chat_thread_seen(uuid) to pulse_api;

-- migrate:down
drop function if exists pulse.chat_thread_seen(uuid);
drop table if exists pulse.chat_thread_read;

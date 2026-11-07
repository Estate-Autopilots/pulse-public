-- migrate:up
-- CHAT-V5 (owner, 24 Oct 2026: "chat mode needs a far greater upgrade"): polls in a conversation. A question with 2-10
-- choices, one choice or several; the conversation's members vote (and change their vote) while it is open, and see
-- the results live (who chose what: polls here are not anonymous). The person who asked, or a group admin, closes it;
-- closing is a line in the chat. The poll is a message (its question is the message's words), so it notifies, quotes,
-- pins and threads like any other.
-- Additive: two new tables with row security, new functions. Uses only objects defined in this repository.

create table pulse.chat_poll (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null,
  channel_id uuid not null,
  question text not null check (length(question) between 1 and 300),
  options jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 10),
  multi boolean not null default false,
  created_by uuid not null references pulse.person(id),
  created_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz,
  closed_by uuid references pulse.person(id),
  unique (org_id, message_id),
  unique (org_id, id),
  foreign key (org_id, message_id) references pulse.chat_message(org_id, id) on delete cascade,
  foreign key (org_id, channel_id) references pulse.chat_channel(org_id, id) on delete cascade
);
create table pulse.chat_poll_vote (
  org_id uuid not null references pulse.org(id),
  poll_id uuid not null,
  channel_id uuid not null,
  choice smallint not null check (choice between 0 and 9),
  person_id uuid not null references pulse.person(id),
  voted_at timestamptz not null default clock_timestamp(),
  primary key (org_id, poll_id, choice, person_id),
  foreign key (org_id, poll_id) references pulse.chat_poll(org_id, id) on delete cascade
);
alter table pulse.chat_poll enable row level security;
alter table pulse.chat_poll force row level security;
alter table pulse.chat_poll_vote enable row level security;
alter table pulse.chat_poll_vote force row level security;
create policy tenant_isolation on pulse.chat_poll using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy member_read on pulse.chat_poll as restrictive for select to pulse_api using (pulse.chat_has(channel_id));
create policy tenant_isolation on pulse.chat_poll_vote using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy member_read on pulse.chat_poll_vote as restrictive for select to pulse_api using (pulse.chat_has(channel_id));
grant select on pulse.chat_poll, pulse.chat_poll_vote to pulse_api;

-- Ask: the question goes as my message (chat_send: I must be in the conversation), the choices with it.
create function pulse.chat_poll_create(p_channel uuid, p_question text, p_options text[], p_multi boolean, p_client uuid) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare mid uuid; opts text[];
begin
  if not exists(select 1 from chat_member where org_id = current_org() and channel_id = p_channel and person_id = current_viewer()) then
    raise exception 'conversation unavailable' using errcode = '42501'; end if;
  if p_question is null or length(trim(p_question)) not between 1 and 300 then raise exception 'ask a question of up to 300 characters' using errcode = '22023'; end if;
  select coalesce(array_agg(trim(o) order by n), '{}') into opts from unnest(p_options) with ordinality as u(o, n) where trim(o) <> '';
  if cardinality(opts) not between 2 and 10 then raise exception 'give 2 to 10 choices' using errcode = '22023'; end if;
  if exists(select 1 from unnest(opts) o where length(o) > 120) then raise exception 'keep each choice under 120 characters' using errcode = '22023'; end if;
  if (select count(distinct lower(o)) from unnest(opts) o) <> cardinality(opts) then raise exception 'each choice once' using errcode = '22023'; end if;
  select id into mid from chat_message where org_id = current_org() and author_id = current_viewer() and client_id = p_client;
  if mid is not null then
    if exists(select 1 from chat_poll where org_id = current_org() and message_id = mid) then return mid; end if;
    raise exception 'message key already used' using errcode = '22023';
  end if;
  mid := chat_send(p_channel, trim(p_question), null, '[]'::jsonb, p_client, null);
  insert into chat_poll(org_id, message_id, channel_id, question, options, multi, created_by)
  values (current_org(), mid, p_channel, trim(p_question), to_jsonb(opts), coalesce(p_multi, false), current_viewer());
  return mid;
end $$;

-- Vote: my choices replace my earlier ones (none takes my vote back). Members only, while the poll is open.
create function pulse.chat_poll_vote(p_message uuid, p_choices integer[]) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare p chat_poll%rowtype; picks integer[];
begin
  perform chat_member_message(p_message);
  select * into p from chat_poll where org_id = current_org() and message_id = p_message for update;
  if not found then raise exception 'poll unavailable' using errcode = '22023'; end if;
  if p.closed_at is not null then raise exception 'this poll is closed' using errcode = '22023'; end if;
  select coalesce(array_agg(distinct c), '{}') into picks from unnest(coalesce(p_choices, '{}')) c;
  if exists(select 1 from unnest(picks) c where c < 0 or c >= jsonb_array_length(p.options)) then raise exception 'choose one of the poll''s choices' using errcode = '22023'; end if;
  if not p.multi and cardinality(picks) > 1 then raise exception 'this poll takes one choice' using errcode = '22023'; end if;
  delete from chat_poll_vote where org_id = current_org() and poll_id = p.id and person_id = current_viewer();
  insert into chat_poll_vote(org_id, poll_id, channel_id, choice, person_id) select current_org(), p.id, p.channel_id, c, current_viewer() from unnest(picks) c;
  insert into chat_event(org_id, channel_id) values (current_org(), p.channel_id);
end $$;

-- Close (the person who asked, or an admin of the group): no more votes; a line in the chat says so.
create function pulse.chat_poll_close(p_message uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare p chat_poll%rowtype;
begin
  perform chat_member_message(p_message);
  select * into p from chat_poll where org_id = current_org() and message_id = p_message for update;
  if not found then raise exception 'poll unavailable' using errcode = '22023'; end if;
  if p.closed_at is not null then return; end if;
  if p.created_by <> current_viewer() and not exists(select 1 from chat_member where org_id = current_org() and channel_id = p.channel_id and person_id = current_viewer() and role = 'admin') then
    raise exception 'only the person who asked or a group admin closes a poll' using errcode = '42501'; end if;
  update chat_poll set closed_at = clock_timestamp(), closed_by = current_viewer() where id = p.id;
  perform chat_event_line(p.channel_id, current_viewer(), 'closed the poll “' || left(p.question, 80) || '”', jsonb_build_array(jsonb_build_object('name', 'poll', 'poll', p_message)));
end $$;

revoke all on function pulse.chat_poll_create(uuid, text, text[], boolean, uuid), pulse.chat_poll_vote(uuid, integer[]), pulse.chat_poll_close(uuid) from public;
grant execute on function pulse.chat_poll_create(uuid, text, text[], boolean, uuid), pulse.chat_poll_vote(uuid, integer[]), pulse.chat_poll_close(uuid) to pulse_api;

-- migrate:down
drop function if exists pulse.chat_poll_close(uuid), pulse.chat_poll_vote(uuid, integer[]), pulse.chat_poll_create(uuid, text, text[], boolean, uuid);
drop table if exists pulse.chat_poll_vote;
drop table if exists pulse.chat_poll;

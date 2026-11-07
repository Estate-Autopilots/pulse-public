-- migrate:up
-- CHAT-V3 (owner, 24 Oct 2026: "chat needs a far greater upgrade"): what the team uses every day, as the best chat apps do it.
--   live        every chat_event wakes the open Pulses at once (NOTIFY pulse_chat), instead of the next 2-second poll.
--   mute        chat_member.muted_until: no bell or push for that chat until then (mentions and replies to you still come).
--   archive     chat_member.archived_at: the chat leaves the main list (an Archived row keeps it one tap away).
--   pin         chat_message.pinned_at/pinned_by: up to 3 messages pinned on top of a conversation, for all its members.
--   forward     chat_message.forwarded: a message sent on to other chats (its files are copied into each of them).
--   star        chat_star: messages a person saves for later (only they see their own).
--   annotate    chat_annotation: a comment pinned to a point of a picture (revision rounds), kept as a thread reply.
--   approval    chat_approval: "Approve or ask for changes" on a message (a creative, a quote); the answer is a line in the chat.
-- Additive: new columns (nullable or with a default), new tables, new functions, one new trigger; chat_notify_members is
-- replaced only to skip muted members. Uses only objects defined in this repository's migrations.

alter table pulse.chat_member add column if not exists muted_until timestamptz, add column if not exists archived_at timestamptz;
alter table pulse.chat_message add column if not exists pinned_at timestamptz, add column if not exists pinned_by uuid references pulse.person(id),
  add column if not exists forwarded boolean not null default false;
create index if not exists chat_message_pinned on pulse.chat_message (org_id, channel_id, pinned_at) where pinned_at is not null;

create table pulse.chat_star (
  org_id uuid not null references pulse.org(id),
  person_id uuid not null references pulse.person(id),
  message_id uuid not null,
  at timestamptz not null default clock_timestamp(),
  primary key (person_id, message_id),
  foreign key (org_id, message_id) references pulse.chat_message(org_id, id) on delete cascade
);
create index chat_star_person on pulse.chat_star (org_id, person_id, at desc);
alter table pulse.chat_star enable row level security;
alter table pulse.chat_star force row level security;
create policy tenant_isolation on pulse.chat_star using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy own_read on pulse.chat_star as restrictive for select to pulse_api using (person_id = pulse.current_viewer());
grant select on pulse.chat_star to pulse_api;

create table pulse.chat_annotation (
  org_id uuid not null references pulse.org(id),
  message_id uuid primary key,
  channel_id uuid not null,
  file_id uuid not null,
  x real not null check (x >= 0 and x <= 1),
  y real not null check (y >= 0 and y <= 1),
  resolved_at timestamptz,
  resolved_by uuid references pulse.person(id),
  foreign key (org_id, message_id) references pulse.chat_message(org_id, id) on delete cascade,
  foreign key (org_id, channel_id) references pulse.chat_channel(org_id, id) on delete cascade
);
create index chat_annotation_file on pulse.chat_annotation (org_id, file_id);
alter table pulse.chat_annotation enable row level security;
alter table pulse.chat_annotation force row level security;
create policy tenant_isolation on pulse.chat_annotation using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy member_read on pulse.chat_annotation as restrictive for select to pulse_api using (pulse.chat_has(channel_id));
grant select on pulse.chat_annotation to pulse_api;

create table pulse.chat_approval (
  org_id uuid not null references pulse.org(id),
  message_id uuid primary key,
  channel_id uuid not null,
  asked_by uuid not null references pulse.person(id),
  asked_at timestamptz not null default clock_timestamp(),
  state text not null default 'waiting' check (state in ('waiting', 'approved', 'changes')),
  decided_by uuid references pulse.person(id),
  decided_at timestamptz,
  note text check (length(note) <= 2000),
  rounds integer not null default 0,
  foreign key (org_id, message_id) references pulse.chat_message(org_id, id) on delete cascade,
  foreign key (org_id, channel_id) references pulse.chat_channel(org_id, id) on delete cascade
);
alter table pulse.chat_approval enable row level security;
alter table pulse.chat_approval force row level security;
create policy tenant_isolation on pulse.chat_approval using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy member_read on pulse.chat_approval as restrictive for select to pulse_api using (pulse.chat_has(channel_id));
grant select on pulse.chat_approval to pulse_api;

-- Live: one NOTIFY per changed conversation and transaction (Postgres folds identical payloads); the API's single LISTEN
-- connection tells the open streams of that conversation's members.
create function pulse.chat_event_wake() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin perform pg_notify('pulse_chat', new.org_id::text || ':' || new.channel_id::text); return null; end $$;
create trigger chat_event_wake after insert on pulse.chat_event for each row execute function pulse.chat_event_wake();

-- Mine: a member's own chat settings.
create function pulse.chat_mute(p_channel uuid, p_until timestamptz) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if p_until is not null and p_until <> 'infinity' and p_until < clock_timestamp() then raise exception 'choose a time in the future' using errcode = '22023'; end if;
  update chat_member set muted_until = p_until where org_id = current_org() and channel_id = p_channel and person_id = current_viewer();
  if not found then raise exception 'conversation unavailable' using errcode = '42501'; end if;
end $$;
create function pulse.chat_archive(p_channel uuid, p_on boolean) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  update chat_member set archived_at = case when p_on then clock_timestamp() end, pinned_at = case when p_on then null else pinned_at end
  where org_id = current_org() and channel_id = p_channel and person_id = current_viewer();
  if not found then raise exception 'conversation unavailable' using errcode = '42501'; end if;
end $$;

-- A message the viewer may act on as a member (not as a moderator): its channel, or an error.
create function pulse.chat_member_message(p_message uuid) returns uuid language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare cid uuid;
begin
  select m.channel_id into cid from chat_message m where m.org_id = current_org() and m.id = p_message and m.removed_at is null and m.kind = 'text';
  if cid is null or not chat_active() or not exists(select 1 from chat_member cm where cm.channel_id = cid and cm.person_id = current_viewer()) then
    raise exception 'message unavailable' using errcode = '42501'; end if;
  return cid;
end $$;

create function pulse.chat_pin_message(p_message uuid, p_on boolean) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare cid uuid := chat_member_message(p_message); was timestamptz;
begin
  select pinned_at into was from chat_message where id = p_message;
  if p_on = (was is not null) then return; end if;
  if p_on and (select count(*) from chat_message where org_id = current_org() and channel_id = cid and pinned_at is not null) >= 3 then
    raise exception 'up to 3 messages can be pinned; unpin one first' using errcode = '22023'; end if;
  update chat_message set pinned_at = case when p_on then clock_timestamp() end, pinned_by = case when p_on then current_viewer() end where id = p_message;
  if p_on then perform chat_event_line(cid, current_viewer(), 'pinned a message', jsonb_build_array(jsonb_build_object('name', 'Pinned message', 'pinned', p_message))); end if;
end $$;

create function pulse.chat_star_set(p_message uuid, p_on boolean) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare cid uuid;
begin
  select channel_id into cid from chat_message where org_id = current_org() and id = p_message and kind = 'text';
  if cid is null or not chat_has(cid) then raise exception 'message unavailable' using errcode = '42501'; end if;
  if p_on then insert into chat_star(org_id, person_id, message_id) values (current_org(), current_viewer(), p_message) on conflict do nothing;
  else delete from chat_star where person_id = current_viewer() and message_id = p_message; end if;
end $$;

-- Forward: the same words and files, sent by the viewer to up to 5 chats they are in; files are copied into each chat.
create function pulse.chat_forward(p_message uuid, p_channels uuid[]) returns uuid[] language plpgsql security definer set search_path = pulse, pg_temp as $$
declare src chat_message%rowtype; target uuid; a jsonb; atts jsonb; fid uuid; mid uuid; sent uuid[] := '{}';
begin
  select * into src from chat_message where org_id = current_org() and id = p_message and removed_at is null and kind = 'text';
  if not found or not chat_has(src.channel_id) then raise exception 'message unavailable' using errcode = '42501'; end if;
  if coalesce(array_length(p_channels, 1), 0) = 0 or array_length(p_channels, 1) > 5 then raise exception 'forward to 1 to 5 chats' using errcode = '22023'; end if;
  foreach target in array p_channels loop
    if not exists(select 1 from chat_member where org_id = current_org() and channel_id = target and person_id = current_viewer()) then
      raise exception 'conversation unavailable' using errcode = '42501'; end if;
    atts := '[]';
    for a in select value from jsonb_array_elements(src.attachments) loop
      if a ? 'id' then
        fid := gen_random_uuid();
        insert into pulse_priv.chat_file(org_id, id, channel_id, person_id, name, mime, bytes)
        select f.org_id, fid, target, current_viewer(), f.name, f.mime, f.bytes from pulse_priv.chat_file f where f.org_id = current_org() and f.id = (a->>'id')::uuid;
        if found then atts := atts || jsonb_build_array((a - 'prev' - 'version') || jsonb_build_object('id', fid::text)); end if;
      elsif a ? 'task' or a ? 'url' then atts := atts || jsonb_build_array(a);
      end if;
    end loop;
    if trim(src.body) = '' and jsonb_array_length(atts) = 0 then raise exception 'there is nothing in this message to forward' using errcode = '22023'; end if;
    mid := chat_send(target, src.body, null, atts, gen_random_uuid(), null);
    update chat_message set forwarded = true where id = mid;
    sent := sent || mid;
  end loop;
  return sent;
end $$;

-- A comment on a point of a picture: a thread reply to the picture's message, with where it points.
create function pulse.chat_annotate(p_message uuid, p_file uuid, p_x real, p_y real, p_body text, p_client uuid) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare cid uuid := chat_member_message(p_message); mid uuid;
begin
  if p_x is null or p_y is null or p_x < 0 or p_x > 1 or p_y < 0 or p_y > 1 then raise exception 'choose a point on the picture' using errcode = '22023'; end if;
  if not exists(select 1 from chat_message m where m.id = p_message and m.parent_id is null and m.attachments @> jsonb_build_array(jsonb_build_object('id', p_file::text))) then
    raise exception 'picture unavailable' using errcode = '22023'; end if;
  mid := chat_send(cid, p_body, p_message, '[]'::jsonb, p_client, null);
  insert into chat_annotation(org_id, message_id, channel_id, file_id, x, y) values (current_org(), mid, cid, p_file, p_x, p_y) on conflict (message_id) do nothing;
  return mid;
end $$;
create function pulse.chat_annotation_resolve(p_message uuid, p_on boolean) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare cid uuid;
begin
  select channel_id into cid from chat_annotation where org_id = current_org() and message_id = p_message;
  if cid is null or not exists(select 1 from chat_member where channel_id = cid and person_id = current_viewer()) then raise exception 'comment unavailable' using errcode = '42501'; end if;
  update chat_annotation set resolved_at = case when p_on then clock_timestamp() end, resolved_by = case when p_on then current_viewer() end where message_id = p_message;
  insert into chat_event(org_id, channel_id) values (current_org(), cid);
end $$;

-- Approvals: asked on a message; any other member answers (a client approving a creative, a leader a quote).
create function pulse.chat_approval_ask(p_message uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare cid uuid := chat_member_message(p_message);
begin
  insert into chat_approval(org_id, message_id, channel_id, asked_by) values (current_org(), p_message, cid, current_viewer())
  on conflict (message_id) do update set state = 'waiting', asked_by = excluded.asked_by, asked_at = clock_timestamp(), decided_by = null, decided_at = null, note = null;
  perform chat_event_line(cid, current_viewer(), 'asked for approval', jsonb_build_array(jsonb_build_object('name', 'Approval', 'approval', p_message, 'state', 'waiting')));
end $$;
create function pulse.chat_approval_decide(p_message uuid, p_state text, p_note text) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare cid uuid := chat_member_message(p_message); r chat_approval%rowtype;
begin
  if p_state not in ('approved', 'changes') then raise exception 'approve or ask for changes' using errcode = '22023'; end if;
  select * into r from chat_approval where message_id = p_message;
  if not found then raise exception 'nobody asked to approve this' using errcode = '22023'; end if;
  if r.asked_by = current_viewer() then raise exception 'someone else approves what you asked about' using errcode = '42501'; end if;
  if p_state = 'changes' and coalesce(trim(p_note), '') = '' then raise exception 'say what to change' using errcode = '22023'; end if;
  update chat_approval set state = p_state, decided_by = current_viewer(), decided_at = clock_timestamp(), note = nullif(left(trim(coalesce(p_note, '')), 2000), ''),
    rounds = rounds + case when p_state = 'changes' then 1 else 0 end where message_id = p_message;
  perform chat_event_line(cid, current_viewer(), case when p_state = 'approved' then 'approved' else 'asked for changes' end || coalesce(': ' || nullif(left(trim(coalesce(p_note, '')), 300), ''), ''),
    jsonb_build_array(jsonb_build_object('name', 'Approval', 'approval', p_message, 'state', p_state)));
end $$;
create function pulse.chat_approval_withdraw(p_message uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare cid uuid := chat_member_message(p_message);
begin
  delete from chat_approval where message_id = p_message and asked_by = current_viewer();
  if not found then raise exception 'only who asked can withdraw it' using errcode = '42501'; end if;
  insert into chat_event(org_id, channel_id) values (current_org(), cid);
end $$;

-- Muted members get no bell or push for ordinary messages; a mention or a reply to them still reaches them.
create or replace function pulse.chat_notify_members() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
declare quoted uuid;
begin
 if new.kind='event' then return null; end if;
 if new.quote_id is not null then select author_id into quoted from chat_message where id=new.quote_id; end if;
 insert into notification(org_id,person_id,title,href,kind,channel_id,message_id)
 select new.org_id,cm.person_id,
 case when cm.person_id=any(new.mentions) then 'You were mentioned in Chats' when cm.person_id=quoted then 'You have a reply in Chats' else 'New message in Chats' end,
 '/chats?channel='||new.channel_id||case when new.parent_id is null then '' else '&thread='||new.parent_id end,
 case when cm.person_id=any(new.mentions) then 'mention' when new.parent_id is not null or cm.person_id=quoted then 'reply' else 'chat' end,
 new.channel_id,new.id
 from chat_member cm join person p on p.id=cm.person_id and p.org_id=cm.org_id
 where cm.org_id=new.org_id and cm.channel_id=new.channel_id and cm.person_id<>new.author_id and p.status='active'
   and (cm.muted_until is null or cm.muted_until<clock_timestamp() or cm.person_id=any(new.mentions) or cm.person_id is not distinct from quoted)
 on conflict do nothing;
 return null;
end $$;

revoke all on function pulse.chat_event_wake(), pulse.chat_mute(uuid, timestamptz), pulse.chat_archive(uuid, boolean), pulse.chat_member_message(uuid),
  pulse.chat_pin_message(uuid, boolean), pulse.chat_star_set(uuid, boolean), pulse.chat_forward(uuid, uuid[]), pulse.chat_annotate(uuid, uuid, real, real, text, uuid),
  pulse.chat_annotation_resolve(uuid, boolean), pulse.chat_approval_ask(uuid), pulse.chat_approval_decide(uuid, text, text), pulse.chat_approval_withdraw(uuid) from public;
grant execute on function pulse.chat_mute(uuid, timestamptz), pulse.chat_archive(uuid, boolean), pulse.chat_pin_message(uuid, boolean), pulse.chat_star_set(uuid, boolean),
  pulse.chat_forward(uuid, uuid[]), pulse.chat_annotate(uuid, uuid, real, real, text, uuid), pulse.chat_annotation_resolve(uuid, boolean),
  pulse.chat_approval_ask(uuid), pulse.chat_approval_decide(uuid, text, text), pulse.chat_approval_withdraw(uuid) to pulse_api;

-- migrate:down
drop trigger if exists chat_event_wake on pulse.chat_event;
drop function if exists pulse.chat_event_wake(), pulse.chat_mute(uuid, timestamptz), pulse.chat_archive(uuid, boolean), pulse.chat_pin_message(uuid, boolean),
  pulse.chat_star_set(uuid, boolean), pulse.chat_forward(uuid, uuid[]), pulse.chat_annotate(uuid, uuid, real, real, text, uuid), pulse.chat_annotation_resolve(uuid, boolean),
  pulse.chat_approval_ask(uuid), pulse.chat_approval_decide(uuid, text, text), pulse.chat_approval_withdraw(uuid), pulse.chat_member_message(uuid);
drop table if exists pulse.chat_approval, pulse.chat_annotation, pulse.chat_star;
drop index if exists pulse.chat_message_pinned;
alter table pulse.chat_message drop column if exists forwarded, drop column if exists pinned_by, drop column if exists pinned_at;
alter table pulse.chat_member drop column if exists archived_at, drop column if exists muted_until;

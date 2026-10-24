-- migrate:up
-- CHAT-V4 (owner, 24 Oct 2026: "many UX/UI changes on chat and new features on chat are required"):
--   mark unread  chat_member.marked_unread_at: a member marks a conversation unread to come back to it; it shows as
--                unread in their list until they open it (their own setting; nobody else sees it, ticks are unchanged).
--   edit history chat_message_revision: the words a message had before each edit, readable by the conversation's
--                members ("edited" opens them). Deleting a message deletes its earlier versions too.
-- Additive: one nullable column, one new table with row security, new functions and one new trigger. Uses only objects
-- defined in this repository's migrations.

alter table pulse.chat_member add column if not exists marked_unread_at timestamptz;

create table pulse.chat_message_revision (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null,
  channel_id uuid not null,
  body text not null,
  replaced_at timestamptz not null default clock_timestamp(),
  foreign key (org_id, message_id) references pulse.chat_message(org_id, id) on delete cascade,
  foreign key (org_id, channel_id) references pulse.chat_channel(org_id, id) on delete cascade
);
create index chat_message_revision_message on pulse.chat_message_revision (org_id, message_id, replaced_at);
alter table pulse.chat_message_revision enable row level security;
alter table pulse.chat_message_revision force row level security;
create policy tenant_isolation on pulse.chat_message_revision using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy member_read on pulse.chat_message_revision as restrictive for select to pulse_api using (pulse.chat_has(channel_id));
grant select on pulse.chat_message_revision to pulse_api;

-- An edit keeps the words it replaced; a deletion takes the earlier versions with it.
create function pulse.chat_revision_keep() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if new.removed_at is not null and old.removed_at is null then
    delete from chat_message_revision where org_id = old.org_id and message_id = old.id;
  elsif new.body is distinct from old.body and new.removed_at is null and new.edited_at is distinct from old.edited_at and length(old.body) > 0 then
    insert into chat_message_revision(org_id, message_id, channel_id, body, replaced_at) values (old.org_id, old.id, old.channel_id, old.body, coalesce(new.edited_at, clock_timestamp()));
  end if;
  return new;
end $$;
create trigger chat_revision_keep before update of body, removed_at on pulse.chat_message for each row execute function pulse.chat_revision_keep();

-- Mine: mark a conversation unread (on) or clear the mark (off; opening or reading it clears it too).
create function pulse.chat_mark_unread(p_channel uuid, p_on boolean) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  update chat_member set marked_unread_at = case when p_on then clock_timestamp() end
  where org_id = current_org() and channel_id = p_channel and person_id = current_viewer() and (p_on or marked_unread_at is not null);
  if p_on and not found then raise exception 'conversation unavailable' using errcode = '42501'; end if;
end $$;

revoke all on function pulse.chat_revision_keep(), pulse.chat_mark_unread(uuid, boolean) from public;
grant execute on function pulse.chat_mark_unread(uuid, boolean) to pulse_api;

-- migrate:down
drop trigger if exists chat_revision_keep on pulse.chat_message;
drop function if exists pulse.chat_revision_keep(), pulse.chat_mark_unread(uuid, boolean);
drop table if exists pulse.chat_message_revision;
alter table pulse.chat_member drop column if exists marked_unread_at;

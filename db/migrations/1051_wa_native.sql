-- migrate:up
-- WA-NATIVE (owner, 25 Oct 2026: "It is not WhatsApp chat now, it's Pulse's own chat with Pulse's own chat interface …
-- if someone did @ to someone it should be tagged in Pulse chat formatting. We needed to MIGRATE all data to here."):
-- every WhatsApp group the import loaded (1015 wa_chat, already tied to its Pulse group chat) gets its whole history as
-- ordinary messages of that Pulse chat, so the chat itself carries it: the list, navigation, search, a jump to a date,
-- threads and replies, reactions, the media gallery, voice notes with their transcripts, files. New messages written in
-- Pulse continue the same chat. The WhatsApp tables stay the lossless source and are not changed.
--  * chat_message.import_ref: the wa_message a message was made from (null for everything written in Pulse); unique, so
--    a sync adds only what is missing and undoing it removes exactly those rows. Original time and author are kept (the
--    time + 1 ms per earlier message of the same minute, so the order of a minute's messages survives paging).
--  * chat_guest / chat_message.guest_id: a sender Pulse has no person for (a number, a name kept as written) is a guest
--    of that chat, shown "name (WhatsApp)", with no person record and no account. author_id is required, so a guest's
--    message is written by the company's single "WhatsApp" placeholder person (inactive, side other); group notices too.
--    A sender mapped later ("Who is this?") takes their messages over at the next sync.
--  * Mentions: "@<number>" and "@Name" become Pulse mentions of the person they name (the group's participants, its
--    members, then the company's staff; a number through the phone Pulse keeps for a person, or a guest's last four
--    digits): the text reads "@username" (or "@Name" for a person without one) and mentions[] carries the person.
--    WhatsApp's text export records no quoted replies and no reactions, so there are none to recreate.
--  * Deleted messages read "This message was deleted"; edited ones carry Pulse's edited mark; the encryption notice is
--    left out; other group notices are compact event lines.
--  * Imported messages never notify, never raise @everyone, never wake an AI employee, never count as unread (a member
--    who joins later starts after them), are never pruned by chat retention, and stay out of every AI employee's
--    context (agent_dispatch, consult context, group AI jobs): imported client text reaches an outside engine only
--    redacted (decision wa-ai-analysis), which is GROUPS-2's path, not these.
--  * Read rules unchanged: a chat's members (chat_has); a client-side person only once opted in to shared history
--    (client_contact_optin, the restrictive policy below); never an AI employee.
--  * A load that finishes (wa_import_finish) syncs its chat in the same transaction (a failure is a warning, never a
--    failed load); a withdrawn batch takes its messages out of the chat.
-- Additive: two nullable columns, new tables and functions; triggers on chat_message are re-created with a WHEN clause
-- (their functions untouched); chat_prune, agent_dispatch, agent_consult_context, chat_group_ai_claim and
-- chat_group_hub are re-written from their latest definitions (0022, 1018, 1035, 1018, 1043) with only the
-- import_ref lines added.

alter table pulse.chat_message add column if not exists import_ref uuid, add column if not exists guest_id uuid;
create unique index if not exists chat_message_import_ref on pulse.chat_message (org_id, import_ref) where import_ref is not null;

create table pulse.chat_guest (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 channel_id uuid not null,
 label text not null check (length(label) between 1 and 120),
 source text not null default 'whatsapp' check (source = 'whatsapp'),
 source_ref uuid not null,                                  -- the wa_participant
 created_at timestamptz not null default now(),
 unique (org_id, source_ref), unique (org_id, id),
 foreign key (org_id, channel_id) references pulse.chat_channel (org_id, id) on delete cascade
);
create index chat_guest_channel on pulse.chat_guest (org_id, channel_id);
create index chat_message_guest on pulse.chat_message (org_id, guest_id) where guest_id is not null;
create index chat_message_imported on pulse.chat_message (org_id, channel_id, created_at desc) where import_ref is not null;

-- Per imported chat: when it was last synced and what the sync found (counts only).
create table pulse_priv.wa_native (
 org_id uuid not null,
 chat_id uuid not null,
 channel_id uuid not null,
 messages int not null default 0 check (messages >= 0),
 stats jsonb not null default '{}' check (jsonb_typeof(stats) = 'object'),
 synced_at timestamptz not null default now(),
 primary key (org_id, chat_id),
 foreign key (org_id, chat_id) references pulse_priv.wa_chat (org_id, id)
);
-- The company's placeholder author of guests' messages and group notices.
create table pulse_priv.wa_native_org (
 org_id uuid primary key references pulse.org(id),
 author_id uuid not null references pulse.person(id)
);

alter table pulse.chat_guest enable row level security;
alter table pulse.chat_guest force row level security;
create policy tenant_isolation on pulse.chat_guest using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
do $$ declare t text; begin
 foreach t in array array['pulse_priv.wa_native', 'pulse_priv.wa_native_org'] loop
  execute format('alter table %s enable row level security', t);
  execute format('alter table %s force row level security', t);
  execute format('create policy tenant on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  execute format('revoke all on %s from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy', t);
 end loop;
end $$;
create trigger audit_mutation after insert or update or delete on pulse.chat_guest for each row execute function pulse.audit_mutation();

-- Who reads imported messages of a chat they may read: the company's active staff, and a client-side person who opted
-- in to shared history. Never an AI employee (its context leaves imported text out as well).
create function pulse.chat_import_reads() returns boolean
language sql stable security definer set search_path = pulse, pg_temp as $$
 select exists (select 1 from person p where p.id = current_viewer() and p.org_id = current_org() and p.status = 'active' and p.side = 'staff')
  or exists (select 1 from client_contact_optin o where o.org_id = current_org() and o.person_id = current_viewer() and o.state = 'opted_in' and 'chat_history' = any(o.scope))
$$;
create policy imported_read on pulse.chat_message as restrictive for select to pulse_api using (import_ref is null or pulse.chat_import_reads());
create policy member_read on pulse.chat_guest as restrictive for select to pulse_api using (pulse.chat_has(channel_id) and pulse.chat_import_reads());
grant select on pulse.chat_guest to pulse_api;

-- Imported rows: no notification, no @everyone, no AI employee event (the functions are unchanged; the WHEN skips them).
drop trigger if exists chat_notify_members on pulse.chat_message;
create trigger chat_notify_members after insert on pulse.chat_message for each row when (new.import_ref is null) execute function pulse.chat_notify_members();
drop trigger if exists chat_broadcast_mark on pulse.chat_message;
create trigger chat_broadcast_mark before insert on pulse.chat_message for each row when (new.import_ref is null) execute function pulse.chat_broadcast_mark();
drop trigger if exists agent_event_from_chat on pulse.chat_message;
create trigger agent_event_from_chat after insert on pulse.chat_message for each row when (new.import_ref is null) execute function pulse.agent_event_from_chat();
drop trigger if exists agent_zconsult_answer on pulse.chat_message;
create trigger agent_zconsult_answer after insert on pulse.chat_message for each row when (new.import_ref is null) execute function pulse.agent_consult_answer();

-- A member who joins an imported chat later starts after its imported history (nothing of it is unread).
create function pulse.wa_native_member_join() returns trigger
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare last_at timestamptz;
begin
 if not exists (select 1 from pulse_priv.wa_chat w where w.org_id = new.org_id and w.channel_id = new.channel_id) then return new; end if;
 select max(m.created_at) into last_at from chat_message m where m.org_id = new.org_id and m.channel_id = new.channel_id and m.import_ref is not null;
 if last_at is not null and new.read_through < last_at then new.read_through := last_at; end if;
 return new;
end $$;
create trigger wa_native_member_join before insert on pulse.chat_member for each row execute function pulse.wa_native_member_join();

-- The company's placeholder author ("WhatsApp", inactive, side other: no account, in no list), made once.
create function pulse.wa_native_author() returns uuid
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare pid uuid;
begin
 select author_id into pid from pulse_priv.wa_native_org where org_id = current_org();
 if pid is not null then return pid; end if;
 insert into person (org_id, display_name, side, status, tracking_excluded) values (current_org(), 'WhatsApp', 'other', 'inactive', true) returning id into pid;
 insert into pulse_priv.wa_native_org (org_id, author_id) values (current_org(), pid);
 return pid;
end $$;

-- Mentions in one message. p_names: [{name, to, person?}] (longest name wins; a name two people share is left out by
-- the caller); p_numbers: [{e164, to, person}] for people whose phone Pulse keeps, [{last4, to}] for the chat's
-- number guests. Returns the text with each mention written the Pulse way, the people mentioned and counts: found
-- (every "@" that starts a word), people, guests. A mention nobody matches stays as written.
create function pulse.wa_native_mentions(p_body text, p_names jsonb, p_numbers jsonb) returns jsonb
language plpgsql stable set search_path = pulse, pg_temp as $$
declare b text := coalesce(p_body, ''); targets text[] := '{}'; ids uuid[] := '{}'; found int; people int := 0; guests int := 0;
 c jsonb; pat text; raw text; d text; e text; hit jsonb; i int := 0; guard int := 0; k int;
begin
 found := (select count(*) from regexp_matches(b, '(^|[^[:alnum:]_.@])@[~+[:alnum:]]', 'g'));
 if found = 0 then return jsonb_build_object('body', b, 'ids', '[]'::jsonb, 'found', 0, 'people', 0, 'guests', 0); end if;
 -- "@+91 98765 43210", "@919876543210": the person with that phone, else the chat's only guest ending in those digits.
 loop
  raw := substring(b from '(?:^|[^[:alnum:]_.@])@(\+?[0-9][0-9  -]{5,18}[0-9])');
  exit when raw is null or guard >= 30;
  guard := guard + 1;
  d := regexp_replace(raw, '[^0-9]', '', 'g');
  e := case when length(d) = 10 and left(d, 1) in ('6', '7', '8', '9') and raw !~ '^\+' then '+91' || d
            when length(d) = 11 and left(d, 1) = '0' and substr(d, 2, 1) in ('6', '7', '8', '9') and raw !~ '^\+' then '+91' || substr(d, 2)
            else '+' || d end;
  hit := (select x from jsonb_array_elements(coalesce(p_numbers, '[]')) x where x->>'e164' = e limit 1);
  if hit is null and (select count(*) from jsonb_array_elements(coalesce(p_numbers, '[]')) x where x->>'last4' = right(d, 4)) = 1 then
   hit := (select x from jsonb_array_elements(p_numbers) x where x->>'last4' = right(d, 4));
  end if;
  i := i + 1;
  b := regexp_replace(b, '(^|[^[:alnum:]_.@])@' || regexp_replace(raw, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g'), '\1' || chr(1) || i || chr(2));
  targets := targets || coalesce(hit->>'to', '@' || raw);
  if hit->>'person' is not null then ids := ids || (hit->>'person')::uuid; people := people + 1;
  elsif hit is not null then guests := guests + 1; end if;
 end loop;
 -- "@Name" / "@~Name": the longest name first, so "@Asha Kireteso" is not read as "@Asha".
 for c in select x from jsonb_array_elements(coalesce(p_names, '[]')) x order by length(x->>'name') desc loop
  exit when position('@' in b) = 0;
  pat := '(^|[^[:alnum:]_.@])@~?\s?' || regexp_replace(regexp_replace(c->>'name', '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g'), '\s+', '\\s+', 'g') || '(?![[:alnum:]_])';
  guard := 0;
  while guard < 10 and b ~* pat loop
   guard := guard + 1; i := i + 1;
   b := regexp_replace(b, pat, '\1' || chr(1) || i || chr(2), 'i');
   targets := targets || (c->>'to');
   if c->>'person' is not null then ids := ids || (c->>'person')::uuid; people := people + 1; else guests := guests + 1; end if;
  end loop;
 end loop;
 for k in 1..i loop b := replace(b, chr(1) || k || chr(2), targets[k]); end loop;
 return jsonb_build_object('body', b, 'ids', to_jsonb(array(select distinct x from unnest(ids) x)), 'found', found, 'people', people, 'guests', guests);
end $$;

-- Take imported messages out of their chat (withdrawn batches, an undo): native replies to them stay, as roots.
create function pulse.wa_native_drop(p_ids uuid[]) returns int
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare n int;
begin
 if coalesce(cardinality(p_ids), 0) = 0 then return 0; end if;
 update chat_message set parent_id = null where org_id = current_org() and parent_id = any(p_ids) and import_ref is null;
 delete from chat_message where org_id = current_org() and id = any(p_ids) and import_ref is not null;
 get diagnostics n = row_count;
 return n;
end $$;

-- One imported chat → its Pulse chat. Idempotent: adds what is missing, moves a newly mapped sender's messages from
-- their guest to the person, takes out messages of withdrawn batches. Returns counts (never text).
create function pulse.wa_native_sync(p_chat uuid) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.wa_chat%rowtype; au uuid; ev0 bigint; names jsonb; nums jsonb; r jsonb; moved int; gone int; last_at timestamptz; total int;
begin
 if current_org() is null then raise exception 'set the company first' using errcode = '42501'; end if;
 select * into c from pulse_priv.wa_chat where org_id = current_org() and id = p_chat for update;
 if not found then raise exception 'chat unavailable' using errcode = '22023'; end if;
 au := wa_native_author();
 select coalesce(max(seq), 0) into ev0 from chat_event;
 -- Guests: senders without a person; a sender mapped since takes their messages over.
 insert into chat_guest (org_id, channel_id, label, source_ref)
 select current_org(), c.channel_id, left(pa.label, 120), pa.id from pulse_priv.wa_participant pa
  where pa.org_id = current_org() and pa.chat_id = c.id and pa.person_id is null
 on conflict (org_id, source_ref) do update set label = excluded.label where chat_guest.label is distinct from excluded.label;
 update chat_message m set author_id = pa.person_id, guest_id = null
   from chat_guest g join pulse_priv.wa_participant pa on pa.org_id = g.org_id and pa.id = g.source_ref
  where g.org_id = current_org() and g.channel_id = c.channel_id and pa.person_id is not null and m.org_id = g.org_id and m.guest_id = g.id;
 get diagnostics moved = row_count;
 -- Who a mention may name: the group's participants, its members, then the company's staff (a name that would name two
 -- people is left out), and the phones Pulse keeps for them.
 with who as (
   select pa.person_id person, g.id guest, pa.kind, 1 rank, n.name
     from pulse_priv.wa_participant pa left join chat_guest g on g.org_id = pa.org_id and g.source_ref = pa.id and pa.person_id is null
     left join person p on p.id = pa.person_id
     cross join lateral (values (case when pa.kind not in ('number', 'unknown') then pa.label end),
                                (case when pa.label_raw !~ '^[+0-9 ()‪‬-]+$' then regexp_replace(pa.label_raw, '^~\s*', '') end), (p.display_name)) n(name)
    where pa.org_id = current_org() and pa.chat_id = c.id and pa.kind <> 'unknown'
   union all
   select p.id, null, 'colleague', 2, n.name from chat_member cm join person p on p.id = cm.person_id left join people_profile pp on pp.person_id = p.id
     cross join lateral (values (p.display_name), (pp.username)) n(name)
    where cm.org_id = current_org() and cm.channel_id = c.channel_id
   union all
   select p.id, null, 'colleague', 3, n.name from person p left join people_profile pp on pp.person_id = p.id
     cross join lateral (values (p.display_name), (pp.username)) n(name)
    where p.org_id = current_org() and p.side = 'staff' and p.status = 'active'),
  named as (select lower(btrim(name)) k, min(rank) rank from who where length(btrim(coalesce(name, ''))) >= 3 group by 1),
  -- first names too ("@Asha" for Asha Kireteso) when only one person of the group goes by it
  firsts as (select lower(split_part(btrim(w.name), ' ', 1)) k, w.person, w.guest, w.rank from who w
              where w.rank < 3 and btrim(coalesce(w.name, '')) like '% %' and length(split_part(btrim(w.name), ' ', 1)) >= 3),
  cand as (select n.k, w.person, w.guest from named n join who w on lower(btrim(w.name)) = n.k and w.rank = n.rank
           union select f.k, f.person, f.guest from firsts f where not exists (select 1 from named n where n.k = f.k)),
  one as (select k, (array_agg(person))[1] person, (array_agg(guest))[1] guest from cand group by k
          having count(distinct coalesce(person::text, guest::text)) = 1)
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', o.k, 'person', o.person,
          'to', '@' || coalesce(pp.username, p.display_name, g.label)))), '[]')
   into names
   from one o left join person p on p.id = o.person left join people_profile pp on pp.person_id = o.person left join chat_guest g on g.id = o.guest
  where coalesce(pp.username, p.display_name, g.label) is not null;
 select coalesce(jsonb_agg(x.j), '[]') into nums from (
   select jsonb_build_object('e164', pv.phone_e164, 'person', p.id, 'to', '@' || coalesce(pp.username, p.display_name)) j
     from pulse_priv.person_private pv join person p on p.id = pv.person_id left join people_profile pp on pp.person_id = p.id
    where pv.org_id = current_org() and pv.phone_e164 is not null and (p.side = 'staff'
      or exists (select 1 from pulse_priv.wa_participant pa where pa.org_id = current_org() and pa.chat_id = c.id and pa.person_id = p.id))
   union all
   select jsonb_build_object('last4', right(regexp_replace(g.label, '[^0-9]', '', 'g'), 4), 'to', '@' || g.label)
     from chat_guest g join pulse_priv.wa_participant pa on pa.org_id = g.org_id and pa.id = g.source_ref
    where g.org_id = current_org() and g.channel_id = c.channel_id and pa.kind = 'number' and g.label ~ '[0-9]{4}$') x;
 -- The messages.
 with src as (
   select m.*, (row_number() over (partition by m.sent_at order by m.seq) - 1)::int dup
     from pulse_priv.wa_message m join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
    where m.org_id = current_org() and m.chat_id = c.id),
 todo as materialized (
   select s.id, s.seq, s.sent_at, s.dup, s.kind, s.subtype, s.body, s.edited, s.extra, s.file_sha256, s.file_name, s.file_state, s.media_type,
     pa.person_id pp, g.id gid, f.mime fmime, f.size fsize, f.kind fkind, f.meta fmeta, fp.mime pmime,
     case when s.kind in ('text', 'media') and position('@' in s.body) > 0 then wa_native_mentions(s.body, names, nums) end mx
     from src s
     left join pulse_priv.wa_participant pa on pa.org_id = s.org_id and pa.id = s.participant_id
     left join chat_guest g on g.org_id = s.org_id and g.source_ref = pa.id and pa.person_id is null
     left join pulse_priv.wa_file f on f.org_id = s.org_id and f.sha256 = s.file_sha256 and f.complete
     left join pulse_priv.wa_file fp on fp.org_id = s.org_id and fp.sha256 = f.meta->>'playable' and fp.complete
    where not (s.kind = 'system' and coalesce(s.subtype, '') = 'encryption')
      and not exists (select 1 from chat_message x where x.org_id = s.org_id and x.import_ref = s.id)),
 ins as (
   insert into chat_message (org_id, channel_id, author_id, body, attachments, mentions, client_id, created_at, updated_at, edited_at,
     removed_at, removal_reason, kind, import_ref, guest_id)
   select current_org(), c.channel_id, coalesce(t.pp, au),
     left(case t.kind
       when 'deleted' then ''
       when 'location' then concat_ws(E'\n', nullif(btrim(t.body), ''), '📍 ' || case when (t.extra->'location'->>'live') = 'true' then 'Live location' else 'Location' end
         || coalesce(': ' || coalesce(t.extra->'location'->>'url', 'https://maps.google.com/?q=' || (t.extra->'location'->>'lat') || ',' || (t.extra->'location'->>'lon')), ''))
       when 'contact' then coalesce(nullif(btrim(t.body), ''), 'Contact card' || coalesce(': ' || (select string_agg(x, ', ') from jsonb_array_elements_text(t.extra->'contact'->'names') x), ''))
       when 'call' then case when (t.extra->'call'->>'missed') = 'true' then 'Missed call' else 'Call' end
       else coalesce(t.mx->>'body', t.body) end, 12000),
     case when t.file_state = 'attached' and t.fmime is not null then jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
         'id', 'wa-' || case when t.fkind in ('voice', 'audio') and t.pmime is not null then t.fmeta->>'playable' else t.file_sha256 end,
         'wa', t.file_sha256,
         'name', coalesce(t.file_name, case t.fkind when 'image' then 'Photo' when 'video' then 'Video' when 'voice' then 'Voice message' when 'audio' then 'Audio'
           when 'sticker' then 'Sticker' when 'contact' then 'Contact card' when 'gif' then 'GIF' else 'Document' end),
         'mime', case when t.fkind in ('voice', 'audio') and t.pmime is not null then t.pmime else t.fmime end,
         'size', t.fsize, 'kind', t.fkind, 'w', t.fmeta->'width', 'h', t.fmeta->'height',
         'voice', case when t.fkind in ('voice', 'audio') and t.fmeta ? 'seconds' then jsonb_build_object('seconds', round((t.fmeta->>'seconds')::numeric, 1),
           'peaks', coalesce(t.fmeta->'peaks', '[]'::jsonb)) end,
         'seconds', case when t.fkind = 'video' then t.fmeta->'seconds' end,
         'poster', case when t.fkind = 'video' then t.fmeta->>'poster' end,
         'playable', case when t.fkind = 'video' then t.fmeta->>'playable' end)))
       when t.file_state in ('omitted', 'missing', 'attached') then jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('omitted', coalesce(t.media_type, 'unknown'), 'name', t.file_name)))
       else '[]'::jsonb end,
     coalesce(array(select jsonb_array_elements_text(t.mx->'ids'))::uuid[], '{}'),
     t.id, t.sent_at + t.dup * interval '1 millisecond', t.sent_at + t.dup * interval '1 millisecond',
     case when t.edited then t.sent_at + t.dup * interval '1 millisecond' end,
     case when t.kind = 'deleted' then t.sent_at end, case when t.kind = 'deleted' then 'Deleted in WhatsApp' end,
     case when t.kind in ('system', 'call') then 'event' else 'text' end, t.id, case when t.pp is null then t.gid end
   from todo t order by t.sent_at, t.seq
   on conflict do nothing
   returning import_ref)
 select jsonb_build_object('added', count(*), 'mentionsFound', coalesce(sum((t.mx->>'found')::int), 0),
   'mentionsPeople', coalesce(sum((t.mx->>'people')::int), 0), 'mentionsGuests', coalesce(sum((t.mx->>'guests')::int), 0),
   'messagesWithMentions', count(*) filter (where (t.mx->>'found')::int > 0), 'truncated', count(*) filter (where length(t.body) > 12000))
   into r from ins join todo t on t.id = ins.import_ref;
 -- Messages of withdrawn batches leave the chat.
 select wa_native_drop(array(select x.id from chat_message x join pulse_priv.wa_message m on m.org_id = x.org_id and m.id = x.import_ref
     join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id
    where x.org_id = current_org() and x.channel_id = c.channel_id and b.withdrawn_at is not null)) into gone;
 -- Nothing imported is unread; the chat's live listeners are told once, not once per message.
 select max(created_at), count(*) into last_at, total from chat_message where org_id = current_org() and channel_id = c.channel_id and import_ref is not null;
 if last_at is not null then
  update chat_member set read_through = last_at where org_id = current_org() and channel_id = c.channel_id and read_through < last_at;
 end if;
 -- The group's most active colleagues look after it in Pulse (as admins did in WhatsApp) when nobody does yet.
 if not exists (select 1 from chat_member where org_id = current_org() and channel_id = c.channel_id and role = 'admin') then
  update chat_member cm set role = 'admin' from (select pa.person_id from pulse_priv.wa_participant pa join person p on p.id = pa.person_id
      join chat_member x on x.channel_id = c.channel_id and x.person_id = pa.person_id
     where pa.org_id = current_org() and pa.chat_id = c.id and p.side = 'staff' and p.status = 'active' and pa.messages > 0
     order by pa.messages desc limit 2) a
   where cm.org_id = current_org() and cm.channel_id = c.channel_id and cm.person_id = a.person_id;
 end if;
 delete from chat_event where org_id = current_org() and channel_id = c.channel_id and seq > ev0;
 if (r->>'added')::int > 0 or moved > 0 or gone > 0 then insert into chat_event (org_id, channel_id) values (current_org(), c.channel_id); end if;
 r := r || jsonb_build_object('moved', moved, 'removed', gone, 'messages', total,
   'source', (select count(*) from pulse_priv.wa_message m join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
               where m.org_id = current_org() and m.chat_id = c.id),
   'skipped', (select count(*) from pulse_priv.wa_message m where m.org_id = current_org() and m.chat_id = c.id and m.kind = 'system' and m.subtype = 'encryption'),
   'guests', (select count(*) from chat_guest g where g.org_id = current_org() and g.channel_id = c.channel_id));
 insert into pulse_priv.wa_native (org_id, chat_id, channel_id, messages, stats, synced_at)
 values (current_org(), c.id, c.channel_id, total, r, now())
 on conflict (org_id, chat_id) do update set messages = excluded.messages, synced_at = now(),
   stats = case when (excluded.stats->>'added')::int > 0 then pulse_priv.wa_native.stats || excluded.stats
     || jsonb_build_object('mentionsFound', coalesce((pulse_priv.wa_native.stats->>'mentionsFound')::int, 0) + (excluded.stats->>'mentionsFound')::int,
          'mentionsPeople', coalesce((pulse_priv.wa_native.stats->>'mentionsPeople')::int, 0) + (excluded.stats->>'mentionsPeople')::int,
          'mentionsGuests', coalesce((pulse_priv.wa_native.stats->>'mentionsGuests')::int, 0) + (excluded.stats->>'mentionsGuests')::int,
          'messagesWithMentions', coalesce((pulse_priv.wa_native.stats->>'messagesWithMentions')::int, 0) + (excluded.stats->>'messagesWithMentions')::int)
     else pulse_priv.wa_native.stats || (excluded.stats - 'added' - 'mentionsFound' - 'mentionsPeople' - 'mentionsGuests' - 'messagesWithMentions' - 'truncated') end;
 perform audit_write('migrate', 'wa_native', p_chat::text, array['messages']);
 return r;
end $$;

-- Undo for one chat: its imported messages and guests leave the Pulse chat (the WhatsApp tables are untouched).
create function pulse.wa_native_undo(p_chat uuid) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.wa_chat%rowtype; n int;
begin
 if current_org() is null then raise exception 'set the company first' using errcode = '42501'; end if;
 select * into c from pulse_priv.wa_chat where org_id = current_org() and id = p_chat for update;
 if not found then raise exception 'chat unavailable' using errcode = '22023'; end if;
 n := wa_native_drop(array(select x.id from chat_message x where x.org_id = current_org() and x.channel_id = c.channel_id and x.import_ref is not null));
 delete from chat_guest g where g.org_id = current_org() and g.channel_id = c.channel_id and not exists (select 1 from chat_message m where m.org_id = g.org_id and m.guest_id = g.id);
 delete from pulse_priv.wa_native where org_id = current_org() and chat_id = c.id;
 insert into chat_event (org_id, channel_id) values (current_org(), c.channel_id);
 perform audit_write('undo', 'wa_native', p_chat::text, array['messages']);
 return jsonb_build_object('removed', n);
end $$;

-- A load that finishes syncs its chat; a withdrawn batch takes its messages out. Never fails the load or the withdrawal.
create function pulse.wa_native_on_batch() returns trigger
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if (old.finished_at is null and new.finished_at is not null) or (old.withdrawn_at is null and new.withdrawn_at is not null) then
  begin
   perform wa_native_sync(new.chat_id);
  exception when others then
   raise warning 'wa_native_sync: %', sqlerrm;
  end;
 end if;
 return null;
end $$;
create trigger wa_native_on_batch after update of finished_at, withdrawn_at on pulse_priv.wa_import_batch for each row execute function pulse.wa_native_on_batch();

-- ---------------------------------------------------------------------------------------------------------------
-- Reads (API). The imported chat behind a Pulse chat, for its readers: the WhatsApp group's counts and period, and
-- whether its history is in the chat itself now (native) — the chat's one "imported" marker.
create function pulse.wa_native_channel(p_channel uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object('chatId', c.id, 'messages', c.messages, 'firstAt', c.first_at, 'lastAt', c.last_at,
   'native', n.chat_id is not null, 'nativeMessages', n.messages, 'syncedAt', n.synced_at,
   'guests', (select count(*)::int from chat_guest g where g.org_id = c.org_id and g.channel_id = c.channel_id))
 from pulse_priv.wa_chat c left join pulse_priv.wa_native n on n.org_id = c.org_id and n.chat_id = c.id
 where c.org_id = current_org() and c.channel_id = p_channel and wa_reader(c.id) and chat_import_reads()
$$;

-- Everyone who wrote in the WhatsApp group, for the chat's info: colleagues, client-side people (with their opt-in) and
-- guests, most active first, and whether they are members of the Pulse chat.
create function pulse.wa_native_people(p_channel uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('participantId', pa.id, 'personId', pa.person_id, 'name', coalesce(p.display_name, pa.label),
     'kind', pa.kind, 'side', p.side, 'messages', pa.messages, 'firstAt', pa.first_at, 'lastAt', pa.last_at,
     'member', exists (select 1 from chat_member cm where cm.channel_id = c.channel_id and cm.person_id = pa.person_id),
     'optIn', (select o.state from client_contact_optin o where o.org_id = c.org_id and o.person_id = pa.person_id and viewer_is('admin', 'leadership')))
   order by pa.messages desc, pa.label), '[]'::jsonb)
 from pulse_priv.wa_chat c join pulse_priv.wa_participant pa on pa.org_id = c.org_id and pa.chat_id = c.id left join person p on p.id = pa.person_id
 where c.org_id = current_org() and c.channel_id = p_channel and wa_reader(c.id) and chat_import_reads() and pa.messages > 0
$$;

-- What the chat's imported voice notes say (local Whisper; 1016 wa_transcript), for its readers.
create function pulse.wa_native_voice(p_channel uuid) returns table (message_id uuid, transcript text, language text)
language sql stable security definer set search_path = pulse, pg_temp as $$
 select m.id, t.text, t.language from chat_message m join pulse_priv.wa_transcript t on t.org_id = m.org_id and t.sha256 = m.attachments->0->>'wa'
 where m.org_id = current_org() and m.channel_id = p_channel and m.import_ref is not null and m.attachments->0 ? 'voice' and m.removed_at is null
   and chat_import_reads() and exists (select 1 from pulse_priv.wa_chat c where c.org_id = m.org_id and c.channel_id = p_channel and wa_reader(c.id))
$$;

-- Where a WhatsApp message is now (old links to the WhatsApp viewer, signals): its chat message, for its readers.
create function pulse.wa_native_message(p_wa_message uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object('channelId', x.channel_id, 'messageId', x.id) from chat_message x join pulse_priv.wa_chat c on c.org_id = x.org_id and c.channel_id = x.channel_id
 where x.org_id = current_org() and x.import_ref = p_wa_message and wa_reader(c.id) and chat_import_reads()
$$;

-- Admins: how far the migration is, for the company (counts only).
create function pulse.wa_native_status() returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select case when viewer_is('admin') then jsonb_build_object(
   'chats', (select count(*) from pulse_priv.wa_chat where org_id = current_org()),
   'native', (select count(*) from pulse_priv.wa_native where org_id = current_org()),
   'source', (select coalesce(sum(messages), 0) from pulse_priv.wa_chat where org_id = current_org()),
   'messages', (select coalesce(sum(messages), 0) from pulse_priv.wa_native where org_id = current_org()),
   'mentionsFound', (select coalesce(sum((stats->>'mentionsFound')::int), 0) from pulse_priv.wa_native where org_id = current_org()),
   'mentionsPeople', (select coalesce(sum((stats->>'mentionsPeople')::int), 0) from pulse_priv.wa_native where org_id = current_org()),
   'mentionsGuests', (select coalesce(sum((stats->>'mentionsGuests')::int), 0) from pulse_priv.wa_native where org_id = current_org()),
   'guests', (select count(*) from chat_guest where org_id = current_org()),
   'lastSync', (select max(synced_at) from pulse_priv.wa_native where org_id = current_org())) end
$$;

revoke all on function pulse.chat_import_reads(), pulse.wa_native_author(), pulse.wa_native_mentions(text, jsonb, jsonb), pulse.wa_native_drop(uuid[]),
 pulse.wa_native_sync(uuid), pulse.wa_native_undo(uuid), pulse.wa_native_channel(uuid), pulse.wa_native_people(uuid), pulse.wa_native_voice(uuid),
 pulse.wa_native_status(), pulse.wa_native_message(uuid), pulse.wa_native_member_join(), pulse.wa_native_on_batch() from public;
grant execute on function pulse.chat_import_reads(), pulse.wa_native_channel(uuid), pulse.wa_native_people(uuid), pulse.wa_native_voice(uuid),
 pulse.wa_native_status(), pulse.wa_native_message(uuid) to pulse_api;

-- ---------------------------------------------------------------------------------------------------------------
-- Re-written from their latest definitions with only the import_ref lines added.

-- chat_prune (0022)
create or replace function pulse.chat_prune() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n int;
begin
 delete from pulse_priv.chat_file f where f.created_at<now()-interval '365 days' or f.created_at<now()-interval '1 day' and not exists(select 1 from chat_message m where m.attachments @> jsonb_build_array(jsonb_build_object('id',f.id::text)));
 -- Remove replies before roots to respect the self reference, including newer replies to expired roots.
 -- WA-NATIVE: history imported from WhatsApp (import_ref) is never pruned here; its retention is the import's.
 delete from chat_message where parent_id in(select id from chat_message where created_at<now()-interval '365 days' and import_ref is null) and import_ref is null;
 delete from chat_message where created_at<now()-interval '365 days' and import_ref is null;get diagnostics n=row_count;
 delete from chat_event where at<now()-interval '365 days';
 return n;
end $$;

-- agent_dispatch (1018)
create or replace function pulse.agent_dispatch(p_id uuid, p_token uuid, p_lane text, p_model text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pulse', 'pg_temp'
as $function$
declare me uuid := agent_session(); e agent_event; m agent_member; msg chat_message; why text; busy text; committed int; rid uuid; dl timestamptz;
  ch_kind text; approver uuid; mode text;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  m := agent_lock(me);
  select * into e from agent_event where id = p_id and org_id = current_org() and agent_id = me for update;
  if not found or e.state <> 'leased' or e.lease_token is distinct from p_token or e.lease_until <= now() then
    raise exception 'That event is not leased to you any more' using errcode='22023'; end if;
  perform agent_sweep(me);
  select * into msg from chat_message where id = e.subject_id;
  why := case
    when e.subject_type <> 'message' then 'not_chats'
    when msg.id is null or msg.removed_at is not null then 'message_gone'
    when not agent_leader(e.invoked_by) and m.listens_to <> 'everyone' then 'not_leader'
    when not exists(select 1 from chat_member where channel_id = msg.channel_id and person_id = me) then 'agent_left'
    when not exists(select 1 from chat_member where channel_id = msg.channel_id and person_id = e.invoked_by) then 'asker_left'
  end;
  if why is null then
    select coalesce(sum(case when state in ('done','error') then coalesce(tokens, reserved) else reserved end), 0) into committed
      from agent_run where agent_id = me and (started_at at time zone org_time_zone())::date = (now() at time zone org_time_zone())::date;
    if committed + m.run_reserve > m.daily_token_budget then why := 'budget_spent'; end if;
  end if;
  if why is not null then
    update agent_event set state = 'failed', finished_at = now(), lease_token = null, lease_until = null, reason = why where id = e.id;
    return jsonb_build_object('status', 'refused', 'reason', why);
  end if;
  busy := case
    when m.disabled_at is not null then 'paused'
    when exists(select 1 from agent_run where agent_id = me and state = 'dispatching') then 'one_at_a_time'
    when (select count(*) from agent_run where agent_id = me and started_at > now() - interval '1 hour') >= 60 then 'hourly_limit'
  end;
  if busy is not null then
    update agent_event set state = 'queued', lease_token = null, lease_until = null, retry_at = now() + interval '20 seconds', reason = busy where id = e.id;
    return jsonb_build_object('status', 'busy', 'reason', busy);
  end if;
  -- AI-EMP (5): 6 minutes, longer than the runtime's own 4-minute wait for a chat answer.
  dl := now() + interval '6 minutes';
  insert into agent_run(org_id, agent_id, event_id, lane, model, reserved, deadline)
  values (current_org(), me, e.id, left(coalesce(nullif(p_lane, ''), m.lane), 40), left(coalesce(p_model, ''), 80), m.run_reserve, dl) returning id into rid;
  update agent_event set state = 'dispatching', run_id = rid, lease_token = null, lease_until = null, reason = null where id = e.id;
  -- AI-EMP (1): its approver writing to it directly is answered directly.
  select kind into ch_kind from chat_channel where id = msg.channel_id;
  approver := coalesce(m.approver_person_id, m.owner_person_id);
  mode := agent_mode_for(m, e.event_type);
  if mode = 'off' and e.event_type = 'chat.group' and agent_group_role(me, msg.channel_id) = 'coordinator' then mode := 'approve'; end if;
  if mode = 'approve' and ch_kind = 'direct' and msg.author_id = approver then mode := 'own'; end if;
  return jsonb_build_object('status', 'dispatched', 'runId', rid, 'reserved', m.run_reserve,
    'deadline', to_char(dl at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'context', jsonb_build_object(
      'mode', mode, 'kind', e.event_type, 'askerIsApprover', msg.author_id = approver, 'groupRole', agent_group_role(me, msg.channel_id),
      'approver', (select display_name from person where id = approver),
      -- AI-EMP (4)
      'now', to_char(now() at time zone org_time_zone(), 'FMDay DD Mon YYYY, HH24:MI'), 'timeZone', org_time_zone(),
      -- AI-EMP (2)
      'newer', exists(select 1 from agent_event e2 join chat_message x2 on x2.id = e2.subject_id
                       where e2.org_id = current_org() and e2.agent_id = me and e2.id <> e.id and e2.subject_type = 'message'
                         and e2.state in ('queued', 'leased') and x2.channel_id = msg.channel_id and x2.removed_at is null
                         and x2.created_at > msg.created_at),
      'instructions', left(m.instructions, 8000), 'sops', to_jsonb(m.sop_links),
      'memory', (select coalesce(jsonb_agg(left(x.body, 400) order by x.created_at desc), '[]'::jsonb) from (
                  select body, created_at from agent_memory where agent_id = me and retired_at is null order by created_at desc limit 20) x),
      'message', (select jsonb_build_object('id', x.id, 'channelId', x.channel_id, 'parentId', x.parent_id, 'body', left(x.body, 2000),
                    'author', p.display_name, 'channelKind', ch.kind, 'channelName', case when ch.kind = 'direct' then null else ch.name end)
                  from chat_message x join person p on p.id = x.author_id join chat_channel ch on ch.id = x.channel_id where x.id = msg.id),
      -- AI-EMP (3): no empty messages (cards), none of its own proposal cards.
      'recent', (select coalesce(jsonb_agg(r.j order by r.at), '[]'::jsonb) from (
                  select x.created_at at, jsonb_build_object('author', p.display_name, 'byAgent', p.side = 'agent', 'mine', x.author_id = me,
                           'body', left(x.body, 600)) j
                    from chat_message x join person p on p.id = x.author_id
                   where x.channel_id = msg.channel_id and x.removed_at is null and x.kind = 'text' and x.created_at <= msg.created_at and x.import_ref is null
                     and btrim(coalesce(x.body, '')) <> ''
                     and not exists(select 1 from agent_proposal pr where pr.dm_message_id = x.id)
                   order by x.created_at desc limit 14) r)));
end $function$;

-- agent_consult_context (1035)
create or replace function pulse.agent_consult_context(p_msg uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
  select jsonb_build_object('id', c.id, 'question', c.question, 'colleague', col.display_name, 'asker', ask.display_name,
    'sourceChannelId', c.source_channel_id, 'sourceChannelName', case when sch.kind = 'direct' then 'a direct message' else sch.name end,
    'sourceMessage', left(sm.body, 1500), 'clientFacing', chat_client_facing(c.source_channel_id),
    'approver', (select display_name from person where id = agent_approver_for(c.agent_id, c.source_channel_id)),
    'sourceRecent', (select coalesce(jsonb_agg(r.j order by r.at), '[]'::jsonb) from (
        select x.created_at at, jsonb_build_object('author', p.display_name, 'mine', x.author_id = c.agent_id, 'body', left(x.body, 500)) j
          from chat_message x join person p on p.id = x.author_id
         where x.channel_id = c.source_channel_id and x.removed_at is null and x.kind = 'text' and btrim(coalesce(x.body, '')) <> '' and x.import_ref is null
         order by x.created_at desc limit 8) r))
    from chat_message m join agent_consult c on c.dm_channel_id = m.channel_id and c.colleague_id = m.author_id and c.agent_id = agent_session()
    join person col on col.id = c.colleague_id left join person ask on ask.id = c.asker_id
    join chat_channel sch on sch.id = c.source_channel_id left join chat_message sm on sm.id = c.source_message_id
   where m.id = p_msg and c.state in ('answered','relayed','open') order by c.created_at desc limit 1
$$;

-- chat_group_ai_claim (1018)
create or replace function pulse.chat_group_ai_claim(p_history boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); j chat_group_ai_job; m agent_member; used int;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  update chat_group_ai_job set status = 'queued', lease_until = null where org_id = current_org() and agent_id = me and status = 'running' and lease_until < now();
  update chat_group_ai_job x set status = 'failed', error = 'It is no longer in this group', finished_at = now()
   where x.org_id = current_org() and x.agent_id = me and x.status = 'queued'
     and not exists (select 1 from chat_member where channel_id = x.channel_id and person_id = me);
  select * into m from agent_member where person_id = me;
  select coalesce(sum(coalesce(tokens, reserved)), 0)::int into used from agent_run
   where agent_id = me and (started_at at time zone org_time_zone())::date = (now() at time zone org_time_zone())::date;
  used := used + coalesce((select sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0))::int from chat_group_ai_job
                            where agent_id = me and finished_at > now() - interval '1 day'), 0);
  if used + 30000 > m.daily_token_budget then return null; end if;
  select * into j from chat_group_ai_job where org_id = current_org() and agent_id = me and status = 'queued' order by created_at limit 1 for update skip locked;
  if not found then return null; end if;
  update chat_group_ai_job set status = 'running', started_at = now(), lease_until = now() + interval '12 minutes' where id = j.id;
  return jsonb_build_object('id', j.id, 'kind', j.kind, 'note', j.note, 'channelId', j.channel_id,
    'askedBy', (select display_name from person where id = j.asked_by),
    'now', to_char(now() at time zone org_time_zone(), 'FMDay DD Mon YYYY, HH24:MI'),
    'group', (select jsonb_build_object('name', ch.name, 'role', agent_group_role(me, ch.id), 'clientFacing', chat_client_facing(ch.id),
        'client', (select display_name from client where id = g.client_id), 'project', (select name from project where id = g.project_id),
        'area', g.area, 'pod', g.pod, 'segments', g.segments, 'services', g.services,
        'members', (select coalesce(jsonb_agg(jsonb_build_object('name', p.display_name, 'side', p.side) order by p.display_name), '[]')
                      from chat_member cm join person p on p.id = cm.person_id where cm.channel_id = ch.id))
      from chat_channel ch left join chat_group_info g on g.channel_id = ch.id where ch.id = j.channel_id),
    'messages', (select coalesce(jsonb_agg(x.j order by x.at), '[]') from (
        select msg.created_at at, jsonb_build_object('at', to_char(msg.created_at at time zone org_time_zone(), 'DD Mon HH24:MI'), 'author', p.display_name,
          'side', p.side, 'body', regexp_replace(left(msg.body, 600), '\+?\d[\d \-]{8,}\d', '[number]', 'g'),
          'files', jsonb_array_length(msg.attachments)) j
          from chat_message msg join person p on p.id = msg.author_id
         where msg.channel_id = j.channel_id and msg.removed_at is null and msg.kind = 'text' and msg.import_ref is null
         order by msg.created_at desc limit 120) x),
    'history', case when p_history then (select coalesce(jsonb_agg(jsonb_build_object('at', h.at, 'author', h.author,
          'body', regexp_replace(left(h.body, 500), '\+?\d[\d \-]{8,}\d', '[number]', 'g'))), '[]')
        from chat_group_history_lines(j.channel_id, 150) h) else '[]'::jsonb end,
    'openTasks', (select coalesce(jsonb_agg(jsonb_build_object('title', t.title, 'status', t.status, 'due', t.due_at::date, 'who', (select display_name from person where id = t.assignee_person_id))), '[]')
       from (select t.* from task t left join chat_group_info g on g.channel_id = j.channel_id
              where t.org_id = current_org() and t.deleted_at is null and t.status not in ('done', 'accepted', 'cancelled')
                and ((g.project_id is not null and t.project_id = g.project_id)
                     or exists (select 1 from chat_task_follow f where f.task_id = t.id and f.channel_id = j.channel_id))
              order by t.due_at nulls last limit 30) t),
    'maxOut', case j.kind when 'summary' then 1200 when 'extract' then 2000 else 900 end);
end $$;

-- chat_group_hub (1043)
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
  -- WA-NATIVE: imported messages are chat messages now; counted once (as imported), never unread, waiting only when recent.
  msg as (select m.channel_id, max(m.created_at) filter (where m.import_ref is null) l, count(*) filter (where m.kind = 'text' and m.import_ref is null)::int n,
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
    case when mine.person_id is null then 0 else (select count(*)::int from chat_message m where m.channel_id = ch.id and m.author_id <> v.me and m.import_ref is null
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
         and (c.import_ref is null or c.created_at > now() - interval '30 days')
         and c.created_at > coalesce(ls.at, '-infinity')
       order by c.created_at asc limit 1) w on true
$$;

-- migrate:down
-- Forward-only.

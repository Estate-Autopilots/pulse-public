-- migrate:up
-- SELLER-ONBOARD (owner, 17 Nov 2026): "When he sends the details to the Pulse chat, detect it on your own and add them
-- into the application." People's details sent in a chat become people in Pulse, after a preview someone confirms.
--
-- An admin or HR opens an intake on a conversation (and, if they like, a task and a doc). Whatever the people it watches
-- send there afterwards (typed or pasted rows, a CSV or Excel file, a photo of a written list, a comment on the task,
-- the doc's table) is read on this server by tools/people-intake.py (text, files, OCR; nothing leaves the server), and a
-- preview card ("Add N sellers?") with the problems it found is posted in the conversation. Nothing changes until one of
-- the intake's approvers (an admin or HR at that moment) confirms (services/api/src/people-intake.ts): the rows are then
-- added or updated through People's own add and edit, invitations go out, the hand-off list (an app's testers) is kept
-- for the server's worker to write out, and the intake's group is made with its first steps pinned.

create table pulse.people_intake (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 2 and 40),          -- what the rows are: "Sellers"
  channel_id uuid not null,                                             -- the conversation it watches and answers in
  task_id uuid,
  doc_id uuid,
  watch_ids uuid[] not null check (cardinality(watch_ids) between 1 and 20),
  approver_ids uuid[] not null check (cardinality(approver_ids) between 1 and 20),
  defaults jsonb not null default '{}'::jsonb,                          -- {"department": "Sales"}
  group_name text check (group_name is null or length(group_name) between 2 and 60),
  group_id uuid,
  welcome_message_id uuid,
  app_url text check (app_url is null or app_url ~ '^https://[^[:space:]]+$'),
  tester_label text check (tester_label is null or length(tester_label) between 2 and 40),
  tester_optin_url text check (tester_optin_url is null or tester_optin_url ~ '^https://[^[:space:]]+$'),
  handoff text check (handoff is null or handoff ~ '^[a-z][a-z0-9-]{1,30}$'),
  since timestamptz not null default now(),                             -- what was sent after this is read
  doc_seen text,                                                        -- the doc content last read (md5)
  state text not null default 'watching' check (state in ('watching', 'closed')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index people_intake_one_per_chat on pulse.people_intake(org_id, channel_id) where state = 'watching';

create table pulse.people_intake_batch (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  intake_id uuid not null references pulse.people_intake(id),
  source text not null check (source in ('message', 'comment', 'doc')),
  source_id uuid not null,
  source_key text not null,
  author_id uuid,
  state text not null default 'preview' check (state in ('preview', 'applying', 'applied', 'dismissed', 'superseded', 'empty')),
  rows jsonb not null default '[]'::jsonb check (jsonb_typeof(rows) = 'array' and jsonb_array_length(rows) <= 300),
  read_from jsonb not null default '[]'::jsonb,                         -- [{kind: text|csv|xlsx|photo|doc, name}]
  note text,
  message_id uuid,
  decided_by uuid,
  decided_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (intake_id, source, source_key)
);
create index people_intake_batch_intake on pulse.people_intake_batch(intake_id, created_at desc);

create table pulse_priv.people_intake_handoff (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  intake_id uuid not null references pulse.people_intake(id),
  batch_id uuid not null references pulse.people_intake_batch(id),
  kind text not null,
  rows jsonb not null check (jsonb_typeof(rows) = 'array'),
  state text not null default 'pending' check (state in ('pending', 'written', 'answered')),
  path text,
  written_at timestamptz,
  answer jsonb,
  answered_at timestamptz,
  created_at timestamptz not null default now()
);

do $$ declare t text; begin
  foreach t in array array['pulse.people_intake', 'pulse.people_intake_batch', 'pulse_priv.people_intake_handoff'] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format('create policy tenant on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  end loop;
end $$;
-- The API reads intakes and batches only through the functions below (and the card's function checks the chat);
-- the worker reads its queue through them too. Neither role touches the tables directly.
revoke all on pulse.people_intake, pulse.people_intake_batch, pulse_priv.people_intake_handoff from public;

-- Who may confirm: one of the intake's approvers who is an admin or HR right now.
create function pulse.people_intake_can_decide(p_intake uuid) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select current_viewer() is not null and viewer_is('admin', 'hr')
     and exists (select 1 from people_intake i where i.org_id = current_org() and i.id = p_intake and current_viewer() = any(i.approver_ids))
$$;

-- The staff a list is matched against, for an admin or HR: who they are, whether they can sign in already (a password
-- or Google sign-in, or a Pulse account's seat) and whether a live invitation is out; current = still with the company.
create function pulse.people_intake_staff(p_ids uuid[] default null) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is null or not viewer_is('admin', 'hr') then raise exception 'Admins and HR' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'status', p.status, 'role', pp.role, 'department', pp.department,
      'email', pp.email, 'phone', pp.phone, 'current', p.status = 'active' and chat_current(p.id),
      'canSignIn', exists (select 1 from login_credential lc where lc.person_id = p.id and lc.status = 'active') or exists (select 1 from pulse_priv.account_member m where m.person_id = p.id),
      'invited', (select i.status from pulse_priv.staff_invitation i where i.person_id = p.id and (i.status = 'used' or (i.status = 'sent' and i.expires_at > now())))))
    from person p left join people_profile pp on pp.person_id = p.id
   where p.org_id = current_org() and p.side = 'staff' and (p_ids is null or p.id = any(p_ids))), '[]'::jsonb);
end $$;

-- The first steps pinned in the intake's group: the app, the tester link (or that it is coming), and what to do first.
create function pulse.people_intake_welcome(p_intake uuid) returns text language sql stable security definer set search_path = pulse, pg_temp as $$
  select concat_ws(E'\n',
    format('Welcome to %s on Pulse. Start here, 3 steps:', coalesce(i.group_name, 'the team')),
    '',
    format('1. Pulse: open your invite (e-mail or WhatsApp) and set your password. Then open %s in Chrome on your phone, tap ⋮ and Install app, so Pulse sits on your home screen. Help: %s/apps/get',
      coalesce(i.app_url, 'Pulse'), coalesce(i.app_url, '')),
    case when i.tester_label is null then null
      when i.tester_optin_url is null then format('2. %s (Android): we are adding your Gmail to its tester list. The tester link comes here, pinned, within a day.', i.tester_label)
      else format('2. %s (Android): on your phone, signed in with the Gmail you gave us, open %s, tap Become a tester, then install %s from the Play Store.', i.tester_label, i.tester_optin_url, i.tester_label) end,
    case when i.tester_label is null then '2. Check your profile in People (name, phone, manager) and say hi here.'
      else format('3. Open %s, sign in with the same Gmail and allow calls and recordings. Your calls then show in Pulse.', i.tester_label) end,
    '',
    'Questions? Ask here in this group.')
  from people_intake i where i.org_id = current_org() and i.id = p_intake
$$;

-- An admin or HR opens an intake on a conversation they are in.
create function pulse.people_intake_open(p jsonb) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_id uuid; v_channel uuid := (p ->> 'channelId')::uuid; v_task uuid := nullif(p ->> 'taskId', '')::uuid; v_doc uuid := nullif(p ->> 'docId', '')::uuid;
  v_watch uuid[] := array(select distinct x::uuid from jsonb_array_elements_text(coalesce(p -> 'watchIds', '[]')) x);
  v_appr uuid[] := array(select distinct x::uuid from jsonb_array_elements_text(coalesce(p -> 'approverIds', '[]')) x);
  v_since timestamptz := coalesce(nullif(p ->> 'since', '')::timestamptz, now());
begin
  if current_viewer() is null or not viewer_is('admin', 'hr') then raise exception 'Admins and HR collect people''s details' using errcode = '42501'; end if;
  if v_channel is null or not chat_has(v_channel) then raise exception 'Choose a conversation you are in' using errcode = '22023'; end if;
  if v_task is not null and not exists (select 1 from task_visible_ids() t where t = v_task) then raise exception 'Choose a task you can see' using errcode = '22023'; end if;
  if v_doc is not null and not exists (select 1 from doc d where d.org_id = current_org() and d.id = v_doc and d.archived_at is null) then raise exception 'Choose a doc of this company' using errcode = '22023'; end if;
  if cardinality(v_watch) = 0 or exists (select 1 from unnest(v_watch) w where not exists (
      select 1 from chat_member cm join person pe on pe.id = cm.person_id where cm.channel_id = v_channel and cm.person_id = w and pe.side = 'staff' and pe.status = 'active')) then
    raise exception 'Whose messages are read: active staff in the conversation' using errcode = '22023'; end if;
  if not (current_viewer() = any(v_appr)) then v_appr := v_appr || current_viewer(); end if;
  if exists (select 1 from unnest(v_appr) a where not exists (select 1 from person pe where pe.org_id = current_org() and pe.id = a and pe.side = 'staff' and pe.status = 'active')) then
    raise exception 'Who confirms: active staff' using errcode = '22023'; end if;
  if v_since > now() + interval '1 minute' or v_since < now() - interval '14 days' then raise exception 'Read from a time in the last 14 days' using errcode = '22023'; end if;
  insert into people_intake(org_id, title, channel_id, task_id, doc_id, watch_ids, approver_ids, defaults, group_name, app_url, tester_label, tester_optin_url, handoff, since, created_by)
  values (current_org(), btrim(coalesce(p ->> 'title', 'People')), v_channel, v_task, v_doc, v_watch, v_appr,
    jsonb_strip_nulls(jsonb_build_object('department', nullif(left(btrim(coalesce(p -> 'defaults' ->> 'department', '')), 60), ''))),
    nullif(btrim(coalesce(p ->> 'groupName', '')), ''), nullif(btrim(coalesce(p ->> 'appUrl', '')), ''), nullif(btrim(coalesce(p ->> 'testerLabel', '')), ''),
    nullif(btrim(coalesce(p ->> 'testerOptinUrl', '')), ''), nullif(btrim(coalesce(p ->> 'handoff', '')), ''), v_since, current_viewer())
  returning id into v_id;
  perform audit_write('create', 'people_intake', v_id::text);
  return v_id;
exception when unique_violation then raise exception 'Pulse already reads this conversation for people''s details' using errcode = '23505';
end $$;

create function pulse.people_intake_close(p_intake uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is null or not viewer_is('admin', 'hr') then raise exception 'Admins and HR stop an intake' using errcode = '42501'; end if;
  update people_intake set state = 'closed', updated_at = now() where org_id = current_org() and id = p_intake and state = 'watching';
  if not found then raise exception 'That intake is not open' using errcode = 'P0002'; end if;
  perform audit_write('close', 'people_intake', p_intake::text);
end $$;

-- The open intakes of this company, for its admins and HR.
create function pulse.people_intake_list() returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is null or not viewer_is('admin', 'hr') then raise exception 'Admins and HR' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'channelId', i.channel_id, 'taskId', i.task_id, 'docId', i.doc_id, 'state', i.state,
      'groupName', i.group_name, 'groupId', i.group_id, 'testerLabel', i.tester_label, 'testerOptinUrl', i.tester_optin_url, 'since', i.since,
      'batches', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'state', b.state, 'rows', jsonb_array_length(b.rows), 'at', b.created_at) order by b.created_at desc), '[]')
                  from people_intake_batch b where b.intake_id = i.id)) order by i.created_at desc)
    from people_intake i where i.org_id = current_org()), '[]'::jsonb);
end $$;

-- The worker: what the open intakes of this company have not read yet (messages and task comments by the people they
-- watch, after they opened; the doc once it has been quiet for a minute and changed). Newest last, a few at a time.
create function pulse.people_intake_pending() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(x order by x ->> 'at'), '[]'::jsonb) from (
    (select jsonb_build_object('intake', i.id, 'kind', 'message', 'id', m.id, 'key', m.id::text, 'author', m.author_id, 'body', m.body, 'at', m.created_at,
        'files', coalesce((select jsonb_agg(jsonb_build_object('id', a ->> 'id', 'name', a ->> 'name', 'mime', a ->> 'mime'))
                           from jsonb_array_elements(m.attachments) a where a ? 'id' and not a ? 'voice'), '[]'::jsonb)) x
      from people_intake i join chat_message m on m.org_id = i.org_id and m.channel_id = i.channel_id
     where i.org_id = current_org() and i.state = 'watching' and m.kind = 'text' and m.removed_at is null and m.import_ref is null
       and m.created_at > i.since and m.author_id = any(i.watch_ids)
       and not exists (select 1 from people_intake_batch b where b.intake_id = i.id and b.source = 'message' and b.source_key = m.id::text)
     order by m.created_at limit 10)
    union all
    (select jsonb_build_object('intake', i.id, 'kind', 'comment', 'id', w.id, 'key', w.id::text, 'author', w.author_id, 'body', w.body, 'at', w.created_at, 'files', '[]'::jsonb)
      from people_intake i join work_comment w on w.org_id = i.org_id and w.task_id = i.task_id
     where i.org_id = current_org() and i.state = 'watching' and w.removed_at is null and w.created_at > i.since and w.author_id = any(i.watch_ids)
       and not exists (select 1 from people_intake_batch b where b.intake_id = i.id and b.source = 'comment' and b.source_key = w.id::text)
     order by w.created_at limit 10)
    union all
    (select jsonb_build_object('intake', i.id, 'kind', 'doc', 'id', d.id, 'key', md5(coalesce(d.body_html, '')), 'author', d.updated_by, 'html', d.body_html, 'at', d.updated_at, 'files', '[]'::jsonb)
      from people_intake i join doc d on d.org_id = i.org_id and d.id = i.doc_id
     where i.org_id = current_org() and i.state = 'watching' and d.archived_at is null and d.updated_at > i.since and d.updated_at < now() - interval '60 seconds'
       and d.updated_by = any(i.watch_ids) and md5(coalesce(d.body_html, '')) is distinct from i.doc_seen
       and not exists (select 1 from people_intake_batch b where b.intake_id = i.id and b.source = 'doc' and b.source_key = md5(coalesce(d.body_html, ''))))
  ) s
$$;

-- The worker: a file attached to a message the intake watches (and only such a file).
create function pulse.people_intake_file(p_intake uuid, p_message uuid, p_file uuid) returns table(name text, mime text, bytes bytea)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select f.name, f.mime, f.bytes from people_intake i
    join chat_message m on m.org_id = i.org_id and m.channel_id = i.channel_id and m.id = p_message
    join pulse_priv.chat_file f on f.org_id = i.org_id and f.channel_id = i.channel_id and f.id = p_file
   where i.org_id = current_org() and i.id = p_intake and i.state = 'watching' and m.author_id = any(i.watch_ids) and m.created_at > i.since
     and exists (select 1 from jsonb_array_elements(m.attachments) a where a ->> 'id' = p_file::text)
$$;

-- The worker: what it read. With rows, the card goes into the conversation (an older card not yet decided is replaced)
-- and the approvers are told; without rows but with a note (a file it could not read), the note is said there; plain
-- talk without rows is kept quietly so it is not read again.
create function pulse.people_intake_read(p_intake uuid, p_source text, p_source_id uuid, p_key text, p_author uuid, p_rows jsonb, p_read_from jsonb, p_note text)
  returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare i people_intake; v_id uuid; v_n int := jsonb_array_length(coalesce(p_rows, '[]')); v_msg uuid; v_body text; v_what text;
begin
  select * into i from people_intake where org_id = current_org() and id = p_intake and state = 'watching' for update;
  if not found then return null; end if;
  if p_source = 'doc' then update people_intake set doc_seen = p_key, updated_at = now() where id = i.id; end if;
  insert into people_intake_batch(org_id, intake_id, source, source_id, source_key, author_id, state, rows, read_from, note)
  values (current_org(), i.id, p_source, p_source_id, p_key, p_author, case when v_n > 0 then 'preview' else 'empty' end, coalesce(p_rows, '[]'), coalesce(p_read_from, '[]'), left(p_note, 500))
  on conflict (intake_id, source, source_key) do nothing returning id into v_id;
  if v_id is null then return null; end if;
  v_what := lower(i.title);
  if v_n > 0 then
    -- A corrected list replaces the card it repeats people of; another page of the list (other people) keeps its own.
    update people_intake_batch o set state = 'superseded', updated_at = now() where o.intake_id = i.id and o.state = 'preview' and o.id <> v_id
       and exists (select 1 from jsonb_array_elements(o.rows) a cross join jsonb_array_elements(p_rows) b
                    where (a ->> 'phone' is not null and a ->> 'phone' = b ->> 'phone') or (a ->> 'email' is not null and a ->> 'email' = b ->> 'email')
                       or (a ->> 'name' is not null and lower(a ->> 'name') = lower(b ->> 'name')));
    v_body := case p_source when 'doc' then format('filled in %s %s in the doc. Check them below, then confirm.', v_n, case when v_n = 1 then rtrim(v_what, 's') else v_what end)
      when 'comment' then format('sent %s %s on the task. Check them below, then confirm.', v_n, case when v_n = 1 then rtrim(v_what, 's') else v_what end)
      else format('sent the details of %s %s. Check them below, then confirm.', v_n, case when v_n = 1 then rtrim(v_what, 's') else v_what end) end;
    v_msg := chat_event_line(i.channel_id, coalesce(p_author, i.created_by), v_body, jsonb_build_array(jsonb_build_object('name', i.title || ' to add', 'intake', v_id)));
    update people_intake_batch set message_id = v_msg where id = v_id;
    -- As a chat message notifies (chat_notify_members): the conversation and the card's line.
    insert into notification(org_id, person_id, title, href, kind, channel_id, message_id)
    select current_org(), a, format('%s to add: check and confirm', i.title), '/chats?channel=' || i.channel_id || '&message=' || v_msg, 'chat', i.channel_id, v_msg
      from unnest(i.approver_ids) a join person pe on pe.id = a and pe.org_id = current_org() and pe.status = 'active'
     where a is distinct from p_author;
  elsif p_note is not null then
    v_msg := chat_event_line(i.channel_id, coalesce(p_author, i.created_by), left(p_note, 500));
    update people_intake_batch set message_id = v_msg where id = v_id;
  end if;
  return v_id;
end $$;

-- The card under the preview, for the conversation's members.
create function pulse.people_intake_card(p_batch uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare b people_intake_batch; i people_intake;
begin
  select * into b from people_intake_batch where org_id = current_org() and id = p_batch;
  if not found then return null; end if;
  select * into i from people_intake where id = b.intake_id;
  if not chat_has(i.channel_id) then return null; end if;
  return jsonb_build_object('id', b.id, 'state', b.state, 'source', b.source, 'rows', b.rows, 'readFrom', b.read_from, 'note', b.note, 'createdAt', b.created_at,
    'author', (select jsonb_build_object('id', pe.id, 'name', pe.display_name) from person pe where pe.id = b.author_id),
    'decidedBy', (select pe.display_name from person pe where pe.id = b.decided_by), 'decidedAt', b.decided_at, 'result', b.result,
    'canDecide', b.state = 'preview' and people_intake_can_decide(i.id),
    'approvers', (select coalesce(jsonb_agg(pe.display_name order by pe.display_name), '[]') from person pe where pe.id = any(i.approver_ids) and pe.status = 'active'),
    'intake', jsonb_build_object('id', i.id, 'title', i.title, 'groupName', i.group_name, 'groupId', i.group_id, 'testerLabel', i.tester_label,
      'handoff', i.handoff is not null, 'department', i.defaults ->> 'department'));
end $$;

-- An approver confirms: the batch is taken (once) and its rows come back for the API to apply as that person.
create function pulse.people_intake_claim(p_batch uuid) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare b people_intake_batch; i people_intake;
begin
  select * into b from people_intake_batch where org_id = current_org() and id = p_batch for update;
  if not found then raise exception 'That list is not available' using errcode = 'P0002'; end if;
  select * into i from people_intake where id = b.intake_id for update;
  if not chat_has(i.channel_id) or not people_intake_can_decide(i.id) then raise exception 'Only % can confirm this', (select string_agg(pe.display_name, ' or ') from person pe where pe.id = any(i.approver_ids)) using errcode = '42501'; end if;
  if b.state <> 'preview' then raise exception '%', case b.state when 'superseded' then 'A newer list replaced this one' when 'dismissed' then 'This list was set aside' else 'This list is already done' end using errcode = '55000'; end if;
  update people_intake_batch set state = 'applying', decided_by = current_viewer(), decided_at = now(), updated_at = now() where id = b.id;
  perform audit_write('confirm', 'people_intake_batch', b.id::text);
  return jsonb_build_object('rows', b.rows, 'intake', jsonb_build_object('id', i.id, 'title', i.title, 'channelId', i.channel_id, 'groupName', i.group_name, 'groupId', i.group_id,
    'welcomeMessageId', i.welcome_message_id, 'approverIds', to_jsonb(i.approver_ids), 'department', i.defaults ->> 'department', 'testerLabel', i.tester_label, 'handoff', i.handoff));
end $$;

-- After the API applied the rows (in the same transaction): the result, the group, the hand-off list and a line in the chat.
create function pulse.people_intake_finish(p_batch uuid, p_result jsonb, p_handoff jsonb, p_group uuid, p_welcome uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare b people_intake_batch; i people_intake; v_added int := coalesce((p_result ->> 'added')::int, 0); v_updated int := coalesce((p_result ->> 'updated')::int, 0); v_line text;
begin
  select * into b from people_intake_batch where org_id = current_org() and id = p_batch and state = 'applying' and decided_by = current_viewer() for update;
  if not found then raise exception 'Confirm the list first' using errcode = '55000'; end if;
  select * into i from people_intake where id = b.intake_id for update;
  update people_intake_batch set state = 'applied', result = p_result, updated_at = now() where id = b.id;
  update people_intake set group_id = coalesce(p_group, group_id), welcome_message_id = coalesce(p_welcome, welcome_message_id), updated_at = now() where id = i.id;
  -- Every approver runs the group (whoever confirms the next list adds its people), when they are in it.
  update chat_member set role = 'admin' where org_id = current_org() and channel_id = coalesce(p_group, i.group_id) and person_id = any(i.approver_ids) and role is distinct from 'admin';
  if i.handoff is not null and jsonb_typeof(p_handoff) = 'array' and jsonb_array_length(p_handoff) > 0 then
    insert into pulse_priv.people_intake_handoff(org_id, intake_id, batch_id, kind, rows) values (current_org(), i.id, b.id, i.handoff, p_handoff);
  end if;
  v_line := concat_ws(' ', format('added %s and updated %s %s in Pulse.', v_added, v_updated, lower(i.title)),
    case when coalesce(p_group, i.group_id) is not null then format('They are in the group “%s”.', i.group_name) end);
  perform chat_event_line(i.channel_id, current_viewer(), v_line);
  perform audit_write('apply', 'people_intake_batch', b.id::text);
end $$;

-- Invitations are sent after the rows are in; their outcome is added to the result.
create function pulse.people_intake_invited(p_batch uuid, p_invites jsonb) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  update people_intake_batch set result = coalesce(result, '{}'::jsonb) || jsonb_build_object('invites', p_invites), updated_at = now()
   where org_id = current_org() and id = p_batch and state = 'applied' and decided_by = current_viewer();
  if not found then raise exception 'That list is not applied' using errcode = '55000'; end if;
end $$;

create function pulse.people_intake_dismiss(p_batch uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare b people_intake_batch;
begin
  select * into b from people_intake_batch where org_id = current_org() and id = p_batch for update;
  if not found then raise exception 'That list is not available' using errcode = 'P0002'; end if;
  if not people_intake_can_decide(b.intake_id) then raise exception 'Only the people who confirm can set it aside' using errcode = '42501'; end if;
  if b.state <> 'preview' then raise exception 'This list is already decided' using errcode = '55000'; end if;
  update people_intake_batch set state = 'dismissed', decided_by = current_viewer(), decided_at = now(), updated_at = now() where id = b.id;
  perform audit_write('dismiss', 'people_intake_batch', b.id::text);
end $$;

-- The worker: hand-off lists not yet written out, and marking one written.
create function pulse.people_intake_handoffs() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'kind', h.kind, 'intake', h.intake_id, 'org', o.handle, 'orgName', o.name, 'rows', h.rows, 'state', h.state, 'path', h.path,
      'createdAt', h.created_at) order by h.created_at), '[]'::jsonb)
    from pulse_priv.people_intake_handoff h join org o on o.id = h.org_id where h.org_id = current_org() and h.state in ('pending', 'written')
$$;
create function pulse.people_intake_handoff_written(p_handoff uuid, p_path text) returns void language sql security definer set search_path = pulse, pg_temp as $$
  update pulse_priv.people_intake_handoff set state = 'written', path = left(p_path, 500), written_at = now() where org_id = current_org() and id = p_handoff and state = 'pending'
$$;

-- The worker: the other side answered a hand-off (the testers were added; the opt-in link). The link is kept on the
-- intake, the group's first steps are posted again with it and pinned in place of the old ones, and the conversation hears.
create function pulse.people_intake_answer(p_handoff uuid, p_url text, p_detail jsonb) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare h pulse_priv.people_intake_handoff; i people_intake; v_author uuid; v_msg uuid; v_url text := nullif(btrim(coalesce(p_url, '')), '');
begin
  select * into h from pulse_priv.people_intake_handoff where org_id = current_org() and id = p_handoff and state in ('pending', 'written') for update;
  if not found then return null; end if;
  if v_url is not null and v_url !~ '^https://[^[:space:]]+$' then raise exception 'The tester link must be an https address' using errcode = '22023'; end if;
  update pulse_priv.people_intake_handoff set state = 'answered', answer = jsonb_strip_nulls(coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('optInUrl', v_url)), answered_at = now() where id = h.id;
  select * into i from people_intake where id = h.intake_id for update;
  if v_url is null or v_url is not distinct from i.tester_optin_url then return null; end if;
  update people_intake set tester_optin_url = v_url, updated_at = now() where id = i.id;
  if i.group_id is null then return null; end if;
  select author_id into v_author from chat_message where id = i.welcome_message_id;
  v_author := coalesce(v_author, i.created_by);
  if not exists (select 1 from chat_member where channel_id = i.group_id and person_id = v_author) then return null; end if;
  insert into chat_message(org_id, channel_id, author_id, body, attachments, client_id) values (current_org(), i.group_id, v_author, people_intake_welcome(i.id), '[]', gen_random_uuid()) returning id into v_msg;
  update chat_message set pinned_at = null, pinned_by = null where org_id = current_org() and id = i.welcome_message_id and pinned_at is not null;
  update chat_message set pinned_at = clock_timestamp(), pinned_by = v_author where id = v_msg;
  perform chat_event_line(i.group_id, v_author, 'pinned a message', jsonb_build_array(jsonb_build_object('name', 'Pinned message', 'pinned', v_msg)));
  update people_intake set welcome_message_id = v_msg where id = i.id;
  perform chat_event_line(i.channel_id, v_author, format('The %s tester link is now pinned in “%s”.', i.tester_label, i.group_name));
  return v_msg;
end $$;

revoke all on function pulse.people_intake_can_decide(uuid), pulse.people_intake_staff(uuid[]), pulse.people_intake_welcome(uuid), pulse.people_intake_open(jsonb), pulse.people_intake_close(uuid),
  pulse.people_intake_list(), pulse.people_intake_pending(), pulse.people_intake_file(uuid, uuid, uuid), pulse.people_intake_read(uuid, text, uuid, text, uuid, jsonb, jsonb, text),
  pulse.people_intake_card(uuid), pulse.people_intake_claim(uuid), pulse.people_intake_finish(uuid, jsonb, jsonb, uuid, uuid), pulse.people_intake_invited(uuid, jsonb),
  pulse.people_intake_dismiss(uuid), pulse.people_intake_handoffs(), pulse.people_intake_handoff_written(uuid, text), pulse.people_intake_answer(uuid, text, jsonb) from public;
grant execute on function pulse.people_intake_staff(uuid[]), pulse.people_intake_welcome(uuid), pulse.people_intake_open(jsonb), pulse.people_intake_close(uuid), pulse.people_intake_list(), pulse.people_intake_card(uuid),
  pulse.people_intake_claim(uuid), pulse.people_intake_finish(uuid, jsonb, jsonb, uuid, uuid), pulse.people_intake_invited(uuid, jsonb), pulse.people_intake_dismiss(uuid) to pulse_api;
grant execute on function pulse.people_intake_pending(), pulse.people_intake_file(uuid, uuid, uuid), pulse.people_intake_read(uuid, text, uuid, text, uuid, jsonb, jsonb, text),
  pulse.people_intake_handoffs(), pulse.people_intake_handoff_written(uuid, text), pulse.people_intake_answer(uuid, text, jsonb) to pulse_worker;

-- migrate:down
-- Forward-only.

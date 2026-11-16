-- migrate:up
-- GROUPS-2 (owner, 25 Oct 2026: imported groups become usable intelligence, safely; standing decision wa-ai-analysis =
-- "redacted": an outside AI engine reads client WhatsApp text only with names and phone numbers replaced by ids).
-- A group's AI jobs (summary, tasks and approvals, reply draft) now reach an engine only redacted: the API
-- (services/api/src/redact.ts) replaces people, clients, projects, phone numbers, e-mail addresses, postal addresses
-- and other names with stable ids ([P12], [C3], [PRJ7], [PH2], [E1], [A4], [N9]) before the prompt leaves Pulse, and
-- puts the names back in the answer. Additive:
--   ai_alias        the stable ids: which person, client, project, number or word an id stands for, per company. Only
--                   here (never in a prompt, a log or the engine's answer); a phone number keeps only its last 4 digits.
--   ai_vocab        how the company's own messages use each word (how often, in how many chats, how often capitalised
--                   inside a sentence): an ordinary word stays, a rare capitalised one is taken for a name. Refreshed
--                   every 3 days.
--   chat_group_ai_job.redaction  the ids a job's prompt used and what was replaced (counts), to put names back.
-- Who reads: nobody directly (no grants; row security forced). The AI employee's runtime session (its own job) and
-- admins use the functions below; the API calls them while it builds a prompt or reads an answer.

create table pulse_priv.ai_alias (
  org_id uuid not null references pulse.org(id),
  prefix text not null check (prefix in ('P', 'C', 'PRJ', 'G', 'PH', 'E', 'A', 'N')),
  n int not null check (n > 0),
  kind text not null check (kind in ('person', 'participant', 'label', 'client', 'project', 'group', 'phone', 'email', 'address', 'name')),
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  ref uuid,
  value text check (length(value) <= 300),
  created_at timestamptz not null default now(),
  primary key (org_id, prefix, n),
  unique (org_id, digest)
);

create table pulse_priv.ai_vocab (
  org_id uuid not null references pulse.org(id),
  word text not null check (length(word) between 1 and 40),
  n int not null check (n > 0),
  chats int not null check (chats > 0),
  mid int not null check (mid >= 0),     -- times inside a sentence (not its first word)
  cap int not null check (cap >= 0),     -- of those, times with a capital
  primary key (org_id, word)
);
create table pulse_priv.ai_vocab_state (
  org_id uuid primary key references pulse.org(id),
  refreshed_at timestamptz not null,
  messages int not null,
  words int not null
);

do $$ declare t text; begin
  foreach t in array array['pulse_priv.ai_alias', 'pulse_priv.ai_vocab', 'pulse_priv.ai_vocab_state'] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format('create policy tenant on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('revoke all on %s from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy', t);
  end loop;
end $$;

alter table pulse.chat_group_ai_job add column redaction jsonb check (redaction is null or (jsonb_typeof(redaction) = 'object' and length(redaction::text) <= 20000));

-- Who redacts: an AI employee's runtime (for its jobs) and admins (the measured leak check).
create function pulse.ai_redaction_allowed() returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select agent_session() is not null or viewer_is('admin')
$$;

-- The company's words, counted again when older than 3 days (or when asked): live messages and both kinds of imported
-- history. A word is a run of letters (any script, with its marks) and apostrophes.
create function pulse.ai_vocab_refresh(p_force boolean default false) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare st pulse_priv.ai_vocab_state; msgs int; words int;
begin
  if not ai_redaction_allowed() then raise exception 'Only an AI employee''s runtime or an admin' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('pulse.ai_vocab:' || current_org()::text));
  select * into st from pulse_priv.ai_vocab_state where org_id = current_org();
  if found and not p_force and st.refreshed_at > now() - interval '3 days' then
    return jsonb_build_object('fresh', true, 'refreshedAt', st.refreshed_at, 'messages', st.messages, 'words', st.words);
  end if;
  delete from pulse_priv.ai_vocab where org_id = current_org();
  create temp table ai_vocab_msgs on commit drop as
    select m.channel_id ch, m.body from chat_message m where m.org_id = current_org() and m.removed_at is null and m.kind = 'text' and m.import_ref is null
    union all
    select m.channel_id, m.body from pulse_priv.chat_import_message m
      join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
     where m.org_id = current_org() and m.kind = 'text'
    union all
    select c.channel_id, m.body from pulse_priv.wa_message m join pulse_priv.wa_chat c on c.org_id = m.org_id and c.id = m.chat_id
      join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
     where m.org_id = current_org() and m.kind in ('text', 'media') and m.body <> '';
  select count(*) into msgs from ai_vocab_msgs;
  -- Capitals count only inside a sentence: "Thanks" opening a message says nothing about whether it is a name.
  insert into pulse_priv.ai_vocab (org_id, word, n, chats, mid, cap)
  select current_org(), lower(w), count(*), count(distinct ch), count(*) filter (where not s), count(*) filter (where not s and w <> lower(w))
    from ai_vocab_msgs, regexp_matches(body, '(^|[^[:alpha:]ऀ-ॿ'']+)([[:alpha:]][[:alpha:]ऀ-ॿ'']*)', 'g') x(a),
         lateral (select a[2] w, a[1] = '' or a[1] ~ '[.!?:\n]' s) y
   where length(w) between 2 and 40
   group by lower(w);
  get diagnostics words = row_count;
  insert into pulse_priv.ai_vocab_state (org_id, refreshed_at, messages, words) values (current_org(), now(), msgs, words)
  on conflict (org_id) do update set refreshed_at = excluded.refreshed_at, messages = excluded.messages, words = excluded.words;
  return jsonb_build_object('fresh', false, 'refreshedAt', now(), 'messages', msgs, 'words', words);
end $$;

-- How the company uses these words: {fresh: counted in the last 3 days, words: {word: [times, chats, times inside a
-- sentence, of those capitalised]}} (words not seen are left out). Counting takes a while on a large history: the API counts again in the
-- background when it is not fresh, and redacts with what there is meanwhile (no counts: stricter, never looser).
create function pulse.ai_vocab_lookup(p_words text[]) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if not ai_redaction_allowed() then raise exception 'Only an AI employee''s runtime or an admin' using errcode = '42501'; end if;
  if cardinality(p_words) > 20000 then raise exception 'Up to 20,000 words at once' using errcode = '22023'; end if;
  return jsonb_build_object(
    'fresh', exists (select 1 from pulse_priv.ai_vocab_state s where s.org_id = current_org() and s.refreshed_at > now() - interval '3 days'),
    'words', (select coalesce(jsonb_object_agg(v.word, jsonb_build_array(v.n, v.chats, v.mid, v.cap)), '{}')
                from pulse_priv.ai_vocab v where v.org_id = current_org() and v.word = any(p_words)));
end $$;

-- The names a group's text may carry, for the redactor (never sent anywhere): every person of the company (former
-- colleagues and client contacts included), clients, projects, the senders of its imported history (and every
-- imported sender's name in the company), the group's own name and the client its name gives, and known places
-- (areas and cities the hub read, project locations), which stay as written.
create function pulse.ai_redaction_names(p_channel uuid) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if not ai_redaction_allowed() then raise exception 'Only an AI employee''s runtime or an admin' using errcode = '42501'; end if;
  if agent_session() is not null and not exists (select 1 from chat_member where org_id = current_org() and channel_id = p_channel and person_id = agent_session()) then
    raise exception 'Not a group this AI employee is in' using errcode = '42501'; end if;
  return jsonb_build_object(
    'people', (select coalesce(jsonb_agg(jsonb_build_array(p.id, p.display_name, p.side,
                 exists (select 1 from chat_member cm where cm.channel_id = p_channel and cm.person_id = p.id))), '[]')
                 from person p where p.org_id = current_org() and btrim(coalesce(p.display_name, '')) <> ''),
    'clients', (select coalesce(jsonb_agg(jsonb_build_array(c.id, c.display_name, c.company_name)), '[]') from client c where c.org_id = current_org()),
    'projects', (select coalesce(jsonb_agg(jsonb_build_array(x.id, x.name, x.location)), '[]') from project x where x.org_id = current_org() and x.deleted_at is null),
    'participants', (select coalesce(jsonb_agg(jsonb_build_array(pa.id, pa.label, pa.person_id, pa.kind)), '[]')
                 from pulse_priv.wa_participant pa join pulse_priv.wa_chat c on c.org_id = pa.org_id and c.id = pa.chat_id
                where pa.org_id = current_org() and c.channel_id = p_channel),
    'labels', (select coalesce(jsonb_agg(distinct l), '[]') from (
                 select pa.label l from pulse_priv.wa_participant pa where pa.org_id = current_org() and pa.kind not in ('number', 'unknown')
                 union select m.author_label from pulse_priv.chat_import_message m where m.org_id = current_org()) z),
    'group', (select jsonb_build_object('id', ch.id, 'name', ch.name, 'client', g.parsed->>'client', 'project', g.parsed->>'project')
                from chat_channel ch left join chat_group_info g on g.channel_id = ch.id where ch.org_id = current_org() and ch.id = p_channel),
    'places', (select coalesce(jsonb_agg(distinct pl), '[]') from (
                 select g.area pl from chat_group_info g where g.org_id = current_org() and g.area is not null
                 union select g.city from chat_group_info g where g.org_id = current_org() and g.city is not null) z));
end $$;

-- Stable ids for what a prompt replaces: [{prefix, kind, digest, ref, value}] → {digest: n}. The same person, number
-- or word gets the same id in every prompt of the company; new ones take the next number of their prefix.
create function pulse.ai_alias_get(p_rows jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not ai_redaction_allowed() then raise exception 'Only an AI employee''s runtime or an admin' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 5000 then raise exception 'Up to 5,000 ids at once' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('pulse.ai_alias:' || current_org()::text));
  insert into pulse_priv.ai_alias (org_id, prefix, n, kind, digest, ref, value)
  select current_org(), r.prefix, coalesce((select max(a.n) from pulse_priv.ai_alias a where a.org_id = current_org() and a.prefix = r.prefix), 0)
           + row_number() over (partition by r.prefix order by r.ord), r.kind, r.digest, r.ref, left(r.value, 300)
    from (select distinct on (x->>'digest') x->>'prefix' prefix, x->>'kind' kind, x->>'digest' digest, (x->>'ref')::uuid ref, x->>'value' value, o ord
            from jsonb_array_elements(p_rows) with ordinality e(x, o) order by x->>'digest', o) r
   where not exists (select 1 from pulse_priv.ai_alias a where a.org_id = current_org() and a.digest = r.digest);
  return (select coalesce(jsonb_object_agg(a.digest, a.prefix || a.n), '{}') from pulse_priv.ai_alias a
           where a.org_id = current_org() and a.digest in (select x->>'digest' from jsonb_array_elements(p_rows) x));
end $$;

-- What the ids of one job stand for, to put names back in its answer: {token: words}. Only the AI employee whose job it
-- is, while it finishes it (or an admin). People as Pulse names them now; a number as "number ending 1234".
create function pulse.ai_alias_resolve(p_job uuid) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare j chat_group_ai_job;
begin
  select * into j from chat_group_ai_job where org_id = current_org() and id = p_job;
  if not found or not (j.agent_id = agent_session() or viewer_is('admin')) then raise exception 'Not your job' using errcode = '42501'; end if;
  return (select coalesce(jsonb_object_agg(a.prefix || a.n, case a.kind
      when 'person' then (select display_name from person where id = a.ref)
      when 'participant' then (select coalesce((select display_name from person where id = pa.person_id), pa.label) from pulse_priv.wa_participant pa where pa.org_id = a.org_id and pa.id = a.ref)
      when 'client' then (select display_name from client where id = a.ref)
      when 'project' then (select name from project where id = a.ref)
      when 'group' then (select name from chat_channel where id = a.ref)
      when 'phone' then 'number ending ' || a.value
      else a.value end), '{}')
    from pulse_priv.ai_alias a
   where a.org_id = current_org() and a.prefix || a.n in (select jsonb_array_elements_text(coalesce(j.redaction->'tokens', '[]'))));
end $$;

-- The AI employee's runtime records what its job's prompt replaced (ids used, counts by kind), while the job runs.
create function pulse.chat_group_ai_redaction(p_job uuid, p jsonb) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  update chat_group_ai_job set redaction = p where org_id = current_org() and id = p_job and agent_id = agent_session() and status = 'running';
  if not found then raise exception 'This job is not yours' using errcode = '42501'; end if;
end $$;

-- The claim as WA-NATIVE's 1051 left it (live messages only: imported rows, `import_ref` set, stay out of
-- 'messages'), with who is who (ids, never sent on: the API redacts with them) and the imported history's senders, so
-- that a person, a mapped sender and an unmapped one each keep their own id. Imported text reaches the engine only
-- through 'history', redacted. Bodies come unmasked: the API redacts phone numbers itself (stable ids) before anything
-- reaches an engine.
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
    'askedBy', (select display_name from person where id = j.asked_by), 'askedById', j.asked_by,
    'now', to_char(now() at time zone org_time_zone(), 'FMDay DD Mon YYYY, HH24:MI'),
    'group', (select jsonb_build_object('id', ch.id, 'name', ch.name, 'role', agent_group_role(me, ch.id), 'clientFacing', chat_client_facing(ch.id),
        'client', (select display_name from client where id = g.client_id), 'clientId', g.client_id,
        'project', (select name from project where id = g.project_id), 'projectId', g.project_id,
        'area', g.area, 'pod', g.pod, 'segments', g.segments, 'services', g.services,
        'members', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'side', p.side) order by p.display_name), '[]')
                      from chat_member cm join person p on p.id = cm.person_id where cm.channel_id = ch.id))
      from chat_channel ch left join chat_group_info g on g.channel_id = ch.id where ch.id = j.channel_id),
    'messages', (select coalesce(jsonb_agg(x.j order by x.at), '[]') from (
        select msg.created_at at, jsonb_build_object('at', to_char(msg.created_at at time zone org_time_zone(), 'DD Mon HH24:MI'), 'author', p.display_name,
          'authorId', p.id, 'side', p.side, 'body', left(msg.body, 600), 'files', jsonb_array_length(msg.attachments)) j
          from chat_message msg join person p on p.id = msg.author_id
         where msg.channel_id = j.channel_id and msg.removed_at is null and msg.kind = 'text' and msg.import_ref is null
         order by msg.created_at desc limit 120) x),
    'history', case when p_history then (select coalesce(jsonb_agg(jsonb_build_object('at', h.at, 'author', h.author, 'authorKey', h.k, 'side', h.side,
          'body', left(h.body, 500)) order by h.sent_at), '[]')
        from (select * from (
            select to_char(m.sent_at at time zone org_time_zone(), 'YYYY-MM-DD') at, m.sent_at, coalesce(p.display_name, m.author_label) author,
                   case when m.author_id is not null then 'person:' || m.author_id else 'label:' || m.author_label end k, coalesce(p.side, 'client') side, m.body
              from pulse_priv.chat_import_message m join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
              left join person p on p.id = m.author_id
             where m.org_id = current_org() and m.channel_id = j.channel_id and m.kind = 'text' and chat_history_reader(j.channel_id)
            union all
            select to_char(m.sent_at at time zone org_time_zone(), 'YYYY-MM-DD'), m.sent_at, coalesce(p.display_name, pa.label),
                   case when pa.person_id is not null then 'person:' || pa.person_id when pa.id is not null then 'participant:' || pa.id else 'label:?' end,
                   coalesce(p.side, case pa.kind when 'colleague' then 'staff' else 'client' end), m.body
              from pulse_priv.wa_message m join pulse_priv.wa_chat c on c.org_id = m.org_id and c.id = m.chat_id
              join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
              left join pulse_priv.wa_participant pa on pa.org_id = m.org_id and pa.id = m.participant_id left join person p on p.id = pa.person_id
             where m.org_id = current_org() and c.channel_id = j.channel_id and m.kind = 'text' and wa_reader(c.id)) z
          order by z.sent_at desc limit 150) h) else '[]'::jsonb end,
    'openTasks', (select coalesce(jsonb_agg(jsonb_build_object('title', t.title, 'status', t.status, 'due', t.due_at::date,
         'who', (select display_name from person where id = t.assignee_person_id), 'whoId', t.assignee_person_id)), '[]')
       from (select t.* from task t left join chat_group_info g on g.channel_id = j.channel_id
              where t.org_id = current_org() and t.deleted_at is null and t.status not in ('done', 'accepted', 'cancelled')
                and ((g.project_id is not null and t.project_id = g.project_id)
                     or exists (select 1 from chat_task_follow f where f.task_id = t.id and f.channel_id = j.channel_id))
              order by t.due_at nulls last limit 30) t),
    'maxOut', case j.kind when 'summary' then 1200 when 'extract' then 2000 else 900 end);
end $$;

revoke all on function pulse.ai_redaction_allowed(), pulse.ai_vocab_refresh(boolean), pulse.ai_vocab_lookup(text[]), pulse.ai_redaction_names(uuid),
  pulse.ai_alias_get(jsonb), pulse.ai_alias_resolve(uuid), pulse.chat_group_ai_redaction(uuid, jsonb) from public;
grant execute on function pulse.ai_redaction_allowed(), pulse.ai_vocab_refresh(boolean), pulse.ai_vocab_lookup(text[]), pulse.ai_redaction_names(uuid),
  pulse.ai_alias_get(jsonb), pulse.ai_alias_resolve(uuid), pulse.chat_group_ai_redaction(uuid, jsonb) to pulse_api;

-- migrate:down
-- Forward-only.

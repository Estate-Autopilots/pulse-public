-- migrate:up
-- PM-BUILD-4 (KAZUK-PM-2 phase 3, "the chat moves the board"; Kazuk: "Without them the team will keep working in WhatsApp
-- and update the board on Friday"). A message a person writes in a project's group (a chat linked to the project,
-- chat_group_info.project_id: its client group or pod chat) is read for the step it is about and what happened to it,
-- by rules (no AI, so it is testable): the step's code ("C20") or its words ("model video"); "first draft", "second
-- draft" / "revision", "final" / "delivered" / "done", "started" / "working on". Nothing changes by itself: the writer
-- gets ONE private card (only they see it, under their own message and on My day): "Model video → first draft? Yes /
-- Not this". Their tap moves the step through the same guarded path as the step page (pulse.task_move: only a person
-- marks a plan step done, gates and hold dates refuse with the reason), and Undo puts it back for a day.
--  * Never a clock: a gate or milestone step (Day 0, Ads live, …) is never a card's step; clocks move only through their
--    own functions (project_day0_declare, project_live_record, project_clock_move), by a person.
--  * Never a client: nothing is posted in the group, so nothing reaches a client; a client's, a guest's, an AI
--    employee's or an imported (WhatsApp history) message is never read.
--  * Never a guess: several matching steps make one "Which step?" card; none, a question ("is it done?"), or a
--    not-yet ("not done", "tomorrow", "will") makes no card. A card the writer ignores expires after 3 days.
--  * Back-fill without nagging: a person who marks a step done while their own earlier steps it waits on (the
--    template's "after") are still open gets one card, "Were these finished too?" Yes closes them as done by that person.
--  * A message's reading never blocks the message: any error leaves only the message.
--  * Waiting on the client, counted apart: the lead marks the client inputs they asked for ("We need from you: floor
--    plans, brochure"; Pulse drafts the words, the lead sends them, Pulse sends nothing) and each opens a wait
--    (pulse.task_wait); the step done closes it. The project's health counts a client wait from the day it was asked,
--    never as the team's lateness.
-- New: pulse.step_card (forced row security; a card is its person's alone), pulse.task_wait. Read: pulse.pm_step_cards; answer:
-- pulse.pm_step_card_answer (yes / no / undo). Additive: one table, functions, two triggers.

create table pulse.step_card (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references pulse.person(id),
  project_id uuid not null references pulse.project(id),
  kind text not null check (kind in ('chat', 'backfill')),
  channel_id uuid,
  message_id uuid,
  source_task uuid,
  what text not null check (what in ('round', 'started', 'done')),
  round text check (length(round) between 1 and 40),
  quote text check (length(quote) <= 300),
  candidates jsonb not null check (jsonb_typeof(candidates) = 'array' and jsonb_array_length(candidates) between 1 and 5),
  state text not null default 'open' check (state in ('open', 'yes', 'no', 'undone', 'expired')),
  applied jsonb,
  answered_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index step_card_message on pulse.step_card (org_id, message_id) where message_id is not null;
create unique index step_card_backfill on pulse.step_card (org_id, source_task) where kind = 'backfill';
create index step_card_person on pulse.step_card (org_id, person_id, state, created_at desc);
alter table pulse.step_card enable row level security;
alter table pulse.step_card force row level security;
create policy tenant on pulse.step_card using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- A card quotes its writer's message and offers their own steps: only they see it.
create policy mine on pulse.step_card as restrictive for select to pulse_api using (person_id = pulse.current_viewer());
grant select on pulse.step_card to pulse_api;

-- Every step of a plan's template (the version the plan runs on), read ONCE: its code, type, what it waits on, and
-- whether the client provides it (clientInput, or the template's client role). pulse.plan_step() re-reads the whole
-- template on each call, so lists of steps use this instead.
create function pulse.plan_steps_of(p_project uuid) returns table (code text, typ text, after jsonb, client boolean)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  with d as (select plan_definition(p_project) def),
       cr as (select (select r->>'label' from d, jsonb_array_elements(case when jsonb_typeof(d.def->'roles') = 'array' then d.def->'roles' else '[]'::jsonb end) r
                       where coalesce((r->>'client')::boolean, false) limit 1) label)
  select s->>'id', coalesce(nullif(s->>'type', ''), nullif(s->>'kind', ''), 'task'),
         case when jsonb_typeof(s->'after') = 'array' then s->'after' else '[]'::jsonb end,
         coalesce((s->>'clientInput')::boolean, false) or coalesce(plan_step_role(s) = (select label from cr), false)
    from d, jsonb_array_elements(case when jsonb_typeof(d.def->'steps') = 'array' then d.def->'steps' else '[]'::jsonb end) s
$$;

-- What a message says happened, by rules: {"what": "round"|"started"|"done", "round": "First draft"|"Second draft"}, or
-- null. A draft word wins over "done" ("first draft done" is a round, never final); a question or a not-yet says nothing.
create function pulse.pm_chat_words(p_body text) returns jsonb
  language sql immutable set search_path = pulse, pg_temp as $$
  with b as (select lower(coalesce(p_body, '')) t)
  select case
    when length(t) > 1500 or t ~ '\?' then null
    when t ~ '\m(not|no|yet to|will|would|tomorrow|pending|soon|later|going to|gonna|need to|needs to|has to|have to|should|can you|could you|please)\M|n''t\M' then null
    when t ~ '\m(first|1st)\s+(draft|cut|version)\M' then jsonb_build_object('what', 'round', 'round', 'First draft')
    when t ~ '\m(second|2nd)\s+(draft|cut|version)\M|\mrevision\M|\mrevised\M' then jsonb_build_object('what', 'round', 'round', 'Second draft')
    when t ~ '\m(final|finali[sz]ed|delivered|approved by (the )?client|client approved|completed?|finished|done)\M' then jsonb_build_object('what', 'done')
    when t ~ '\m(started|starting|working on|begun|began|in progress)\M' then jsonb_build_object('what', 'started')
  end from b
$$;

-- The open steps a message can be about, for its writer: a step code in the message ("C20", "c 20") among the project's
-- open plan steps, else the writer's own open steps whose distinctive title words (4+ letters, not the round or done
-- words) all appear in it. Gates and milestones are never candidates (they move clocks); nor are steps of another person
-- unless the writer runs the project and named the code. At most 5.
create function pulse.pm_chat_candidates(p_project uuid, p_writer uuid, p_body text) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare codes text[]; words text[]; runs boolean := false; out jsonb;
begin
  select array_agg(distinct upper(replace(m[1], ' ', ''))) into codes from regexp_matches(coalesce(p_body, ''), '\m([A-Za-z]{1,2} ?[0-9]{1,3})\M', 'g') m;
  select array_agg(distinct w) into words from regexp_split_to_table(lower(coalesce(p_body, '')), '[^a-z0-9]+') w where length(w) >= 3;
  if codes is not null then
    select exists (select 1 from project p where p.org_id = current_org() and p.id = p_project
                     and (p.lead_person_id = p_writer or exists (select 1 from work_project wp where wp.project_id = p.id and wp.owner_id = p_writer and wp.deleted_at is null))) into runs;
  end if;
  with ps as materialized (select * from plan_steps_of(p_project)),
  open_steps as (
    select t.id, t.template_step code, t.title, t.status, coalesce(t.assignee_person_id, t.owner_id) who
      from task t join ps on ps.code = t.template_step
     where t.org_id = current_org() and t.project_id = p_project and t.deleted_at is null and t.parent_id is null and t.template_step is not null
       and t.status in ('open', 'in_progress', 'blocked', 'in_review') and ps.typ not in ('gate', 'milestone', 'auto')),
  by_code as (
    select s.* from open_steps s where codes is not null and upper(s.code) = any(codes) and (s.who = p_writer or runs)),
  by_words as (
    select s.* from open_steps s
     where not exists (select 1 from by_code) and words is not null and s.who = p_writer
       and (select count(*) from regexp_split_to_table(lower(regexp_replace(s.title, '^\s*' || s.code || '\s+', '', 'i')), '[^a-z0-9]+') x
             where length(x) >= 4 and x not in ('draft', 'drafted', 'drafts', 'final', 'finalised', 'finalized', 'ready', 'done', 'review', 'reviewed', 'client', 'clients', 'with', 'from', 'into', 'that', 'this', 'sent', 'send', 'shared', 'share', 'step', 'first', 'second', 'made', 'make', 'complete', 'completed', 'delivered', 'approved', 'approval', 'confirmed')) > 0
       and not exists (select 1 from regexp_split_to_table(lower(regexp_replace(s.title, '^\s*' || s.code || '\s+', '', 'i')), '[^a-z0-9]+') x
             where length(x) >= 4 and x not in ('draft', 'drafted', 'drafts', 'final', 'finalised', 'finalized', 'ready', 'done', 'review', 'reviewed', 'client', 'clients', 'with', 'from', 'into', 'that', 'this', 'sent', 'send', 'shared', 'share', 'step', 'first', 'second', 'made', 'make', 'complete', 'completed', 'delivered', 'approved', 'approval', 'confirmed')
               and not (x = any(words) or rtrim(x, 's') = any(words) or x || 's' = any(words)))),
  picked as (select * from by_code union all select * from by_words)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', code, 'title', left(regexp_replace(title, '^\s*' || code || '\s+', '', 'i'), 120), 'status', status) order by code), '[]'::jsonb)
    into out from (select * from picked order by code limit 5) x;
  return out;
end $$;

-- The reader: after a message is written in Pulse (never an imported one), in a group linked to a planned project, by a
-- person of the company who is not an AI employee. One card per message at most.
create function pulse.pm_chat_read() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare proj uuid; said jsonb; cands jsonb;
begin
  begin
    select gi.project_id into proj from chat_group_info gi where gi.org_id = new.org_id and gi.channel_id = new.channel_id;
    if proj is null or not exists (select 1 from project_plan pl where pl.org_id = new.org_id and pl.project_id = proj) then return null; end if;
    if agent_session() is not null or task_auto_source() is not null then return null; end if;
    if not exists (select 1 from person p where p.id = new.author_id and p.org_id = new.org_id and p.side in ('staff', 'freelancer') and p.status = 'active'
                     and not exists (select 1 from agent_member am where am.person_id = p.id)) then return null; end if;
    said := pm_chat_words(new.body);
    if said is null then return null; end if;
    cands := pm_chat_candidates(proj, new.author_id, new.body);
    if jsonb_array_length(cands) = 0 then return null; end if;
    -- A round or a start on a step already further on says nothing new.
    if said->>'what' = 'started' then
      select coalesce(jsonb_agg(c), '[]'::jsonb) into cands from jsonb_array_elements(cands) c where c->>'status' in ('open', 'blocked');
      if jsonb_array_length(cands) = 0 then return null; end if;
    end if;
    insert into step_card (org_id, person_id, project_id, kind, channel_id, message_id, what, round, quote, candidates)
      values (new.org_id, new.author_id, proj, 'chat', new.channel_id, new.id, said->>'what', said->>'round', left(btrim(new.body), 300), cands)
      on conflict do nothing;
  exception when others then
    raise warning 'pm_chat_read skipped a message: %', sqlerrm;
  end;
  return null;
end $$;
create trigger pm_chat_read after insert on pulse.chat_message for each row
  when (new.import_ref is null and new.removed_at is null and new.kind = 'text' and new.guest_id is null)
  execute function pulse.pm_chat_read();

-- Back-fill: a person marks a step done while their own earlier steps it waits on (the template's "after", two levels)
-- are still open: one card, "Were these finished too?".
create function pulse.pm_step_backfill() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); st jsonb; befores text[]; cands jsonb;
begin
  begin
    if me is null or not plan_by_person() or coalesce(new.assignee_person_id, new.owner_id) is distinct from me then return null; end if;
    st := plan_step(new.project_id, new.template_step);
    if st is null or jsonb_typeof(st->'after') <> 'array' then return null; end if;
    select array_agg(distinct a) into befores from (
      select jsonb_array_elements_text(st->'after') a
      union select jsonb_array_elements_text(case when jsonb_typeof(plan_step(new.project_id, x)->'after') = 'array' then plan_step(new.project_id, x)->'after' else '[]'::jsonb end)
        from jsonb_array_elements_text(st->'after') x) y;
    if befores is null then return null; end if;
    select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'code', t.template_step, 'title', left(regexp_replace(t.title, '^\s*' || t.template_step || '\s+', '', 'i'), 120), 'status', t.status) order by t.template_step), '[]'::jsonb)
      into cands from (select * from task t where t.org_id = new.org_id and t.project_id = new.project_id and t.deleted_at is null and t.parent_id is null
                          and t.template_step = any(befores) and t.status in ('open', 'in_progress', 'blocked')
                          and coalesce(t.assignee_person_id, t.owner_id) = me
                          and coalesce(plan_step_type(plan_step(t.project_id, t.template_step)), 'task') not in ('gate', 'milestone', 'auto', 'ongoing', 'repeating')
                          -- One card per step at a time: a step already asked about (an open card of this person) is left out.
                          and not exists (select 1 from step_card s where s.org_id = new.org_id and s.person_id = me and s.state = 'open'
                                            and s.candidates @> jsonb_build_array(jsonb_build_object('id', t.id)))
                        order by t.template_step limit 5) t;
    if jsonb_array_length(cands) = 0 then return null; end if;
    insert into step_card (org_id, person_id, project_id, kind, source_task, what, quote, candidates)
      values (new.org_id, me, new.project_id, 'backfill', new.id, 'done', left(regexp_replace(new.title, '^\s*' || new.template_step || '\s+', '', 'i'), 300), cands)
      on conflict do nothing;
  exception when others then
    raise warning 'pm_step_backfill skipped: %', sqlerrm;
  end;
  return null;
end $$;
create trigger pm_step_backfill after update of status on pulse.task for each row
  when (new.status = 'done' and old.status is distinct from 'done' and new.template_step is not null and new.project_id is not null and new.deleted_at is null)
  execute function pulse.pm_step_backfill();

-- The viewer's cards: open ones (3 days at most), and the ones they said yes to in the last day (for Undo). Optionally
-- for one chat or one project.
create function pulse.pm_step_cards(p_channel uuid, p_project uuid) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'what', c.what, 'round', c.round, 'quote', c.quote, 'candidates', c.candidates,
      'state', c.state, 'applied', c.applied, 'channelId', c.channel_id, 'messageId', c.message_id, 'projectId', c.project_id,
      'project', (select coalesce(p.title, p.name) from project p where p.id = c.project_id), 'createdAt', c.created_at, 'answeredAt', c.answered_at) order by c.created_at desc), '[]'::jsonb)
    from (select * from step_card c
           where c.org_id = current_org() and c.person_id = current_viewer()
             and (p_channel is null or c.channel_id = p_channel) and (p_project is null or c.project_id = p_project)
             and ((c.state = 'open' and c.created_at > now() - interval '3 days') or (c.state = 'yes' and c.answered_at > now() - interval '1 day'))
           order by c.created_at desc limit 30) c
$$;

-- Answer a card: 'yes' (with the step, when the card offers several; a back-fill card closes every step it lists),
-- 'no', or 'undo' (a yes of the last day: each step goes back to where it was, when nobody moved it since). Only the
-- card's person, and only a person (never an AI employee or a connected AI app).
create function pulse.pm_step_card_answer(p_card uuid, p_answer text, p_task uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); c step_card; ids uuid[]; t task; done jsonb := '[]'::jsonb; x jsonb; note text;
begin
  if not plan_by_person() then raise exception 'Only a person answers a step card' using errcode = '42501'; end if;
  select * into c from step_card where org_id = current_org() and id = p_card and person_id = me for update;
  if c.id is null then raise exception 'Card not found' using errcode = 'P0002'; end if;
  if p_answer = 'no' then
    if c.state <> 'open' then raise exception 'This card is already answered' using errcode = '22023'; end if;
    update step_card set state = 'no', answered_at = now() where id = c.id;
    return jsonb_build_object('id', c.id, 'state', 'no');
  elsif p_answer = 'undo' then
    if c.state <> 'yes' or c.answered_at < now() - interval '1 day' then raise exception 'Undo works for a day after you said yes' using errcode = '22023'; end if;
    for x in select * from jsonb_array_elements(coalesce(c.applied->'tasks', '[]'::jsonb)) loop
      select * into t from task where id = (x->>'id')::uuid and deleted_at is null;
      if t.id is not null and t.status = x->>'to' and x->>'from' is distinct from x->>'to' then
        -- task_move takes To do, Doing or Blocked back; a step that was in review goes back to Doing.
        perform task_move(t.id, case when x->>'from' in ('open', 'in_progress', 'blocked') then x->>'from' else 'in_progress' end, 'Undone: it was not what the chat said');
      end if;
    end loop;
    update step_card set state = 'undone', answered_at = now() where id = c.id;
    return jsonb_build_object('id', c.id, 'state', 'undone');
  elsif p_answer <> 'yes' then
    raise exception 'Answer yes, no or undo' using errcode = '22023';
  end if;
  if c.state <> 'open' then raise exception 'This card is already answered' using errcode = '22023'; end if;
  if c.kind = 'backfill' then
    select array_agg((e->>'id')::uuid) into ids from jsonb_array_elements(c.candidates) e;
  elsif p_task is not null then
    if not exists (select 1 from jsonb_array_elements(c.candidates) e where (e->>'id')::uuid = p_task) then raise exception 'Choose one of the card''s steps' using errcode = '22023'; end if;
    ids := array[p_task];
  elsif jsonb_array_length(c.candidates) = 1 then
    ids := array[(c.candidates->0->>'id')::uuid];
  else
    raise exception 'Choose which step it is' using errcode = '22023';
  end if;
  note := case when c.kind = 'backfill' then 'Finished too (back-fill)' else left(format('From the chat: “%s”', c.quote), 600) end;
  foreach p_task in array ids loop
    select * into t from task where org_id = current_org() and id = p_task and deleted_at is null;
    if t.id is null then continue; end if;
    if c.what = 'done' then
      if t.status not in ('done', 'accepted') then perform task_move(t.id, 'done', note); end if;
    elsif c.what = 'started' then
      if t.status in ('open', 'blocked') then perform task_move(t.id, 'in_progress', note); end if;
    else
      if t.status in ('open', 'blocked') then perform task_move(t.id, 'in_progress', note); end if;
      perform task_event_add(t.id, 'step', null, c.round, note);
    end if;
    done := done || jsonb_build_object('id', t.id, 'from', t.status, 'to', (select status from task where id = t.id), 'round', c.round);
  end loop;
  update step_card set state = 'yes', answered_at = now(), applied = jsonb_build_object('tasks', done) where id = c.id;
  return jsonb_build_object('id', c.id, 'state', 'yes', 'tasks', done);
end $$;

-- The newest draft round each plan step reached (from its "step" events), for the step lists.
create function pulse.pm_step_rounds(p_project uuid) returns table (task_id uuid, round text, at timestamptz)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select distinct on (e.task_id) e.task_id, e.to_value, e.at from task_event e join task t on t.id = e.task_id
   where t.org_id = current_org() and t.project_id = p_project and t.deleted_at is null and e.kind = 'step' and e.to_value in ('First draft', 'Second draft')
   order by e.task_id, e.at desc
$$;

-- Waiting on the client (KAZUK-PM-2 §3.3): one open wait per step at a time; who asked and when, closed when the step
-- is done (or by the lead). Party 'us' is kept for the reverse case (the client waits on us), unused for now.
create table pulse.task_wait (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references pulse.task(id),
  project_id uuid not null references pulse.project(id),
  party text not null default 'client' check (party in ('client', 'us')),
  since timestamptz not null default now(),
  until timestamptz,
  note text check (length(note) <= 600),
  opened_by uuid references pulse.person(id),
  closed_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  check (until is null or until >= since)
);
create unique index task_wait_open on pulse.task_wait (org_id, task_id) where until is null;
create index task_wait_project on pulse.task_wait (org_id, project_id, since desc);
alter table pulse.task_wait enable row level security;
alter table pulse.task_wait force row level security;
create policy tenant on pulse.task_wait using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.task_wait to pulse_api;

-- A plan step the client provides: the template says so (clientInput), or its owner is the template's client role.
create function pulse.plan_step_is_client(p_project uuid, p_code text) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select client from plan_steps_of(p_project) where code = p_code limit 1
$$;

-- The lead marks client inputs as asked: each open client step of the project gets an open wait from now. Only a
-- person who runs the project. Pulse sends nothing: the lead sends the request (the API drafts its words).
create function pulse.project_client_ask(p_project uuid, p_tasks uuid[], p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); t task; n int := 0;
begin
  if not plan_by_person() then raise exception 'Only a person asks the client' using errcode = '42501'; end if;
  if not project_can_run(p_project) then raise exception 'Only the project''s lead, its manager and leadership ask the client' using errcode = '42501'; end if;
  for t in select * from task where org_id = current_org() and project_id = p_project and id = any(coalesce(p_tasks, '{}')) and deleted_at is null
             and template_step is not null and status in ('open', 'in_progress', 'blocked') loop
    if not coalesce(plan_step_is_client(p_project, t.template_step), false) then continue; end if;
    insert into task_wait (org_id, task_id, project_id, party, note, opened_by) values (current_org(), t.id, p_project, 'client', nullif(left(btrim(coalesce(p_note, '')), 600), ''), me)
      on conflict do nothing;
    if found then n := n + 1; perform task_event_add(t.id, 'step', null, 'Asked the client', nullif(left(btrim(coalesce(p_note, '')), 600), '')); end if;
  end loop;
  return jsonb_build_object('asked', n);
end $$;

-- A step done (or closed) ends its wait.
create function pulse.task_wait_close() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  update task_wait set until = greatest(now(), since), closed_by = current_viewer() where org_id = new.org_id and task_id = new.id and until is null;
  return null;
end $$;
create trigger task_wait_close after update of status on pulse.task for each row
  when (new.status in ('done', 'accepted', 'cancelled') and old.status is distinct from new.status)
  execute function pulse.task_wait_close();

revoke all on function pulse.plan_steps_of(uuid), pulse.pm_chat_words(text), pulse.pm_chat_candidates(uuid, uuid, text), pulse.pm_chat_read(), pulse.pm_step_backfill(),
  pulse.pm_step_cards(uuid, uuid), pulse.pm_step_card_answer(uuid, text, uuid), pulse.pm_step_rounds(uuid),
  pulse.plan_step_is_client(uuid, text), pulse.project_client_ask(uuid, uuid[], text), pulse.task_wait_close() from public;
grant execute on function pulse.plan_steps_of(uuid), pulse.pm_chat_words(text), pulse.pm_step_cards(uuid, uuid), pulse.pm_step_card_answer(uuid, text, uuid), pulse.pm_step_rounds(uuid),
  pulse.plan_step_is_client(uuid, text), pulse.project_client_ask(uuid, uuid[], text) to pulse_api;

-- migrate:down
drop trigger if exists task_wait_close on pulse.task;
drop function if exists pulse.task_wait_close();
drop function if exists pulse.project_client_ask(uuid, uuid[], text);
drop function if exists pulse.plan_step_is_client(uuid, text);
drop table if exists pulse.task_wait;
drop trigger if exists pm_step_backfill on pulse.task;
drop trigger if exists pm_chat_read on pulse.chat_message;
drop function if exists pulse.pm_step_rounds(uuid);
drop function if exists pulse.pm_step_card_answer(uuid, text, uuid);
drop function if exists pulse.pm_step_cards(uuid, uuid);
drop function if exists pulse.pm_step_backfill();
drop function if exists pulse.pm_chat_read();
drop function if exists pulse.pm_chat_candidates(uuid, uuid, text);
drop function if exists pulse.pm_chat_words(text);
drop function if exists pulse.plan_steps_of(uuid);
drop table if exists pulse.step_card;

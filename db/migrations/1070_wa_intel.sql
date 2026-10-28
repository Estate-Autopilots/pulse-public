-- migrate:up
-- WA-INTEL (owner, 25 Oct 2026: "tasks and projects and performance from each single chat; mistakes, good and worst
-- decisions, better workflows and SOPs, performance of each person; contacts and every type of data"): the work the
-- imported WhatsApp groups record, as facts Pulse's pages read. Extracted per group from redacted text (people as
-- ids, no names, phones, e-mails or addresses left; the company's dataset v3), checked against the chat's own messages
-- and loaded per company by tools/wa-intel.py:
--  * wa_work_item: every task, request, deliverable, promise and approval asked in a chat: who asked, who owned it,
--    the date promised, done or not and when, follow-ups needed. Open ones are suggested tasks for a leader's review:
--    accepting makes a Pulse task for the person the leader picks (never assigned by itself).
--  * wa_milestone: a project's real timeline from its chat (brief, shoot, creatives, approval, live, payments …),
--    with delays and their cause.
--  * wa_learning: decisions judged by what happened after them (good / bad / neutral), mistakes and incidents with root
--    cause and prevention, practices that helped or hurt, and the best and worst runs as case studies.
--  * wa_finance_event: budgets, top-ups, payments, invoices, quotations and money owed or promised, per client.
--  * wa_person_perf: per colleague (and client contact) what the chats show: volume, answer times, ownership, promises
--    kept, quality signals, client sentiment, after-hours load, strengths and coaching points, with confidence.
--  * wa_intel_summary: the company's aggregate (workflows per service, leadership summary).
-- Who reads: leadership and admins; a colleague also reads their own performance. No runtime role has a grant; reads
-- and the review action go through security-definer functions granted to the API. Additive: new tables and functions.

create table pulse_priv.wa_work_item (
 org_id uuid not null,
 id uuid primary key default gen_random_uuid(),
 source_key text not null check (length(source_key) between 1 and 80),
 chat_id uuid not null,
 message_id uuid,
 done_message_id uuid,
 client_id uuid references pulse.client(id),
 project_id uuid references pulse.project(id),
 kind text not null check (kind in ('task', 'request', 'deliverable', 'promise', 'approval_request', 'material_request', 'change_request', 'follow_up')),
 title text not null check (length(title) between 1 and 300),
 detail text check (length(detail) <= 2000),
 topic text check (length(topic) <= 20),
 asked_by uuid references pulse.person(id),
 asked_side text check (asked_side in ('team', 'client', 'unknown')),
 owner_id uuid references pulse.person(id),
 owner_side text check (owner_side in ('team', 'client', 'unknown')),
 done_by uuid references pulse.person(id),
 asked_at timestamptz not null,
 due_on date,
 status text not null check (status in ('done', 'open', 'dropped', 'unclear')),
 done_at timestamptz,
 hours_to_done real,
 working_hours_to_done real,
 follow_ups int not null default 0 check (follow_ups >= 0),
 late boolean,
 confidence real,
 stale boolean not null default false,          -- still open but its chat went quiet long ago
 review_state text not null default 'suggested' check (review_state in ('suggested', 'accepted', 'dismissed', 'history')),
 task_id uuid,
 reviewed_by uuid references pulse.person(id),
 reviewed_at timestamptz,
 unique (org_id, source_key),
 foreign key (org_id, chat_id) references pulse_priv.wa_chat (org_id, id)
);
create index wa_work_item_review on pulse_priv.wa_work_item (org_id, review_state, asked_at desc);
create index wa_work_item_owner on pulse_priv.wa_work_item (org_id, owner_id);
create index wa_work_item_client on pulse_priv.wa_work_item (org_id, client_id);

create table pulse_priv.wa_milestone (
 org_id uuid not null,
 id uuid primary key default gen_random_uuid(),
 source_key text not null check (length(source_key) between 1 and 80),
 chat_id uuid not null,
 message_id uuid,
 client_id uuid references pulse.client(id),
 project_id uuid references pulse.project(id),
 kind text not null check (length(kind) between 1 and 30),
 at timestamptz not null,
 owner_id uuid references pulse.person(id),
 delayed boolean not null default false,
 delay_cause text check (length(delay_cause) <= 30),
 note text check (length(note) <= 600),
 unique (org_id, source_key),
 foreign key (org_id, chat_id) references pulse_priv.wa_chat (org_id, id)
);
create index wa_milestone_project on pulse_priv.wa_milestone (org_id, project_id, at);

create table pulse_priv.wa_learning (
 org_id uuid not null,
 id uuid primary key default gen_random_uuid(),
 source_key text not null check (length(source_key) between 1 and 80),
 kind text not null check (kind in ('decision', 'incident', 'practice', 'case_study')),
 chat_id uuid,
 client_id uuid references pulse.client(id),
 project_id uuid references pulse.project(id),
 category text check (length(category) <= 40),
 verdict text check (verdict in ('good', 'bad', 'neutral', 'unclear', 'low', 'medium', 'high', 'best', 'worst')),
 title text not null check (length(title) between 1 and 600),
 detail text check (length(detail) <= 4000),
 root_cause text check (length(root_cause) <= 1000),
 prevention text check (length(prevention) <= 1000),
 outcome text check (length(outcome) <= 1000),
 by_id uuid references pulse.person(id),
 by_side text check (by_side in ('team', 'client', 'process', 'external', 'unclear')),
 at timestamptz,
 evidence uuid[] not null default '{}',
 data jsonb not null default '{}' check (jsonb_typeof(data) = 'object'),
 unique (org_id, source_key)
);
create index wa_learning_kind on pulse_priv.wa_learning (org_id, kind, verdict);

create table pulse_priv.wa_finance_event (
 org_id uuid not null,
 id uuid primary key default gen_random_uuid(),
 source_key text not null check (length(source_key) between 1 and 80),
 chat_id uuid not null,
 message_id uuid,
 client_id uuid references pulse.client(id),
 project_id uuid references pulse.project(id),
 kind text not null check (kind in ('budget_set', 'budget_change', 'topup_request', 'topup_done', 'payment_request', 'payment_made', 'payment_promised', 'invoice', 'quotation', 'price_quote', 'refund', 'dispute', 'money_owed', 'other')),
 amount_inr numeric(16, 2),
 period text check (period in ('per_day', 'per_week', 'per_month', 'one_time', 'per_unit')),
 at timestamptz not null,
 by_side text check (by_side in ('team', 'client', 'unknown')),
 status text check (status in ('done', 'pending', 'unclear')),
 note text check (length(note) <= 600),
 unique (org_id, source_key),
 foreign key (org_id, chat_id) references pulse_priv.wa_chat (org_id, id)
);
create index wa_finance_event_client on pulse_priv.wa_finance_event (org_id, client_id, at);

create table pulse_priv.wa_person_perf (
 org_id uuid not null,
 person_id uuid not null references pulse.person(id),
 side text not null check (side in ('team', 'client')),
 metrics jsonb not null check (jsonb_typeof(metrics) = 'object'),
 as_of timestamptz not null default now(),
 primary key (org_id, person_id)
);

create table pulse_priv.wa_intel_summary (
 org_id uuid primary key,
 data jsonb not null check (jsonb_typeof(data) = 'object'),
 as_of timestamptz not null default now()
);

do $$ declare t text; begin
 foreach t in array array['pulse_priv.wa_work_item', 'pulse_priv.wa_milestone', 'pulse_priv.wa_learning', 'pulse_priv.wa_finance_event',
   'pulse_priv.wa_person_perf', 'pulse_priv.wa_intel_summary'] loop
  execute format('alter table %s enable row level security', t);
  execute format('alter table %s force row level security', t);
  execute format('create policy tenant on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  execute format('revoke all on %s from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy', t);
 end loop;
end $$;

-- A message of an imported chat as a link target: the chat and the message (the web opens it in the native chat).
create function pulse.wa_intel_ref(p_chat uuid, p_message uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object('chatId', w.id, 'chat', w.title, 'messageId', p_message, 'at', (select m.sent_at from pulse_priv.wa_message m where m.org_id = w.org_id and m.id = p_message))
 from pulse_priv.wa_chat w where w.org_id = current_org() and w.id = p_chat
$$;

-- Insights → Work from the chats: the company summary, decisions, mistakes, practices, case studies, the team and the
-- suggested tasks. Leadership and admins. p: {part, kind, verdict, category, client, person, state, limit}.
create function pulse.wa_intel(p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select case when not viewer_is('admin', 'leadership') then null
  when coalesce(p->>'part', 'summary') = 'summary' then jsonb_build_object(
   'summary', (select s.data from pulse_priv.wa_intel_summary s where s.org_id = current_org()),
   'asOf', (select s.as_of from pulse_priv.wa_intel_summary s where s.org_id = current_org()),
   'sops', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'status', x.status) order by x.title) from sop x
     where x.org_id = current_org() and 'whatsapp_intel' = any(x.tags) and x.status <> 'archived'), '[]'::jsonb),
   'counts', jsonb_build_object(
     'work', (select count(*) from pulse_priv.wa_work_item where org_id = current_org()),
     'suggested', (select count(*) from pulse_priv.wa_work_item where org_id = current_org() and review_state = 'suggested'),
     'decisions', (select count(*) from pulse_priv.wa_learning where org_id = current_org() and kind = 'decision'),
     'incidents', (select count(*) from pulse_priv.wa_learning where org_id = current_org() and kind = 'incident'),
     'practices', (select count(*) from pulse_priv.wa_learning where org_id = current_org() and kind = 'practice'),
     'cases', (select count(*) from pulse_priv.wa_learning where org_id = current_org() and kind = 'case_study'),
     'finance', (select count(*) from pulse_priv.wa_finance_event where org_id = current_org())))
  when p->>'part' = 'learning' then coalesce((select jsonb_agg(x.j order by x.rank, x.at desc nulls last) from (
   select l.at, case l.verdict when 'worst' then 0 when 'bad' then 0 when 'high' then 0 when 'best' then 1 when 'good' then 1 when 'medium' then 2 else 3 end rank,
    jsonb_build_object('id', l.id, 'kind', l.kind, 'category', l.category, 'verdict', l.verdict, 'title', l.title, 'detail', l.detail,
     'rootCause', l.root_cause, 'prevention', l.prevention, 'outcome', l.outcome, 'at', l.at, 'by', b.display_name, 'byId', l.by_id, 'bySide', l.by_side,
     'clientId', l.client_id, 'client', cl.display_name, 'projectId', l.project_id, 'chatId', l.chat_id, 'chat', w.title, 'evidence', l.evidence, 'data', l.data) j
   from pulse_priv.wa_learning l left join person b on b.id = l.by_id left join client cl on cl.id = l.client_id
   left join pulse_priv.wa_chat w on w.org_id = l.org_id and w.id = l.chat_id
   where l.org_id = current_org() and (p->>'kind' is null or l.kind = p->>'kind') and (p->>'verdict' is null or l.verdict = p->>'verdict')
    and (p->>'category' is null or l.category = p->>'category') and (p->>'client' is null or l.client_id = (p->>'client')::uuid)
    and (p->>'person' is null or l.by_id = (p->>'person')::uuid)
   order by 2, l.at desc nulls last limit greatest(1, least(coalesce((p->>'limit')::int, 200), 1000))) x), '[]'::jsonb)
  when p->>'part' = 'work' then coalesce((select jsonb_agg(x.j order by x.stale, x.asked_at desc) from (
   select i.stale, i.asked_at, jsonb_build_object('id', i.id, 'kind', i.kind, 'title', i.title, 'detail', i.detail, 'topic', i.topic, 'status', i.status,
     'askedAt', i.asked_at, 'dueOn', i.due_on, 'doneAt', i.done_at, 'followUps', i.follow_ups, 'late', i.late, 'stale', i.stale, 'confidence', i.confidence,
     'reviewState', i.review_state, 'taskId', i.task_id, 'askedBy', ab.display_name, 'askedSide', i.asked_side, 'ownerId', i.owner_id, 'owner', ow.display_name,
     'ownerSide', i.owner_side, 'clientId', i.client_id, 'client', cl.display_name, 'projectId', i.project_id, 'chatId', i.chat_id, 'chat', w.title, 'messageId', i.message_id) j
   from pulse_priv.wa_work_item i left join person ab on ab.id = i.asked_by left join person ow on ow.id = i.owner_id left join client cl on cl.id = i.client_id
   join pulse_priv.wa_chat w on w.org_id = i.org_id and w.id = i.chat_id
   where i.org_id = current_org() and i.review_state = coalesce(p->>'state', 'suggested')
    and (p->>'client' is null or i.client_id = (p->>'client')::uuid) and (p->>'person' is null or i.owner_id = (p->>'person')::uuid)
    and (p->>'stale' is null or i.stale = (p->>'stale')::boolean)
   order by i.stale, i.asked_at desc limit greatest(1, least(coalesce((p->>'limit')::int, 200), 1000))) x), '[]'::jsonb)
  when p->>'part' = 'team' then coalesce((select jsonb_agg(jsonb_build_object('personId', f.person_id, 'name', pe.display_name, 'side', f.side, 'metrics', f.metrics)
     order by (f.metrics->>'messages')::int desc nulls last)
   from pulse_priv.wa_person_perf f join person pe on pe.id = f.person_id where f.org_id = current_org() and f.side = coalesce(p->>'side', 'team')), '[]'::jsonb)
  end
$$;

-- What the chats show about one person: leadership and admins, and the person themself.
create function pulse.wa_person_perf_read(p_person uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select case when viewer_is('admin', 'leadership') or p_person = current_viewer() then
  (select jsonb_build_object('personId', f.person_id, 'side', f.side, 'metrics', f.metrics, 'asOf', f.as_of, 'self', p_person = current_viewer(),
    'work', (select jsonb_build_object('owned', count(*), 'done', count(*) filter (where i.status = 'done'), 'open', count(*) filter (where i.status = 'open'),
                'late', count(*) filter (where i.late), 'promises', count(*) filter (where i.kind = 'promise'),
                'promisesKept', count(*) filter (where i.kind = 'promise' and i.status = 'done' and not coalesce(i.late, false)))
             from pulse_priv.wa_work_item i where i.org_id = current_org() and i.owner_id = p_person),
    'recent', coalesce((select jsonb_agg(x.j order by x.at desc) from (
       select l.at, jsonb_build_object('kind', l.kind, 'verdict', l.verdict, 'title', l.title, 'at', l.at, 'chatId', l.chat_id, 'evidence', l.evidence) j
       from pulse_priv.wa_learning l where l.org_id = current_org() and l.by_id = p_person and l.kind in ('decision', 'incident')
       order by l.at desc nulls last limit 12) x), '[]'::jsonb))
   from pulse_priv.wa_person_perf f where f.org_id = current_org() and f.person_id = p_person) end
$$;

-- A client's money from the chats, oldest first: budgets, top-ups, payments, invoices, quotations, money owed.
create function pulse.wa_client_finance(p_client uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select case when viewer_is('admin', 'leadership') then jsonb_build_object(
  'events', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'amount', f.amount_inr, 'period', f.period, 'at', f.at, 'bySide', f.by_side,
      'status', f.status, 'note', f.note, 'projectId', f.project_id, 'chatId', f.chat_id, 'chat', w.title, 'messageId', f.message_id) order by f.at)
    from pulse_priv.wa_finance_event f join pulse_priv.wa_chat w on w.org_id = f.org_id and w.id = f.chat_id
    where f.org_id = current_org() and f.client_id = p_client), '[]'::jsonb),
  'milestones', coalesce((select jsonb_agg(jsonb_build_object('kind', m.kind, 'at', m.at, 'delayed', m.delayed, 'delayCause', m.delay_cause, 'note', m.note,
      'projectId', m.project_id, 'chatId', m.chat_id, 'messageId', m.message_id, 'owner', o.display_name) order by m.at)
    from pulse_priv.wa_milestone m left join person o on o.id = m.owner_id where m.org_id = current_org() and m.client_id = p_client), '[]'::jsonb),
  'open', (select count(*) from pulse_priv.wa_work_item i where i.org_id = current_org() and i.client_id = p_client and i.review_state = 'suggested')) end
$$;

-- A suggested task decided by a leader: 'accept' makes a Pulse task for the person the leader names (p.assigneeId,
-- required: nothing is assigned by itself), due p.dueOn; 'dismiss' sets it aside; 'restore' puts it back.
create function pulse.wa_work_decide(p_id uuid, p_action text, p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare i pulse_priv.wa_work_item; t uuid; notes text;
begin
 if not viewer_is('admin', 'leadership') then raise exception 'Suggested tasks are reviewed by leadership and admins' using errcode = '42501'; end if;
 select * into i from pulse_priv.wa_work_item where org_id = current_org() and id = p_id for update;
 if i.id is null then raise exception 'That suggestion is gone' using errcode = 'P0002'; end if;
 if p_action = 'accept' then
  if i.review_state = 'accepted' then return jsonb_build_object('ok', true, 'taskId', i.task_id); end if;
  if coalesce(p->>'assigneeId', '') = '' then raise exception 'Choose who does it' using errcode = '22023'; end if;
  notes := concat_ws(E'\n\n', nullif(i.detail, ''), 'From the WhatsApp group "' || (select w.title from pulse_priv.wa_chat w where w.org_id = i.org_id and w.id = i.chat_id) || '", asked '
    || to_char(i.asked_at, 'DD Mon YYYY') || case when i.follow_ups > 0 then ', followed up ' || i.follow_ups || ' times' else '' end || '.');
  t := task_save(null, jsonb_build_object('title', left(i.title, 200), 'notes', notes, 'assigneeId', p->>'assigneeId',
        'dueOn', coalesce(p->>'dueOn', to_char(greatest(current_date + 2, coalesce(i.due_on, current_date + 2)), 'YYYY-MM-DD'))));
  update pulse_priv.wa_work_item set review_state = 'accepted', task_id = t, reviewed_by = current_viewer(), reviewed_at = now() where org_id = current_org() and id = p_id;
  return jsonb_build_object('ok', true, 'taskId', t);
 elsif p_action = 'dismiss' then
  update pulse_priv.wa_work_item set review_state = 'dismissed', reviewed_by = current_viewer(), reviewed_at = now() where org_id = current_org() and id = p_id and review_state = 'suggested';
  return jsonb_build_object('ok', true);
 elsif p_action = 'restore' then
  update pulse_priv.wa_work_item set review_state = 'suggested', reviewed_by = null, reviewed_at = null where org_id = current_org() and id = p_id and review_state = 'dismissed';
  return jsonb_build_object('ok', true);
 end if;
 raise exception 'Accept, dismiss or restore' using errcode = '22023';
end $$;

-- Review data: contact details the chats show (a contact's role and e-mail, the client they belong to, a client's
-- website) as suggestions of kind 'wa_contact'. The kind is added to the check as it stands now, so kinds other
-- migrations added stay.
do $$ declare def text; kinds text[]; begin
 select pg_get_constraintdef(oid) into def from pg_constraint where conrelid = 'pulse.review_item'::regclass and conname = 'review_item_kind_check';
 select array_agg(distinct k) into kinds from (
   select unnest(string_to_array(m[1], ',')) k from regexp_matches(coalesce(def, ''), '''\{([a-z_,]+)\}''', 'g') m
   union select m[1] from regexp_matches(coalesce(def, ''), '''([a-z_]+)''::text', 'g') m) x where k <> '';
 if coalesce(array_length(kinds, 1), 0) < 5 then raise exception 'review_item kinds not read (%), refusing to narrow the check', def; end if;
 if not ('wa_contact' = any(coalesce(kinds, '{}'))) then
  alter table pulse.review_item drop constraint if exists review_item_kind_check;
  execute format('alter table pulse.review_item add constraint review_item_kind_check check (kind = any (%L::text[]))', array_append(coalesce(kinds, '{}'), 'wa_contact'));
 end if;
end $$;

-- Accepting a 'wa_contact' suggestion: fills what is still empty (never overwrites a value someone set or locked) and
-- keeps the change log. proposed: {designation, email, contactType, clientId} for a contact, {website} for a client.
create function pulse.wa_contact_apply(p_item uuid) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r review_item; pr jsonb; n int := 0; k int; cp contact_profile; cl client;
begin
 if not viewer_is('admin') then raise exception 'Admins manage this suggestion' using errcode = '42501'; end if;
 select * into r from review_item where org_id = current_org() and id = p_item and kind = 'wa_contact' and status = 'pending';
 if r.id is null then raise exception 'A suggestion has already been decided' using errcode = 'P0002'; end if;
 pr := coalesce(r.proposed, '{}');
 if r.entity_type = 'contact' then
  select * into cp from contact_profile where org_id = current_org() and person_id = r.entity_id;
  if cp.person_id is null then
   insert into contact_profile (org_id, person_id, source) values (current_org(), r.entity_id, 'whatsapp_import') returning * into cp;
  end if;
  if nullif(pr->>'designation', '') is not null and nullif(cp.designation, '') is null and not ('designation' = any(coalesce(cp.locked, '{}'))) then
   insert into record_change (org_id, entity_type, entity_id, field, old_value, new_value, changed_by) values (current_org(), 'contact', r.entity_id, 'designation', null, pr->>'designation', current_viewer());
   update contact_profile set designation = left(pr->>'designation', 120), updated_at = now() where org_id = current_org() and person_id = r.entity_id; n := n + 1;
  end if;
  if nullif(pr->>'email', '') is not null and nullif(cp.email, '') is null and not ('email' = any(coalesce(cp.locked, '{}'))) then
   insert into record_change (org_id, entity_type, entity_id, field, old_value, new_value, changed_by) values (current_org(), 'contact', r.entity_id, 'email', null, pr->>'email', current_viewer());
   update contact_profile set email = left(lower(pr->>'email'), 200), updated_at = now() where org_id = current_org() and person_id = r.entity_id; n := n + 1;
  end if;
  if (pr->>'contactType') in ('developer', 'channel_partner', 'talent', 'vendor', 'other') and coalesce(cp.type_status, '') <> 'confirmed' and not ('contact_type' = any(coalesce(cp.locked, '{}'))) then
   update contact_profile set contact_type = pr->>'contactType', updated_at = now() where org_id = current_org() and person_id = r.entity_id; n := n + 1;
  end if;
  if nullif(pr->>'clientId', '') is not null and exists (select 1 from client where org_id = current_org() and id = (pr->>'clientId')::uuid) then
   insert into client_contact (org_id, client_id, person_id, is_primary) values (current_org(), (pr->>'clientId')::uuid, r.entity_id, false) on conflict do nothing;
   get diagnostics k = row_count; n := n + k;
  end if;
 elsif r.entity_type = 'client' then
  select * into cl from client where org_id = current_org() and id = r.entity_id;
  if nullif(pr->>'website', '') is not null and nullif(cl.website, '') is null and not ('website' = any(coalesce(cl.locked, '{}'))) then
   insert into record_change (org_id, entity_type, entity_id, field, old_value, new_value, changed_by) values (current_org(), 'client', r.entity_id, 'website', null, pr->>'website', current_viewer());
   update client set website = left(lower(pr->>'website'), 200), updated_at = now() where org_id = current_org() and id = r.entity_id; n := n + 1;
  end if;
 end if;
 return jsonb_build_object('ok', true, 'changed', n);
end $$;

revoke all on function pulse.wa_intel_ref(uuid, uuid), pulse.wa_intel(jsonb), pulse.wa_person_perf_read(uuid), pulse.wa_client_finance(uuid), pulse.wa_work_decide(uuid, text, jsonb), pulse.wa_contact_apply(uuid) from public;
grant execute on function pulse.wa_intel_ref(uuid, uuid), pulse.wa_intel(jsonb), pulse.wa_person_perf_read(uuid), pulse.wa_client_finance(uuid), pulse.wa_work_decide(uuid, text, jsonb), pulse.wa_contact_apply(uuid) to pulse_api;

-- migrate:down
-- Forward-only.

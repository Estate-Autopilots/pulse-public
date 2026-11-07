-- migrate:up
-- EST-1035 (owner, 16 Oct 2026; contract: plan revision 5 on EST-1035, reviews "slice-1-review" r2 and r4): AI
-- co-workers inside a company's Pulse, leaders first, in Chats. An agent is a person of side 'agent' that never signs
-- in and holds no role: no account, password, device or role_assignment, only revocable, expiring keys that the
-- company's own runner holds on the company's own server (pulse_priv.agent_key, kept as a hash). A key works on
-- /api/v0/agent/* only, where the API turns on pulse.agent_session: the one way an agent passes the chat checks, so it
-- reaches only conversations it is in.
--
-- A leader's own direct message, @mention or reply to a co-worker becomes one agent_event per co-worker and message.
-- The runner leases it (two minutes, fenced by a token), then dispatches it: under the co-worker's own lock (the same
-- lock settlement, pause and switching take) the invocation is checked again, the run's capacity reserved against the
-- day's budget (plan revision 5: reserved before each run; an overrun pauses it) and the run recorded, before any model
-- call. A dispatched event is never handed out again: a run that misses its deadline becomes uncertain (or done, when
-- its answer was already written) and keeps its reservation. The answer goes only to that event's conversation, inside
-- that run, with a client key bound to that run. A co-worker may propose a hand-off; a leader in the conversation
-- accepting it, with access checked again when it is claimed, makes it board work, filed once under a fence: a filing
-- that cannot be confirmed becomes uncertain and is never filed again by itself. Reasons people see are fixed codes.
-- Every state change wakes the conversation's live stream. Additive: people's own checks (staff only) are unchanged.

alter table pulse.person drop constraint person_side_check;
alter table pulse.person add constraint person_side_check
  check (side in ('staff','freelancer','client','channel_partner','talent','vendor','other','agent'));

create table pulse.agent_member (
  org_id uuid not null references pulse.org(id),
  person_id uuid primary key references pulse.person(id),
  title text not null default '' check (length(title) <= 120),
  owner_person_id uuid references pulse.person(id),
  runtime text not null default '' check (length(runtime) <= 80),
  -- Reserved before every run (a Codex quick reply measured about 12,400 tokens) and the company-day budget.
  run_reserve int not null default 16000 check (run_reserve between 1000 and 200000),
  daily_token_budget int not null default 160000 check (daily_token_budget between 1000 and 2000000),
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  disabled_at timestamptz,
  paused_reason text check (length(paused_reason) <= 300)
);
create table pulse_priv.agent_key (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  person_id uuid not null references pulse.agent_member(person_id),
  prefix text not null unique check (prefix ~ '^[0-9a-f]{8}$'),
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  label text not null default '' check (length(label) <= 80),
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz not null default now() + interval '90 days',
  revoked_at timestamptz
);
create table pulse.agent_event (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references pulse.agent_member(person_id),
  event_type text not null check (event_type in ('chat.message','chat.mention','chat.reply','task.mention','task.assigned')),
  subject_type text not null check (subject_type in ('message','comment','task')),
  subject_id uuid not null,
  event_key text not null check (length(event_key) <= 200),
  invoked_by uuid not null references pulse.person(id),
  created_at timestamptz not null default clock_timestamp(),
  state text not null default 'queued' check (state in ('queued','leased','dispatching','done','failed','uncertain')),
  attempts int not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  retry_at timestamptz,
  run_id uuid,
  finished_at timestamptz,
  -- Why, as a fixed code (the app words it): never free text from a runner or a model.
  reason text check (reason in ('message_gone','not_leader','agent_left','asker_left','budget_spent','not_chats','expired',
                                'gave_up','stuck','model_error','no_answer','released','one_at_a_time','hourly_limit','paused')),
  unique (org_id, agent_id, event_key)
);
create index agent_event_open on pulse.agent_event (org_id, agent_id, created_at) where state in ('queued','leased');
create index agent_event_subject on pulse.agent_event (subject_id);
create table pulse.agent_run (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references pulse.agent_member(person_id),
  event_id uuid not null references pulse.agent_event(id),
  state text not null default 'dispatching' check (state in ('dispatching','done','error','uncertain')),
  lane text not null default '' check (length(lane) <= 40),
  model text not null default '' check (length(model) <= 80),
  reserved int not null check (reserved > 0),
  tokens int check (tokens >= 0),               -- the provider's own count; null when it reported none (unknown)
  seconds numeric(8,1) check (seconds >= 0),
  over_cap boolean not null default false,
  error_code text check (error_code in ('model_error','no_answer','stuck')),
  started_at timestamptz not null default clock_timestamp(),
  deadline timestamptz not null,
  finished_at timestamptz
);
create unique index agent_run_one_active on pulse.agent_run (agent_id) where state = 'dispatching';
create index agent_run_day on pulse.agent_run (org_id, agent_id, started_at);
alter table pulse.agent_event add constraint agent_event_run_fk foreign key (run_id) references pulse.agent_run(id);
create table pulse.agent_output (
  org_id uuid not null references pulse.org(id),
  run_id uuid not null references pulse.agent_run(id),
  subject_type text not null check (subject_type in ('message','comment')),
  subject_id uuid not null,
  primary key (subject_type, subject_id)
);
create index agent_output_run on pulse.agent_output (run_id);
create table pulse.agent_handoff (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references pulse.agent_member(person_id),
  run_id uuid not null unique references pulse.agent_run(id),
  channel_id uuid not null,
  message_id uuid not null,                     -- the co-worker's answer that carries the proposal
  title text not null check (length(title) between 1 and 200),
  details text not null default '' check (length(details) <= 4000),
  state text not null default 'proposed' check (state in ('proposed','accepted','declined','filing','filed','uncertain','closed')),
  reason text check (reason in ('agent_left','decider_not_leader','decider_left','filing_unconfirmed')),
  proposed_at timestamptz not null default now(),
  decided_by uuid references pulse.person(id),
  decided_at timestamptz,
  filing_token uuid,
  filing_until timestamptz,
  board_ref text check (length(board_ref) <= 80),
  filed_at timestamptz
);
create index agent_handoff_message on pulse.agent_handoff (message_id);
create index agent_handoff_open on pulse.agent_handoff (org_id, agent_id) where state in ('accepted','filing');
do $$ declare t text; begin
  foreach t in array array['pulse.agent_member','pulse_priv.agent_key','pulse.agent_event','pulse.agent_run','pulse.agent_output','pulse.agent_handoff'] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format('create policy tenant on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  end loop;
end $$;
-- The API shows who the co-workers are, what each answer cost, whether a question is being answered and its hand-off.
-- Keys stay behind the functions below.
grant select on pulse.agent_member, pulse.agent_event, pulse.agent_run, pulse.agent_output, pulse.agent_handoff to pulse_api;
create trigger audit_mutation after insert or update or delete on pulse.agent_member for each row execute function pulse.audit_mutation();
-- Key issue and revoke are audited by prefix (audit_write below), never with the hash.

-- Every change to a question's state, a run or a hand-off wakes the conversation's live stream (chat_event, the same
-- sequence /chats/events follows), so an open chat updates without a reload or an unrelated message.
create function pulse.agent_touch() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cid uuid;
begin
  -- One branch per table (each row type has its own fields).
  if TG_TABLE_NAME = 'agent_handoff' then
    cid := new.channel_id;
  elsif TG_TABLE_NAME = 'agent_event' then
    if new.subject_type = 'message' then select channel_id into cid from chat_message where id = new.subject_id; end if;
  else
    select x.channel_id into cid from agent_event e join chat_message x on x.id = e.subject_id and e.subject_type = 'message' where e.id = new.event_id;
  end if;
  if cid is not null then insert into chat_event(org_id, channel_id) values (new.org_id, cid); end if;
  return null;
end $$;
create trigger agent_touch after update of state on pulse.agent_event for each row execute function pulse.agent_touch();
create trigger agent_touch after insert or update on pulse.agent_run for each row execute function pulse.agent_touch();
create trigger agent_touch after insert or update on pulse.agent_handoff for each row execute function pulse.agent_touch();

-- An agent never signs in as a person: no password, no Workspace account and no device token can name one.
create function pulse.agent_no_sign_in() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pid uuid;
begin
  execute format('select ($1).%I', TG_ARGV[0]) using new into pid;
  if pid is not null and exists(select 1 from person where id = pid and side = 'agent') then
    raise exception 'An AI co-worker does not sign in; it works through its key' using errcode='42501'; end if;
  return new;
end $$;
create trigger agent_no_sign_in before insert or update on pulse.login_credential for each row execute function pulse.agent_no_sign_in('person_id');
create trigger agent_no_sign_in before insert or update on pulse.account for each row execute function pulse.agent_no_sign_in('holder_person_id');
create trigger agent_no_sign_in before insert or update on pulse_priv.native_token for each row execute function pulse.agent_no_sign_in('person_id');
-- Nor does it hold a role: an admin or leadership role would open moderation and every viewer_is check to it.
create function pulse.agent_no_role() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
  if exists(select 1 from person where id = new.person_id and side = 'agent') then
    raise exception 'An AI co-worker holds no role; its owner and caps say what it may do' using errcode='42501'; end if;
  return new;
end $$;
create trigger agent_no_role before insert or update on pulse.role_assignment for each row execute function pulse.agent_no_role();
-- And nobody turns a person into a co-worker or a co-worker into a person: agent_create is the only way in.
create function pulse.agent_side_fixed() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
  if (old.side = 'agent') <> (new.side = 'agent') then
    raise exception 'A person never becomes an AI co-worker, nor a co-worker a person' using errcode='42501'; end if;
  return new;
end $$;
create trigger agent_side_fixed before update of side on pulse.person for each row execute function pulse.agent_side_fixed();

-- The agent behind this request, or null. Only the API's agent route turns the session on, after it checked the key.
create function pulse.agent_session() returns uuid language sql stable security definer set search_path=pulse,pg_temp as $$
  select m.person_id from agent_member m join person p on p.id = m.person_id
   where coalesce(current_setting('pulse.agent_session', true), '') = 'on'
     and m.org_id = current_org() and m.person_id = current_viewer()
     and m.disabled_at is null and p.status = 'active' and p.side = 'agent'
$$;

-- A current leader or admin of this company (active staff with the role today): who may invoke and steer co-workers.
create function pulse.agent_leader(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
  select exists(select 1 from person p join role_assignment r on r.person_id = p.id and r.org_id = p.org_id
                 where p.id = p_person and p.org_id = current_org() and p.status = 'active' and p.side = 'staff'
                   and r.role_key in ('admin','leadership') and current_date between r.valid_from and coalesce(r.valid_to, 'infinity'))
$$;

-- An active agent passes the chat checks inside its own session, so chat_has, chat_send and the member_read policies
-- treat it like any member: only the conversations it belongs to (it holds no role, so never the moderation path).
create or replace function pulse.chat_active() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
  select exists(select 1 from person where id = current_viewer() and status = 'active' and side = 'staff') or agent_session() is not null
$$;

-- Leaders and admins open a direct message with an active co-worker; an agent never opens one itself.
do $$
declare d text; c text;
begin
  d := pg_get_functiondef('pulse.chat_direct(uuid)'::regprocedure);
  c := replace(d, $x$ if not chat_active() or p_person=current_viewer() or not exists(select 1 from person where id=p_person and status='active' and side='staff') then raise exception 'choose an active teammate' using errcode='22023'; end if;$x$,
    $x$ if agent_session() is not null or not chat_active() or p_person=current_viewer() or not (exists(select 1 from person where id=p_person and status='active' and side='staff')
   or (agent_leader(current_viewer()) and exists(select 1 from agent_member m join person p on p.id=m.person_id
        where m.person_id=p_person and m.org_id=current_org() and m.disabled_at is null and p.status='active'))) then raise exception 'choose an active teammate' using errcode='22023'; end if;$x$);
  if c = d then raise exception 'chat_direct changed shape (agent)'; end if;
  execute c;
end $$;

-- A leader who admins a custom group adds a co-worker to it or takes it out (people's own group functions still take
-- staff only). Pods, teams and Google groups are rebuilt from staff and never hold one.
create function pulse.agent_group_member(p_channel uuid, p_agent uuid, p_add boolean) returns void
  language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
  if agent_session() is not null or not agent_leader(current_viewer()) then raise exception 'Leaders add AI co-workers to groups' using errcode='42501'; end if;
  if not exists(select 1 from chat_channel where id = p_channel and org_id = current_org() and kind = 'custom') or not chat_group_admin(p_channel) then
    raise exception 'Only a group admin adds a co-worker to a group they made or run' using errcode='42501'; end if;
  if not exists(select 1 from agent_member m join person p on p.id = m.person_id where m.person_id = p_agent and m.org_id = current_org()
                  and m.disabled_at is null and p.status = 'active') then raise exception 'Choose an active co-worker' using errcode='22023'; end if;
  if p_add then
    insert into chat_member(org_id, channel_id, person_id) values (current_org(), p_channel, p_agent) on conflict do nothing;
    if found then perform chat_event_line(p_channel, current_viewer(), 'added ' || (select display_name from person where id = p_agent)); end if;
  else
    delete from chat_member where org_id = current_org() and channel_id = p_channel and person_id = p_agent;
    if found then perform chat_event_line(p_channel, current_viewer(), 'removed ' || (select display_name from person where id = p_agent)); end if;
  end if;
end $$;

-- A leader's own message wakes the co-workers it is for: a direct message to one, an @mention of one in the
-- conversation, or a reply to one's message; one event per co-worker and message, so a direct message that also
-- mentions it wakes it once. Agents never wake agents; imported or relayed rows (not the sender's own) never wake one.
create function pulse.agent_event_from_chat() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a record;
begin
  if new.kind <> 'text' or new.removed_at is not null or new.author_id is distinct from current_viewer() then return null; end if;
  if exists(select 1 from person where id = new.author_id and side = 'agent') or not agent_leader(new.author_id) then return null; end if;
  for a in
    select m.person_id agent,
           case when ch.kind = 'direct' then 'chat.message' when m.person_id = any(new.mentions) then 'chat.mention' else 'chat.reply' end kind
      from agent_member m join person p on p.id = m.person_id
      join chat_channel ch on ch.id = new.channel_id
      join chat_member cm on cm.channel_id = new.channel_id and cm.person_id = m.person_id
     where m.org_id = new.org_id and m.disabled_at is null and p.status = 'active'
       and (ch.kind = 'direct' or m.person_id = any(new.mentions)
            or exists(select 1 from chat_message pm where pm.id = coalesce(new.parent_id, new.quote_id) and pm.author_id = m.person_id))
  loop
    insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
    values (new.org_id, a.agent, a.kind, 'message', new.id, 'message:' || new.id, new.author_id) on conflict do nothing;
  end loop;
  return null;
end $$;
create trigger agent_event_from_chat after insert on pulse.chat_message for each row execute function pulse.agent_event_from_chat();

-- The co-worker's own lock, taken first by everything that reads or changes its runs, budget or switch (dispatch,
-- settlement, claim and its sweep, the admin switch), always in that order: they never interleave or deadlock.
create function pulse.agent_lock(p_agent uuid) returns pulse.agent_member language sql security definer set search_path=pulse,pg_temp as $$
  select * from agent_member where person_id = p_agent and org_id = current_org() for update
$$;

-- Runs past their deadline: with a durable answer they are done (usage unknown); without one they are uncertain and
-- keep their reservation. Their events are never handed out again. (Called under agent_lock.)
create function pulse.agent_sweep(p_agent uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r record;
begin
  for r in update agent_run ar set state = case when exists(select 1 from agent_output o where o.run_id = ar.id) then 'done' else 'uncertain' end,
              finished_at = now(), error_code = case when exists(select 1 from agent_output o where o.run_id = ar.id) then null else 'stuck' end
            where ar.org_id = current_org() and ar.agent_id = p_agent and ar.state = 'dispatching' and ar.deadline < now() returning ar.id, ar.event_id, ar.state loop
    update agent_event set state = case when r.state = 'done' then 'done' else 'uncertain' end, finished_at = now(),
           reason = case when r.state = 'done' then null else 'stuck' end
     where id = r.event_id;
  end loop;
end $$;

-- What the runner can lease: up to ten queued events (or leases that ran out before dispatch), for two minutes.
create function pulse.agent_events_claim(p_limit int) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); out jsonb;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  perform agent_lock(me);
  perform agent_sweep(me);
  -- A day-old question is not answered out of the blue; five leases that never dispatched are enough.
  update agent_event set state = 'failed', finished_at = now(), lease_token = null, lease_until = null,
         reason = case when attempts >= 5 then 'gave_up' else 'expired' end
   where org_id = current_org() and agent_id = me and (state = 'queued' or (state = 'leased' and lease_until < now()))
     and (created_at < now() - interval '1 day' or attempts >= 5);
  with picked as (
    select id from agent_event
     where org_id = current_org() and agent_id = me
       and ((state = 'queued' and (retry_at is null or retry_at <= now())) or (state = 'leased' and lease_until < now()))
     order by created_at limit greatest(1, least(coalesce(p_limit, 5), 10)) for update skip locked),
  leased as (
    update agent_event e set state = 'leased', lease_token = gen_random_uuid(), lease_until = now() + interval '2 minutes', attempts = e.attempts + 1
      from picked where e.id = picked.id returning e.*)
  select coalesce(jsonb_agg(jsonb_build_object('event', jsonb_build_object('id', id, 'eventType', event_type, 'subjectType', subject_type,
           'subjectId', subject_id, 'eventKey', event_key, 'createdAt', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
           'leaseToken', lease_token, 'leaseUntil', to_char(lease_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) order by created_at), '[]'::jsonb)
    into out from leased;
  return out;
end $$;

-- A lease handed back before dispatch (the runner could not start): queued again after a backoff.
create function pulse.agent_event_release(p_id uuid, p_token uuid) returns void
  language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session();
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  update agent_event set state = 'queued', lease_token = null, lease_until = null,
         retry_at = now() + make_interval(secs => 30 * power(2, least(attempts, 6))), reason = 'released'
   where id = p_id and org_id = current_org() and agent_id = me and state = 'leased' and lease_token = p_token and lease_until > now();
  if not found then raise exception 'That event is not leased to you any more' using errcode='22023'; end if;
end $$;

-- Dispatch: with the live lease and under the co-worker's lock, check the invocation and the co-worker again, reserve
-- the run's capacity and record the run, before any model or board call. Returns {status: dispatched, runId, deadline,
-- reserved, context} or {status: busy|refused, reason}: a refused event is closed with its reason code, a busy one
-- (one run at a time, the hourly limit, or the co-worker paused) is queued again.
create function pulse.agent_dispatch(p_id uuid, p_token uuid, p_lane text, p_model text) returns jsonb
  language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); e agent_event; m agent_member; msg chat_message; why text; busy text; committed int; rid uuid; dl timestamptz;
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
    when not agent_leader(e.invoked_by) then 'not_leader'
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
  dl := now() + interval '3 minutes';
  insert into agent_run(org_id, agent_id, event_id, lane, model, reserved, deadline)
  values (current_org(), me, e.id, left(coalesce(p_lane, ''), 40), left(coalesce(p_model, ''), 80), m.run_reserve, dl) returning id into rid;
  update agent_event set state = 'dispatching', run_id = rid, lease_token = null, lease_until = null, reason = null where id = e.id;
  return jsonb_build_object('status', 'dispatched', 'runId', rid, 'reserved', m.run_reserve,
    'deadline', to_char(dl at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'context', jsonb_build_object(
      'message', (select jsonb_build_object('id', x.id, 'channelId', x.channel_id, 'parentId', x.parent_id, 'body', left(x.body, 2000),
                    'author', p.display_name, 'channelKind', ch.kind, 'channelName', case when ch.kind = 'direct' then null else ch.name end)
                  from chat_message x join person p on p.id = x.author_id join chat_channel ch on ch.id = x.channel_id where x.id = msg.id),
      'recent', (select coalesce(jsonb_agg(r.j order by r.at), '[]'::jsonb) from (
                  select x.created_at at, jsonb_build_object('author', p.display_name, 'byAgent', p.side = 'agent', 'mine', x.author_id = me,
                           'body', left(x.body, 600)) j
                    from chat_message x join person p on p.id = x.author_id
                   where x.channel_id = msg.channel_id and x.removed_at is null and x.kind = 'text' and x.created_at <= msg.created_at
                   order by x.created_at desc limit 14) r)));
end $$;

-- The answer: inside the run, before its deadline, in the run's own event's conversation, through chat_send itself
-- (same checks, mentions, notifications). A client key is bound to its run: the same run's identical retry returns the
-- same message; another run reusing it, or a different text, fails.
create function pulse.agent_chat_reply(p_channel uuid, p_body text, p_parent uuid, p_client uuid, p_run uuid) returns uuid
  language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); mid uuid; prior_run uuid; prior boolean;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if not exists(select 1 from agent_run r join agent_event e on e.id = r.event_id join chat_message x on x.id = e.subject_id
                 where r.id = p_run and r.org_id = current_org() and r.agent_id = me and r.state = 'dispatching' and r.deadline > now()
                   and e.state = 'dispatching' and e.subject_type = 'message' and x.channel_id = p_channel) then
    raise exception 'Answer in the conversation that asked you, inside its run' using errcode='42501'; end if;
  select true, o.run_id into prior, prior_run from chat_message x left join agent_output o on o.subject_type = 'message' and o.subject_id = x.id
   where x.org_id = current_org() and x.author_id = me and x.client_id = p_client;
  if prior and prior_run is distinct from p_run then raise exception 'That client key belongs to another run' using errcode='22023'; end if;
  mid := chat_send(p_channel, p_body, p_parent, '[]'::jsonb, p_client, null);
  insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), p_run, 'message', mid) on conflict do nothing;
  if not exists(select 1 from agent_output where subject_type = 'message' and subject_id = mid and run_id = p_run) then
    raise exception 'That message belongs to another run' using errcode='22023'; end if;
  return mid;
end $$;

-- A co-worker may propose a hand-off on its own answer; it becomes work only when a leader accepts it.
create function pulse.agent_handoff_propose(p_run uuid, p_message uuid, p_title text, p_details text) returns uuid
  language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); hid uuid; ch uuid;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  select x.channel_id into ch from agent_run r join agent_output o on o.run_id = r.id and o.subject_type = 'message' and o.subject_id = p_message
    join chat_message x on x.id = p_message
   where r.id = p_run and r.org_id = current_org() and r.agent_id = me and r.state = 'dispatching' and r.deadline > now();
  if ch is null then raise exception 'Propose a hand-off on your answer, inside its run' using errcode='42501'; end if;
  if length(btrim(coalesce(p_title, ''))) not between 1 and 200 then raise exception 'Name the hand-off in up to 200 characters' using errcode='22023'; end if;
  insert into agent_handoff(org_id, agent_id, run_id, channel_id, message_id, title, details)
  values (current_org(), me, p_run, ch, p_message, btrim(p_title), left(coalesce(p_details, ''), 4000))
  on conflict (run_id) do update set title = agent_handoff.title returning id into hid;
  return hid;
end $$;

-- A leader in the conversation accepts or declines the proposal.
create function pulse.agent_handoff_decide(p_handoff uuid, p_accept boolean) returns text
  language plpgsql security definer set search_path=pulse,pg_temp as $$
declare h agent_handoff;
begin
  if agent_session() is not null or not agent_leader(current_viewer()) then raise exception 'A leader decides a co-worker''s hand-off' using errcode='42501'; end if;
  select * into h from agent_handoff where id = p_handoff and org_id = current_org() for update;
  if not found or not exists(select 1 from chat_member where channel_id = h.channel_id and person_id = current_viewer()) then
    raise exception 'Choose a hand-off in a conversation you are in' using errcode='22023'; end if;
  if p_accept is null then raise exception 'Accept or decline it' using errcode='22023'; end if;
  if h.state <> 'proposed' then return h.state; end if;
  update agent_handoff set state = case when p_accept then 'accepted' else 'declined' end, decided_by = current_viewer(), decided_at = now() where id = h.id;
  return case when p_accept then 'accepted' else 'declined' end;
end $$;

-- Accepted hand-offs for the runner to file, each under a filing token for five minutes. Before anything is returned,
-- access is checked again: the co-worker still in the conversation, the leader who accepted it still a leader and still
-- in it; otherwise it is closed with the reason and its content never leaves. A filing whose lease ran out is not
-- handed out again: it becomes uncertain (a person checks the board), so nothing is ever filed twice by itself.
create function pulse.agent_handoffs_claim() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); out jsonb;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  update agent_handoff set state = 'uncertain', reason = 'filing_unconfirmed', filing_token = null
   where org_id = current_org() and agent_id = me and state = 'filing' and filing_until < now();
  update agent_handoff h set state = 'closed', reason = case
      when not exists(select 1 from chat_member where channel_id = h.channel_id and person_id = me) then 'agent_left'
      when not agent_leader(h.decided_by) then 'decider_not_leader' else 'decider_left' end
   where h.org_id = current_org() and h.agent_id = me and h.state = 'accepted'
     and (not exists(select 1 from chat_member where channel_id = h.channel_id and person_id = me) or not agent_leader(h.decided_by)
          or not exists(select 1 from chat_member where channel_id = h.channel_id and person_id = h.decided_by));
  with picked as (
    -- Cleanup is a separate statement: access may have changed, or acceptance arrived, since its snapshot.
    select h.id from agent_handoff h where h.org_id = current_org() and h.agent_id = me and h.state = 'accepted'
      and exists(select 1 from chat_member where org_id = h.org_id and channel_id = h.channel_id and person_id = me)
      and agent_leader(h.decided_by)
      and exists(select 1 from chat_member where org_id = h.org_id and channel_id = h.channel_id and person_id = h.decided_by)
    order by h.decided_at limit 5 for update of h skip locked),
  leased as (update agent_handoff h set state = 'filing', filing_token = gen_random_uuid(), filing_until = now() + interval '5 minutes'
               from picked where h.id = picked.id returning h.*)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'details', details, 'channelId', channel_id, 'messageId', message_id,
           'filingToken', filing_token)), '[]'::jsonb)
    into out from leased;
  return out;
end $$;

-- Filed once, with the live filing token: the board issue is stored and the co-worker says so in the conversation (an
-- identical retry returns the same; another token, an expired lease or a different board issue fails). The work comes
-- back to the leader for review; nothing here marks it done.
create function pulse.agent_handoff_filed(p_handoff uuid, p_token uuid, p_board_ref text, p_client uuid) returns jsonb
  language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); h agent_handoff; mid uuid;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if coalesce(p_board_ref, '') !~ '^[A-Za-z0-9-]{1,40}$' then raise exception 'Give the board issue it was filed as' using errcode='22023'; end if;
  select * into h from agent_handoff where id = p_handoff and org_id = current_org() and agent_id = me for update;
  if not found then raise exception 'Choose one of your hand-offs' using errcode='22023'; end if;
  if h.state = 'filed' then
    if h.board_ref = p_board_ref then return jsonb_build_object('boardRef', h.board_ref, 'state', h.state); end if;
    raise exception 'That hand-off was already filed as %', h.board_ref using errcode='22023';
  end if;
  if h.state <> 'filing' or h.filing_token is distinct from p_token or h.filing_until <= now() then
    raise exception 'That hand-off is not being filed by you any more' using errcode='22023'; end if;
  update agent_handoff set state = 'filed', board_ref = p_board_ref, filed_at = now(), filing_until = null where id = h.id;
  if exists(select 1 from chat_member where channel_id = h.channel_id and person_id = me) then
    mid := chat_send(h.channel_id, 'Handed over as ' || p_board_ref || '. I''ll report back here for you to review.', null, '[]'::jsonb, p_client, h.message_id);
    insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), h.run_id, 'message', mid) on conflict do nothing;
  end if;
  return jsonb_build_object('boardRef', p_board_ref, 'state', 'filed');
end $$;

-- The runner could not confirm a filing (the board timed out): uncertain, and never filed again by itself.
create function pulse.agent_handoff_unsure(p_handoff uuid, p_token uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session();
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  update agent_handoff set state = 'uncertain', reason = 'filing_unconfirmed', filing_token = null
   where id = p_handoff and org_id = current_org() and agent_id = me and state = 'filing' and filing_token = p_token;
  if not found then raise exception 'That hand-off is not being filed by you any more' using errcode='22023'; end if;
end $$;

-- The run settles under the co-worker's lock at the provider's own count (null: it reported none). Over its
-- reservation, the run is flagged and the co-worker pauses until an admin switches it back on: at most one overrun.
create function pulse.agent_run_finish(p_run uuid, p_state text, p_tokens int, p_seconds numeric, p_error_code text) returns jsonb
  language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r agent_run; m agent_member; used int; over boolean; code text;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if p_state is null or p_state not in ('done','error') then raise exception 'Say done or error' using errcode='22023'; end if;
  code := case when p_state = 'done' then null when p_error_code in ('model_error','no_answer') then p_error_code else 'model_error' end;
  m := agent_lock(me);
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me for update;
  if not found or r.state <> 'dispatching' then raise exception 'That run is not running' using errcode='22023'; end if;
  over := p_tokens is not null and p_tokens > r.reserved;
  update agent_run set state = p_state, tokens = case when p_tokens is null then null else greatest(0, least(p_tokens, 10000000)) end,
         seconds = greatest(0, least(coalesce(p_seconds, 0), 9999999)), over_cap = over, error_code = code, finished_at = now()
   where id = r.id;
  update agent_event set state = case when p_state = 'done' then 'done' else 'failed' end, finished_at = now(), reason = code where id = r.event_id;
  if over then
    update agent_member set disabled_at = coalesce(disabled_at, now()),
           paused_reason = format('A run used %s tokens, over its %s reservation; an admin switches it back on', p_tokens, r.reserved)
     where person_id = me;
  end if;
  select * into m from agent_member where person_id = me;
  select coalesce(sum(case when state in ('done','error') then coalesce(tokens, reserved) else reserved end), 0) into used
    from agent_run where agent_id = me and (started_at at time zone org_time_zone())::date = (now() at time zone org_time_zone())::date;
  return jsonb_build_object('usedToday', used, 'dailyBudget', m.daily_token_budget, 'reserve', m.run_reserve, 'paused', m.disabled_at is not null);
end $$;

-- Admins make co-workers, switch them off (their keys stop at once) or on, list them with their keys, and issue (shown
-- once; 90 days unless said otherwise) and revoke keys. Rotating: issue a new key, then revoke the old one.
create function pulse.agent_create(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pid uuid; v_name text := btrim(coalesce(p->>'name', '')); v_user text := lower(btrim(coalesce(p->>'username', ''))); n int;
        v_title text := left(coalesce(nullif(btrim(p->>'title'), ''), 'AI co-worker'), 120);
begin
  if agent_session() is not null or not viewer_is('admin') then raise exception 'Admins add AI co-workers' using errcode='42501'; end if;
  if length(v_name) not between 1 and 80 then raise exception 'Name the co-worker in up to 80 characters' using errcode='22023'; end if;
  if v_user !~ '^[a-z0-9][a-z0-9._-]{2,39}$' then raise exception 'Choose a username: 3 to 40 lower-case letters, digits, dots or dashes' using errcode='22023'; end if;
  if exists(select 1 from people_profile where org_id = current_org() and username = v_user) then raise exception 'That username is taken' using errcode='23505'; end if;
  insert into person(org_id, display_name, side, status) values (current_org(), v_name, 'agent', 'active') returning id into pid;
  select coalesce(max(user_no), 0) + 1 into n from people_profile where org_id = current_org();
  insert into people_profile(org_id, person_id, role, evidence, user_no, username) values (current_org(), pid, v_title, 'agent_create', n, v_user);
  insert into agent_member(org_id, person_id, title, owner_person_id, runtime, run_reserve, daily_token_budget, created_by)
  values (current_org(), pid, v_title, coalesce(nullif(p->>'ownerId', '')::uuid, current_viewer()), left(coalesce(p->>'runtime', ''), 80),
          coalesce(nullif(p->>'runReserve', '')::int, 16000), coalesce(nullif(p->>'dailyTokenBudget', '')::int, 160000), current_viewer());
  return pid;
end $$;

create function pulse.agent_switch(p_agent uuid, p_on boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
  if agent_session() is not null or not viewer_is('admin') then raise exception 'Admins switch AI co-workers' using errcode='42501'; end if;
  if p_on is null then raise exception 'Switch it on or off' using errcode='22023'; end if;
  perform agent_lock(p_agent);
  update agent_member set disabled_at = case when p_on then null else coalesce(disabled_at, now()) end,
         paused_reason = case when p_on then null else paused_reason end
   where person_id = p_agent and org_id = current_org();
  if not found then raise exception 'Choose a co-worker' using errcode='22023'; end if;
end $$;

create function pulse.agent_list() returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
  if agent_session() is not null or not viewer_is('admin') then raise exception 'Admins manage AI co-workers' using errcode='42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.person_id, 'name', p.display_name, 'username', pp.username, 'title', m.title, 'on', m.disabled_at is null, 'pausedReason', m.paused_reason,
    'runReserve', m.run_reserve, 'dailyBudget', m.daily_token_budget,
    'usedToday', (select coalesce(sum(case when r.state in ('done','error') then coalesce(r.tokens, r.reserved) else r.reserved end), 0) from agent_run r
                   where r.agent_id = m.person_id and (r.started_at at time zone org_time_zone())::date = (now() at time zone org_time_zone())::date),
    'keys', coalesce((select jsonb_agg(jsonb_build_object('prefix', k.prefix, 'label', k.label, 'createdAt', k.created_at,
               'lastUsedAt', k.last_used_at, 'expiresAt', k.expires_at, 'revokedAt', k.revoked_at) order by k.created_at desc)
             from pulse_priv.agent_key k where k.person_id = m.person_id), '[]'::jsonb)) order by p.display_name), '[]'::jsonb)
    from agent_member m join person p on p.id = m.person_id left join people_profile pp on pp.person_id = m.person_id
    where m.org_id = current_org());
end $$;

create function pulse.agent_key_issue(p_agent uuid, p_label text, p_days int default 90) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_prefix text; v_secret text;
begin
  if agent_session() is not null or not viewer_is('admin') then raise exception 'Admins issue co-worker keys' using errcode='42501'; end if;
  if not exists(select 1 from agent_member where person_id = p_agent and org_id = current_org() and disabled_at is null) then
    raise exception 'Choose an active co-worker' using errcode='22023'; end if;
  if p_days is null or p_days not between 1 and 365 then raise exception 'A key lasts 1 to 365 days' using errcode='22023'; end if;
  loop
    v_prefix := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
    exit when not exists(select 1 from pulse_priv.agent_key where prefix = v_prefix);
  end loop;
  v_secret := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into pulse_priv.agent_key(org_id, person_id, prefix, secret_hash, label, created_by, expires_at)
  values (current_org(), p_agent, v_prefix, encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'), left(coalesce(p_label, ''), 80), current_viewer(),
          now() + make_interval(days => p_days));
  perform audit_write('agent_key_issued', 'agent_key', v_prefix);
  return 'pak_' || v_prefix || '_' || v_secret;
end $$;

create function pulse.agent_key_revoke(p_prefix text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
  if agent_session() is not null or not viewer_is('admin') then raise exception 'Admins revoke co-worker keys' using errcode='42501'; end if;
  update pulse_priv.agent_key set revoked_at = now() where org_id = current_org() and prefix = p_prefix and revoked_at is null;
  if not found then raise exception 'No such key' using errcode='22023'; end if;
  perform audit_write('agent_key_revoked', 'agent_key', p_prefix);
end $$;

-- The API's agent route: the co-worker a key belongs to, in this company, or null (unknown, revoked, expired, or its
-- co-worker off). Marks the key used.
create function pulse.agent_key_resolve(p_key text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k pulse_priv.agent_key;
begin
  if p_key is null or p_key !~ '^pak_[0-9a-f]{8}_[0-9a-f]{64}$' then return null; end if;
  select * into k from pulse_priv.agent_key where prefix = substr(p_key, 5, 8) and org_id = current_org() and revoked_at is null and expires_at > now();
  if not found or k.secret_hash <> encode(sha256(convert_to(substr(p_key, 14), 'UTF8')), 'hex') then return null; end if;
  if not exists(select 1 from agent_member m join person p on p.id = m.person_id where m.person_id = k.person_id and m.disabled_at is null and p.status = 'active') then return null; end if;
  update pulse_priv.agent_key set last_used_at = now() where id = k.id and (last_used_at is null or last_used_at < now() - interval '1 minute');
  return k.person_id;
end $$;

revoke all on function pulse.agent_touch(), pulse.agent_no_sign_in(), pulse.agent_no_role(), pulse.agent_side_fixed(), pulse.agent_session(),
  pulse.agent_leader(uuid), pulse.agent_group_member(uuid,uuid,boolean), pulse.agent_event_from_chat(), pulse.agent_lock(uuid), pulse.agent_sweep(uuid),
  pulse.agent_events_claim(int), pulse.agent_event_release(uuid,uuid), pulse.agent_dispatch(uuid,uuid,text,text),
  pulse.agent_chat_reply(uuid,text,uuid,uuid,uuid), pulse.agent_handoff_propose(uuid,uuid,text,text), pulse.agent_handoff_decide(uuid,boolean),
  pulse.agent_handoffs_claim(), pulse.agent_handoff_filed(uuid,uuid,text,uuid), pulse.agent_handoff_unsure(uuid,uuid),
  pulse.agent_run_finish(uuid,text,int,numeric,text), pulse.agent_create(jsonb), pulse.agent_switch(uuid,boolean), pulse.agent_list(),
  pulse.agent_key_issue(uuid,text,int), pulse.agent_key_revoke(text), pulse.agent_key_resolve(text) from public;
grant execute on function pulse.agent_session(), pulse.agent_leader(uuid), pulse.agent_group_member(uuid,uuid,boolean), pulse.agent_events_claim(int),
  pulse.agent_event_release(uuid,uuid), pulse.agent_dispatch(uuid,uuid,text,text), pulse.agent_chat_reply(uuid,text,uuid,uuid,uuid),
  pulse.agent_handoff_propose(uuid,uuid,text,text), pulse.agent_handoff_decide(uuid,boolean), pulse.agent_handoffs_claim(),
  pulse.agent_handoff_filed(uuid,uuid,text,uuid), pulse.agent_handoff_unsure(uuid,uuid), pulse.agent_run_finish(uuid,text,int,numeric,text),
  pulse.agent_create(jsonb), pulse.agent_switch(uuid,boolean), pulse.agent_list(), pulse.agent_key_issue(uuid,text,int), pulse.agent_key_revoke(text),
  pulse.agent_key_resolve(text) to pulse_api;

-- migrate:down
-- Forward-only: co-workers, their keys, events, runs and hand-offs must remain auditable.

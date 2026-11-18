-- migrate:up
-- AGENT-OPERATOR (owner, 13 Nov 2026, OWNER-FEEDBACK-1113 P4.2: "on the left side it's entirely opening things, doing
-- work, going back and forth, reporting problems that arise"). Builds on AGENT-UI-CONTROL (1745) and FIX-CHAT-AI (1952).
--
-- 1. Send, pay and delete ask the person first (T4.2.1). A click whose words send, pay, delete, approve, sign … now
--    needs 'confirm': it is ALWAYS asked, whatever the AI employee's level or a kept "Always", and only the person whose
--    screen it is answers it (Allow once or No). Before this, an AI employee at Admin level, or one an admin had once
--    allowed "Always" to click at admin level, clicked such a button without anyone being asked, and an admin could say
--    yes to a click on a colleague's screen. The click itself still runs as the person, so Pulse's own checks apply.
-- 2. Two more screen actions for the operator view: file.upload (a file already shared in the chat goes into a file
--    field on the page, as if the person picked it) and file.download (a file the page links to is fetched in the
--    person's browser and attached in the chat, so the AI employee and the person both have it). Both act.
-- 3. A step that did not work files a bug (T4.2.2): the AI employee is the reporter, with the screen, the error, its
--    steps before it and a picture of the page (pulse.reported_bug, 1201). The same problem on the same screen is one
--    report: it gets a "happened again" note instead of a new number. reported_bug.agent_action links the step.
-- 4. A daily review (tools/operator-bug-review.mjs, as the worker role) reads the open groups
--    (pulse.operator_bug_groups), writes the likely cause and a proposed fix on the report, folds the group's other
--    reports into the first one (duplicate_of) and adds the lesson to the AI employee's playbook: one of its standing
--    rules (agent_rule, 1840), source 'review', which every later run reads and an admin can retire on its profile.
-- Additive; uses only objects defined in this repository's migrations.

-- ------------------------------------------------------------------------------------------------------ 1. confirm
alter table pulse.agent_ui_action drop constraint if exists agent_ui_action_needed_check;
alter table pulse.agent_ui_action add constraint agent_ui_action_needed_check check (needed in ('view', 'act', 'admin', 'confirm'));

-- 'confirm' ranks with act: the person it is helping may answer it (and only they: agent_ui_decide).
create or replace function pulse.agent_ui_rank(p_level text) returns int language sql immutable as $$
  select case p_level when 'off' then 0 when 'view' then 1 when 'act' then 2 when 'confirm' then 2 when 'admin' then 3 else -1 end
$$;

create or replace function pulse.agent_ui_action_level(p_action text, p_args jsonb) returns text language sql immutable as $$
  select case
    when p_action in ('page.open', 'panel.open', 'tab.open') then
      case when coalesce(p_args->>'path', p_args->>'target', '') ~* '^(https?://[^/]+)?/(settings|admin|platform)(/|\?|#|$)' then 'admin' else 'view' end
    when p_action in ('panel.close', 'sidebar.set', 'point.at', 'mic.stop', 'screen.read') then 'view'
    when p_action = 'form.open' then case when coalesce(p_args->>'form', '') in ('person', 'ai_employee') then 'admin' else 'act' end
    when p_action in ('composer.insert', 'emoji.insert', 'file.pick', 'mic.start', 'field.fill', 'file.upload', 'file.download') then 'act'
    when p_action = 'element.click' then
      case when coalesce(p_args->>'text', '') ~* '(^|[^a-z])(delete|remove|discard|cancel|pay|send|submit|approve|reject|sign|archive|revoke|disable|log ?out|sign ?out|transfer|refund|issue)([^a-z]|$)' then 'confirm' else 'act' end
    else null end
$$;

create or replace function pulse.agent_ui_request(p_target uuid, p_action text, p_args jsonb, p_why text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); agent uuid := agent_session(); target uuid := coalesce(p_target, current_viewer());
  needed text := agent_ui_action_level(p_action, coalesce(p_args, '{}')); lvl text; chan uuid; st text; rid uuid; prior agent_ui_action;
begin
  if me is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if needed is null then raise exception 'Pulse has no screen action called %', left(coalesce(p_action, ''), 40) using errcode = '22023'; end if;
  if p_args is null or jsonb_typeof(p_args) <> 'object' or length(p_args::text) > 4000 then raise exception 'Give the action''s details as an object of at most 4,000 characters' using errcode = '22023'; end if;
  if agent is null then
    if target <> me then raise exception 'Your own key drives only your own screen' using errcode = '42501'; end if;
    st := 'sent';
  else
    if agent_paused() or not exists(select 1 from agent_member m where m.org_id = current_org() and m.person_id = agent and m.disabled_at is null) then
      raise exception 'This AI employee is paused' using errcode = '42501'; end if;
    lvl := agent_ui_level_of(agent);
    if lvl = 'off' then raise exception 'Screen control is off for you. An admin or leadership can turn it on in your profile, under AI and then Capabilities.' using errcode = '42501'; end if;
    if not exists(select 1 from person p where p.id = target and p.org_id = current_org() and p.status = 'active' and p.side = 'staff') then
      raise exception 'You can drive the screen only of a colleague you are helping' using errcode = '42501'; end if;
    chan := agent_ui_helping(agent, target);
    if chan is null then raise exception 'You can drive someone''s screen only while you help them: they wrote to you in the last 30 minutes' using errcode = '42501'; end if;
    if (select count(*) from agent_ui_action where org_id = current_org() and agent_id = agent and target_id = target and created_at > clock_timestamp() - interval '1 minute') >= 30 then
      raise exception 'Too many screen actions in one minute; wait a little' using errcode = '54000'; end if;
    -- AGENT-OPERATOR: send, pay, delete … is asked every time, whatever the level or a kept "Always".
    if needed = 'confirm' then st := 'asked';
    elsif agent_ui_rank(lvl) >= agent_ui_rank(needed) or exists(select 1 from agent_ui_allow w where w.org_id = current_org() and w.agent_id = agent and w.action = p_action
         and agent_ui_rank(w.level) >= agent_ui_rank(needed)) then st := 'sent'; else st := 'asked'; end if;
    -- The same open prompt is not asked twice.
    if st = 'asked' then
      select * into prior from agent_ui_action where org_id = current_org() and agent_id = agent and target_id = target and action = p_action and args = p_args
        and state = 'asked' and expires_at > clock_timestamp() order by created_at desc limit 1;
      if found then return agent_ui_row(prior) || jsonb_build_object('message', 'Already asked; waiting for a yes.'); end if;
    end if;
  end if;
  insert into agent_ui_action (org_id, agent_id, target_id, action, args, needed, why, channel_id, state, sent_at, expires_at)
  values (current_org(), agent, target, p_action, p_args, needed, nullif(left(btrim(coalesce(p_why, '')), 300), ''), chan, st,
          case when st = 'sent' then clock_timestamp() end, clock_timestamp() + case when st = 'asked' then interval '10 minutes' else interval '2 minutes' end)
  returning id into rid;
  perform agent_ui_wake(target, st = 'asked');
  return agent_ui_row((select a from agent_ui_action a where a.id = rid)) || jsonb_build_object('message', case
    when st = 'sent' then 'Sent to their screen.'
    when needed = 'confirm' then format('This click sends, pays, deletes or approves something, so %s was asked first on their screen (Allow once or No). Tell them you asked; it runs when they say yes.',
      (select display_name from person where id = target))
    else format('Above your screen level (%s; this needs %s): %s was asked in the top bar. Tell them you asked; it runs when someone says yes.', lvl, needed,
      (select display_name from person where id = target)) end);
end $$;

-- A 'confirm' prompt is shown only to the person whose screen it is (admins and leadership still see every other one).
create or replace function pulse.agent_ui_pending() returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); mgr boolean := agent_ui_can_manage();
begin
  if me is null or coalesce(current_setting('pulse.agent_session', true), '') = 'on' then return jsonb_build_object('actions', '[]'::jsonb, 'asks', '[]'::jsonb); end if;
  update agent_ui_action set state = 'expired' where org_id = current_org() and state in ('asked', 'sent') and expires_at <= clock_timestamp()
    and (target_id = me or (mgr and state = 'asked'));
  return jsonb_build_object(
    'actions', coalesce((select jsonb_agg(agent_ui_row(a) order by a.created_at) from agent_ui_action a where a.org_id = current_org() and a.target_id = me and a.state = 'sent'), '[]'::jsonb),
    'asks', coalesce((select jsonb_agg(agent_ui_row(a) || jsonb_build_object('mine', a.target_id = me, 'canAlways', mgr and a.agent_id is not null and a.needed <> 'confirm') order by a.created_at desc)
      from agent_ui_action a where a.org_id = current_org() and a.state = 'asked'
        and ((mgr and a.needed <> 'confirm') or (a.target_id = me and agent_ui_rank(a.needed) <= 2))), '[]'::jsonb),
    'manager', mgr);
end $$;

create or replace function pulse.agent_ui_decide(p_id uuid, p_decision text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); mgr boolean := agent_ui_can_manage(); r agent_ui_action;
begin
  if me is null or coalesce(current_setting('pulse.agent_session', true), '') = 'on' then raise exception 'A person decides this' using errcode = '42501'; end if;
  if p_decision not in ('once', 'always', 'no') then raise exception 'Choose once, always or no' using errcode = '22023'; end if;
  select * into r from agent_ui_action where id = p_id and org_id = current_org() for update;
  if not found then raise exception 'No such request' using errcode = 'P0002'; end if;
  if r.state <> 'asked' or r.expires_at <= clock_timestamp() then raise exception 'This request has ended' using errcode = '55000'; end if;
  if r.needed = 'confirm' then
    if r.target_id <> me then raise exception 'Only the person whose screen it is says yes to this' using errcode = '42501'; end if;
    if p_decision = 'always' then raise exception 'Sending, paying and deleting are asked every time' using errcode = '42501'; end if;
  end if;
  if not mgr and not (r.target_id = me and agent_ui_rank(r.needed) <= 2) then raise exception 'An admin or leadership decides this one' using errcode = '42501'; end if;
  if p_decision = 'always' and not mgr then raise exception 'Only admins and leadership can always allow it' using errcode = '42501'; end if;
  if p_decision = 'always' then
    insert into agent_ui_allow (org_id, agent_id, action, level, granted_by) values (current_org(), r.agent_id, r.action, r.needed, me)
    on conflict (org_id, agent_id, action) do update set level = case when agent_ui_rank(excluded.level) > agent_ui_rank(agent_ui_allow.level) then excluded.level else agent_ui_allow.level end,
      granted_by = excluded.granted_by, granted_at = excluded.granted_at;
  end if;
  update agent_ui_action set state = case when p_decision = 'no' then 'refused' else 'sent' end, decision = p_decision, decided_by = me, decided_at = clock_timestamp(),
    sent_at = case when p_decision = 'no' then null else clock_timestamp() end,
    expires_at = case when p_decision = 'no' then expires_at else clock_timestamp() + interval '2 minutes' end
  where id = p_id returning * into r;
  perform agent_ui_wake(r.target_id, true);
  return agent_ui_row(r);
end $$;

-- ------------------------------------------------------------------------------------------------------ 3. bugs
alter table pulse.reported_bug add column agent_action uuid references pulse.agent_ui_action(id) on delete set null;
create index reported_bug_agent on pulse.reported_bug (org_id, fingerprint) where agent_action is not null;

-- The steps an AI employee took on this person's screen in the ten minutes before (for its bug report's trail).
create or replace function pulse.agent_ui_trail(p_id uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('at', x.created_at, 'kind', x.action, 'name', left(coalesce(x.args->>'text', x.args->>'field', x.args->>'path', x.args->>'target', ''), 120),
      'status', case x.state when 'done' then 200 when 'failed' then 500 when 'refused' then 403 else 0 end) order by x.created_at), '[]'::jsonb)
  from (select a.* from agent_ui_action a join agent_ui_action f on f.id = p_id and f.org_id = current_org()
        where a.org_id = current_org() and a.agent_id = f.agent_id and a.target_id = f.target_id and a.created_at between f.created_at - interval '10 minutes' and f.created_at
        order by a.created_at desc limit 20) x
$$;

-- ------------------------------------------------------------------------------------------------------ 4. review
alter table pulse.agent_rule drop constraint if exists agent_rule_source_check;
alter table pulse.agent_rule add constraint agent_rule_source_check check (source in ('chat', 'profile', 'review'));

/** The open problems AI employees filed, grouped (same screen, same error), with any activity since p_since, for the
 *  daily review. One row per organisation and group; never the screenshot. Worker role only. */
create function pulse.operator_bug_groups(p_since timestamptz)
returns table (org_id uuid, org_name text, fingerprint text, first_id uuid, first_number integer, numbers integer[], agent_id uuid, agent_name text,
  route text, words text, errors jsonb, trail jsonb, times integer, first_at timestamptz, last_at timestamptz, reviewed boolean)
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o record;
begin
  for o in select g.id, g.name from pulse.org g loop
    perform set_config('pulse.org_id', o.id::text, true);
    return query
      with b as (select r.* from reported_bug r where r.org_id = o.id and r.agent_action is not null and r.duplicate_of is null and r.status in ('new', 'triaged', 'fixing')),
      again as (select e.report_id, count(*)::int as n, max(e.at) as last_seen from reported_bug_event e join b on b.id = e.report_id where e.kind = 'note' and e.value = 'again' group by e.report_id),
      g as (select b.fingerprint fp, (array_agg(b.id order by b.created_at))[1] first_id, array_agg(b.number order by b.created_at) numbers,
              count(*)::int + coalesce(sum(a.n), 0)::int times, min(b.created_at) first_at, greatest(max(b.created_at), max(a.last_seen)) last_at
            from b left join again a on a.report_id = b.id group by b.fingerprint)
      select o.id, o.name, g.fp, g.first_id, f.number, g.numbers, f.person_id, (select display_name from person where id = f.person_id), f.route, left(f.words, 600),
        f.errors, f.trail, g.times, g.first_at, g.last_at,
        exists (select 1 from reported_bug_event e where e.report_id = g.first_id and e.kind = 'note' and e.value = 'review' and e.at >= g.last_at)
      from g join reported_bug f on f.id = g.first_id
      where g.last_at > p_since
      order by g.times desc, g.last_at desc;
  end loop;
  perform set_config('pulse.org_id', '', true);
end $$;

/** The daily review's finding for one group: its likely cause and proposed fix as a note on the first report, the
 *  group's other open reports folded into it, and the lesson added to the AI employee's playbook (a standing rule,
 *  source 'review', once). Worker role only. */
create function pulse.operator_bug_review(p_org uuid, p_fingerprint text, p jsonb) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare f reported_bug; folded int := 0; lesson text := btrim(regexp_replace(coalesce(p->>'lesson', ''), '\s+', ' ', 'g')); rid uuid; parsed jsonb;
  note text := left(btrim(concat_ws(E'\n', 'Daily review.', 'Likely cause: ' || nullif(btrim(p->>'cause'), ''), 'Proposed fix: ' || nullif(btrim(p->>'fix'), ''),
    'Playbook: ' || nullif(lesson, ''))), 2000);
begin
  perform set_config('pulse.org_id', p_org::text, true);
  select * into f from reported_bug where org_id = p_org and fingerprint = p_fingerprint and agent_action is not null and duplicate_of is null
    and status in ('new', 'triaged', 'fixing') order by created_at limit 1;
  if not found then perform set_config('pulse.org_id', '', true); return null; end if;
  insert into reported_bug_event (org_id, report_id, kind, value, note) values (p_org, f.id, 'note', 'review', note);
  with d as (update reported_bug set duplicate_of = f.id, updated_at = now() where org_id = p_org and fingerprint = p_fingerprint and agent_action is not null
               and duplicate_of is null and id <> f.id and status in ('new', 'triaged', 'fixing') returning id)
  insert into reported_bug_event (org_id, report_id, kind, value, note) select p_org, d.id, 'duplicate', '#' || f.number, 'Folded into #' || f.number || ' by the daily review' from d;
  get diagnostics folded = row_count;
  if length(lesson) between 3 and 600 and exists (select 1 from agent_member m where m.org_id = p_org and m.person_id = f.person_id)
     and not exists (select 1 from agent_rule r where r.org_id = p_org and r.agent_id = f.person_id and r.retired_at is null and lower(r.body) = lower(lesson)) then
    parsed := agent_rule_parse(lesson);
    insert into agent_rule (org_id, agent_id, body, scope, include_text, set_by, source)
    values (p_org, f.person_id, lesson, coalesce(parsed->>'scope', 'all'), null, f.person_id, 'review') returning id into rid;
  end if;
  perform set_config('pulse.org_id', '', true);
  return jsonb_build_object('number', f.number, 'folded', folded, 'ruleId', rid);
end $$;

revoke all on function pulse.agent_ui_trail(uuid), pulse.operator_bug_groups(timestamptz), pulse.operator_bug_review(uuid, text, jsonb) from public;
grant execute on function pulse.agent_ui_trail(uuid) to pulse_api;
grant execute on function pulse.operator_bug_groups(timestamptz), pulse.operator_bug_review(uuid, text, jsonb) to pulse_worker;
grant update (agent_action) on pulse.reported_bug to pulse_api;

-- migrate:down
-- Forward-only.

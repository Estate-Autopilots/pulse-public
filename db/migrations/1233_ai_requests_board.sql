-- migrate:up
-- AI-AUTONOMY (owner, 27 Oct 2026): "When an agent lacks a tool or a tool fails, it doesn't stall. It files a structured
-- request into Pulse's bug and feature board." BUG-REPORT's reports (1201, pulse.reported_bug*) become that board:
--   reported_bug.kind        bug (a person's Ctrl+B report, or a tool that failed an AI employee), tool_needed (an AI
--                            employee lacks a tool for its job), feature (an idea)
--   reported_bug.title       a short line for the board (the words stay the details)
--   reported_bug.by_agent    filed by an AI employee (person_id is that AI employee)
--   reported_bug.dev_queue   on the queue Pulse's dev agents pull from (agent requests start there; leadership decides)
--   reported_bug.votes       the count of reported_bug_vote (one per person, AI employees too)
--   reported_bug.shipped_ref what shipped it (a commit or release), set by a dev agent
--   reported_bug_event       'note' is the discussion: people, AI employees and dev agents comment there
--   pulse_priv.dev_queue_token  service tokens for server-side dev agents (Claude on the server): only a hash is kept; the
--                            queue API (/api/v0/dev-queue/*) reads every organisation's queued items, comments, and moves
--                            an item to fixing, fixed (shipped) or wontfix. Issued by the server's operator only.
-- Statuses stay BUG-REPORT's: new, triaged, fixing, fixed (shown as Shipped on the board), wontfix.

alter table pulse.reported_bug
  add column if not exists kind text not null default 'bug' check (kind in ('bug', 'tool_needed', 'feature')),
  add column if not exists title text check (title is null or length(btrim(title)) between 3 and 200),
  add column if not exists by_agent boolean not null default false,
  add column if not exists dev_queue boolean not null default false,
  add column if not exists votes integer not null default 0 check (votes >= 0),
  add column if not exists shipped_ref text check (length(shipped_ref) <= 200);
create index if not exists reported_bug_queue on pulse.reported_bug (org_id, dev_queue, status) where dev_queue;

create table if not exists pulse.reported_bug_vote (
  org_id uuid not null references pulse.org(id),
  report_id uuid not null references pulse.reported_bug(id) on delete cascade,
  person_id uuid not null references pulse.person(id),
  at timestamptz not null default now(),
  primary key (report_id, person_id)
);
alter table pulse.reported_bug_vote enable row level security;
alter table pulse.reported_bug_vote force row level security;
create policy tenant on pulse.reported_bug_vote using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.reported_bug_vote to pulse_api;

create table if not exists pulse_priv.dev_queue_token (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name ~ '^[A-Za-z0-9 ._-]{2,60}$'),
  prefix text not null unique check (prefix ~ '^[0-9a-f]{8}$'),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  used_at timestamptz,
  revoked_at timestamptz
);
revoke all on pulse_priv.dev_queue_token from public;

-- Who sees an item on the board: tool requests and ideas, every colleague; a bug, the person who sent it and leadership
-- (as BUG-REPORT's triage); an AI employee's own requests, it.
create or replace function pulse.board_can_see(b pulse.reported_bug) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select b.org_id = current_org() and current_viewer() is not null and (
    b.kind in ('tool_needed', 'feature') or b.person_id = current_viewer() or b.by_agent or viewer_is('admin', 'leadership'))
$$;

-- The board: newest or top voted, by kind and status, with my vote and the discussion's size.
create or replace function pulse.board_list(p_kind text, p_status text, p_sort text) returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(x.j order by x.k1 desc, x.k2 desc), '[]'::jsonb) from (
    select case when p_sort = 'new' then 0 else b.votes end k1, b.created_at k2, jsonb_build_object(
      'id', b.id, 'number', b.number, 'kind', b.kind, 'title', coalesce(b.title, left(regexp_replace(b.words, '\s+', ' ', 'g'), 120)),
      'words', left(b.words, 600), 'status', b.status, 'severity', b.severity, 'votes', b.votes, 'devQueue', b.dev_queue, 'byAgent', b.by_agent,
      'mine', exists(select 1 from reported_bug_vote v where v.report_id = b.id and v.person_id = current_viewer()),
      'comments', (select count(*)::int from reported_bug_event e where e.report_id = b.id and e.kind = 'note'),
      'by', coalesce(p.display_name, b.reporter_name), 'createdAt', b.created_at, 'statusAt', b.status_at, 'shippedRef', b.shipped_ref) j
      from reported_bug b left join person p on p.id = b.person_id
     where board_can_see(b) and b.duplicate_of is null
       and (coalesce(p_kind, 'all') = 'all' or b.kind = p_kind)
       and (coalesce(p_status, 'open') = 'all' or (coalesce(p_status, 'open') = 'open' and b.status in ('new', 'triaged', 'fixing')) or b.status = p_status)
     order by 1 desc, 2 desc limit 300) x
$$;

-- One item and its discussion (comments, and status changes in words).
create or replace function pulse.board_item(p_id uuid) returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('id', b.id, 'number', b.number, 'kind', b.kind, 'title', coalesce(b.title, left(regexp_replace(b.words, '\s+', ' ', 'g'), 120)),
      'words', b.words, 'status', b.status, 'severity', b.severity, 'votes', b.votes, 'devQueue', b.dev_queue, 'byAgent', b.by_agent, 'route', b.route,
      'mine', exists(select 1 from reported_bug_vote v where v.report_id = b.id and v.person_id = current_viewer()),
      'by', coalesce(p.display_name, b.reporter_name), 'createdAt', b.created_at, 'shippedRef', b.shipped_ref, 'canTriage', viewer_is('admin', 'leadership'),
      'discussion', (select coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'value', e.value, 'note', e.note, 'at', e.at,
          'who', coalesce(a.display_name, case when e.value like 'dev:%' then 'Pulse dev agent (' || substr(e.value, 5) || ')' end, 'Pulse'),
          'agent', coalesce(a.side = 'agent', e.value like 'dev:%')) order by e.at, e.id), '[]'::jsonb)
        from reported_bug_event e left join person a on a.id = e.actor_id where e.report_id = b.id and e.kind in ('note', 'status')))
    from reported_bug b left join person p on p.id = b.person_id where b.id = p_id and board_can_see(b)
$$;

-- An upvote (or taking it back): anyone who sees the item, AI employees too; the count is kept on the item.
create or replace function pulse.board_vote(p_id uuid, p_up boolean) returns integer language plpgsql security definer set search_path = pulse, pg_temp as $$
declare b reported_bug; n int;
begin
  select * into b from reported_bug where id = p_id and org_id = current_org() for update;
  if not found or not board_can_see(b) then raise exception 'Not found' using errcode = 'P0002'; end if;
  if p_up then insert into reported_bug_vote(org_id, report_id, person_id) values (current_org(), b.id, current_viewer()) on conflict do nothing;
  else delete from reported_bug_vote where report_id = b.id and person_id = current_viewer(); end if;
  select count(*)::int into n from reported_bug_vote where report_id = b.id;
  update reported_bug set votes = n where id = b.id;
  return n;
end $$;

-- A comment in the discussion.
create or replace function pulse.board_comment(p_id uuid, p_body text) returns bigint language plpgsql security definer set search_path = pulse, pg_temp as $$
declare b reported_bug; t text := btrim(coalesce(p_body, '')); eid bigint;
begin
  select * into b from reported_bug where id = p_id and org_id = current_org();
  if not found or not board_can_see(b) then raise exception 'Not found' using errcode = 'P0002'; end if;
  if length(t) not between 1 and 2000 then raise exception 'Write the comment in up to 2,000 characters' using errcode = '22023'; end if;
  insert into reported_bug_event(org_id, report_id, kind, note, actor_id) values (current_org(), b.id, 'note', t, current_viewer()) returning id into eid;
  update reported_bug set updated_at = now() where id = b.id;
  return eid;
end $$;

-- Leadership puts an item on the dev agents' queue or takes it off.
create or replace function pulse.board_queue(p_id uuid, p_on boolean) returns boolean language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if agent_session() is not null or not viewer_is('admin', 'leadership') then raise exception 'Leadership decides what the dev agents pick up' using errcode = '42501'; end if;
  update reported_bug set dev_queue = p_on, updated_at = now() where id = p_id and org_id = current_org();
  if not found then raise exception 'Not found' using errcode = 'P0002'; end if;
  insert into reported_bug_event(org_id, report_id, kind, note, actor_id)
  values (current_org(), p_id, 'note', case when p_on then 'Put on the dev agents'' queue.' else 'Taken off the dev agents'' queue.' end, current_viewer());
  return p_on;
end $$;

-- An AI employee files what it needs, inside a run: a tool it lacks, a tool that failed, or an idea. The same open
-- request (same kind and title) gets its vote and a note instead of a second item. On the dev agents' queue at once.
create or replace function pulse.agent_request_file(p_run uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); r agent_run; k text := coalesce(nullif(p->>'kind', ''), 'tool_needed');
  t text := left(btrim(regexp_replace(coalesce(p->>'title', ''), '\s+', ' ', 'g')), 200);
  d text := left(btrim(coalesce(p->>'details', '')), 3000); fp text; uname text; b reported_bug; nid uuid; num int;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  if k not in ('bug', 'tool_needed', 'feature') then raise exception 'Choose bug, tool_needed or feature' using errcode = '22023'; end if;
  if length(t) < 3 then raise exception 'Give the request a short title' using errcode = '22023'; end if;
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me;
  if not found then raise exception 'File it inside one of your runs' using errcode = '42501'; end if;
  select username into uname from people_profile where person_id = me;
  fp := encode(sha256(convert_to(k || ':' || lower(t), 'UTF8')), 'hex');
  select * into b from reported_bug where org_id = current_org() and fingerprint = fp and status in ('new', 'triaged', 'fixing') and duplicate_of is null
   order by created_at limit 1;
  if found then
    insert into reported_bug_vote(org_id, report_id, person_id) values (current_org(), b.id, me) on conflict do nothing;
    update reported_bug set votes = (select count(*) from reported_bug_vote where report_id = b.id), updated_at = now() where id = b.id;
    if d <> '' then insert into reported_bug_event(org_id, report_id, kind, note, actor_id) values (current_org(), b.id, 'note', left(d, 2000), me); end if;
    return jsonb_build_object('id', b.id, 'number', b.number, 'new', false);
  end if;
  perform pg_advisory_xact_lock(hashtext('pulse.reported_bug:' || current_org()::text));
  insert into reported_bug(org_id, number, person_id, command_id, words, route, fingerprint, kind, title, by_agent, dev_queue, severity)
  select current_org(), coalesce(max(number), 0) + 1, me, 'run-' || replace(p_run::text, '-', ''), coalesce(nullif(d, ''), t),
    left('/agent/' || coalesce(uname, me::text), 512), fp, k, t, true, true, case when k = 'bug' then 'medium' end
    from reported_bug where org_id = current_org()
  on conflict (org_id, person_id, command_id) do nothing
  returning id, number into nid, num;
  if nid is null then
    select id, number into nid, num from reported_bug where org_id = current_org() and person_id = me and command_id = 'run-' || replace(p_run::text, '-', '');
    return jsonb_build_object('id', nid, 'number', num, 'new', false);
  end if;
  insert into reported_bug_vote(org_id, report_id, person_id) values (current_org(), nid, me) on conflict do nothing;
  update reported_bug set votes = 1 where id = nid;
  return jsonb_build_object('id', nid, 'number', num, 'new', true);
end $$;

-- ---------------------------------------------------------------- the dev agents' queue (service token, every organisation)
create or replace function pulse.dev_queue_token_issue(p_name text) returns text language plpgsql security definer set search_path = pulse, pg_temp as $$
declare pre text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  sec text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''); tok text;
begin
  if current_viewer() is not null or agent_session() is not null then raise exception 'The server''s operator issues dev queue tokens' using errcode = '42501'; end if;
  tok := 'pdq_' || pre || '_' || sec;
  insert into pulse_priv.dev_queue_token(name, prefix, token_hash) values (p_name, pre, encode(sha256(convert_to(tok, 'UTF8')), 'hex'));
  return tok;
end $$;
create or replace function pulse.dev_queue_token_revoke(p_prefix text) returns void language sql security definer set search_path = pulse, pg_temp as $$
  update pulse_priv.dev_queue_token set revoked_at = now() where prefix = p_prefix and revoked_at is null
$$;
-- The token's name, or an error (unknown or revoked).
create or replace function pulse.dev_queue_auth(p_token text) returns text language plpgsql security definer set search_path = pulse, pg_temp as $$
declare t pulse_priv.dev_queue_token;
begin
  if p_token is null or p_token !~ '^pdq_[0-9a-f]{8}_[0-9a-f]{64}$' then raise exception 'A dev queue token is required' using errcode = '42501'; end if;
  select * into t from pulse_priv.dev_queue_token where prefix = substr(p_token, 5, 8) and revoked_at is null;
  if not found or t.token_hash <> encode(sha256(convert_to(p_token, 'UTF8')), 'hex') then raise exception 'This dev queue token is unknown or revoked' using errcode = '42501'; end if;
  update pulse_priv.dev_queue_token set used_at = now() where id = t.id and (used_at is null or used_at < now() - interval '1 minute');
  return t.name;
end $$;
-- The organisation an item belongs to, read as each organisation in turn (row security is forced).
create or replace function pulse.dev_queue_org(p_id uuid) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o uuid; f uuid;
begin
  for o in select id from org loop
    perform set_config('pulse.org_id', o::text, true);
    select org_id into f from reported_bug where id = p_id;
    if f is not null then return f; end if;
  end loop;
  perform set_config('pulse.org_id', '', true);
  return null;
end $$;

-- Items on the queue across every organisation: open ones by default (new, triaged, fixing), most votes first.
create or replace function pulse.dev_queue_list(p_token text, p_status text, p_limit integer) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o record; out_ jsonb := '[]'::jsonb; s text := coalesce(nullif(p_status, ''), 'open');
begin
  perform dev_queue_auth(p_token);
  if s not in ('open', 'all', 'new', 'triaged', 'fixing', 'fixed', 'wontfix') then raise exception 'Unknown status' using errcode = '22023'; end if;
  for o in select g.id, g.name, g.code from org g loop
    perform set_config('pulse.org_id', o.id::text, true);
    out_ := out_ || coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'org', o.code, 'orgName', o.name, 'number', b.number, 'kind', b.kind,
        'title', coalesce(b.title, left(regexp_replace(b.words, '\s+', ' ', 'g'), 120)), 'words', left(b.words, 2000), 'route', b.route,
        'status', b.status, 'severity', b.severity, 'votes', b.votes, 'byAgent', b.by_agent, 'createdAt', b.created_at, 'statusAt', b.status_at,
        'comments', (select count(*)::int from reported_bug_event e where e.report_id = b.id and e.kind = 'note')))
      from reported_bug b where b.org_id = o.id and b.dev_queue and b.duplicate_of is null
        and (s = 'all' or (s = 'open' and b.status in ('new', 'triaged', 'fixing')) or b.status = s)), '[]'::jsonb);
  end loop;
  perform set_config('pulse.org_id', '', true);
  return (select coalesce(jsonb_agg(y.x order by y.v desc, y.c), '[]'::jsonb)
            from (select x, (x->>'votes')::int v, x->>'createdAt' c from jsonb_array_elements(out_) x
                   order by 2 desc, 3 limit greatest(1, least(coalesce(p_limit, 50), 200))) y);
end $$;

-- One item with what a fixer needs: the words, the screen, the scrubbed errors, failed calls and steps, the discussion.
create or replace function pulse.dev_queue_item(p_token text, p_id uuid) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare j jsonb;
begin
  perform dev_queue_auth(p_token);
  if dev_queue_org(p_id) is null then raise exception 'Not found' using errcode = 'P0002'; end if;
  select jsonb_build_object('id', b.id, 'org', g.code, 'number', b.number, 'kind', b.kind, 'title', coalesce(b.title, left(b.words, 120)), 'words', b.words,
      'route', b.route, 'platform', b.platform, 'appVersion', b.app_version, 'status', b.status, 'severity', b.severity, 'votes', b.votes, 'devQueue', b.dev_queue,
      'errors', b.errors, 'network', b.network, 'trail', b.trail, 'shippedRef', b.shipped_ref, 'createdAt', b.created_at,
      'discussion', (select coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'value', e.value, 'note', e.note, 'at', e.at,
          'who', coalesce(a.display_name, e.value)) order by e.at, e.id), '[]'::jsonb)
        from reported_bug_event e left join person a on a.id = e.actor_id where e.report_id = b.id))
    into j from reported_bug b join org g on g.id = b.org_id where b.id = p_id;
  perform set_config('pulse.org_id', '', true);
  if j is null or not (j->>'devQueue')::boolean then raise exception 'Not found' using errcode = 'P0002'; end if;
  return j;
end $$;

create or replace function pulse.dev_queue_comment(p_token text, p_id uuid, p_body text) returns bigint language plpgsql security definer set search_path = pulse, pg_temp as $$
declare nm text := dev_queue_auth(p_token); o uuid; t text := btrim(coalesce(p_body, '')); eid bigint;
begin
  if length(t) not between 1 and 2000 then raise exception 'Write the comment in up to 2,000 characters' using errcode = '22023'; end if;
  o := dev_queue_org(p_id);
  if o is null or not exists(select 1 from reported_bug where id = p_id and dev_queue) then raise exception 'Not found' using errcode = 'P0002'; end if;
  insert into reported_bug_event(org_id, report_id, kind, value, note) values (o, p_id, 'note', left('dev:' || nm, 200), t) returning id into eid;
  update reported_bug set updated_at = now() where id = p_id;
  perform set_config('pulse.org_id', '', true);
  return eid;
end $$;

-- Picked up (fixing), shipped (fixed, with what shipped it) or not doing (wontfix), with a note.
create or replace function pulse.dev_queue_status(p_token text, p_id uuid, p_status text, p_note text, p_ref text) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare nm text := dev_queue_auth(p_token); o uuid;
begin
  if p_status not in ('triaged', 'fixing', 'fixed', 'wontfix') then raise exception 'Choose triaged, fixing, fixed or wontfix' using errcode = '22023'; end if;
  o := dev_queue_org(p_id);
  if o is null or not exists(select 1 from reported_bug where id = p_id and dev_queue) then raise exception 'Not found' using errcode = 'P0002'; end if;
  update reported_bug set status = p_status, status_at = now(), updated_at = now(),
    shipped_ref = case when p_status = 'fixed' then left(nullif(btrim(coalesce(p_ref, '')), ''), 200) else shipped_ref end where id = p_id;
  insert into reported_bug_event(org_id, report_id, kind, value, note) values (o, p_id, 'status', p_status, nullif(left(btrim(coalesce(p_note, '')), 2000), ''));
  insert into reported_bug_event(org_id, report_id, kind, value, note) select o, p_id, 'note', left('dev:' || nm, 200), left(btrim(p_note), 2000) where btrim(coalesce(p_note, '')) <> '';
  perform set_config('pulse.org_id', '', true);
  return jsonb_build_object('id', p_id, 'status', p_status);
end $$;

revoke all on function pulse.board_can_see(pulse.reported_bug), pulse.board_list(text, text, text), pulse.board_item(uuid), pulse.board_vote(uuid, boolean),
  pulse.board_comment(uuid, text), pulse.board_queue(uuid, boolean), pulse.agent_request_file(uuid, jsonb), pulse.dev_queue_token_issue(text),
  pulse.dev_queue_token_revoke(text), pulse.dev_queue_auth(text), pulse.dev_queue_org(uuid), pulse.dev_queue_list(text, text, integer),
  pulse.dev_queue_item(text, uuid), pulse.dev_queue_comment(text, uuid, text), pulse.dev_queue_status(text, uuid, text, text, text) from public;
grant execute on function pulse.board_list(text, text, text), pulse.board_item(uuid), pulse.board_vote(uuid, boolean), pulse.board_comment(uuid, text),
  pulse.board_queue(uuid, boolean), pulse.agent_request_file(uuid, jsonb), pulse.dev_queue_list(text, text, integer), pulse.dev_queue_item(text, uuid),
  pulse.dev_queue_comment(text, uuid, text), pulse.dev_queue_status(text, uuid, text, text, text) to pulse_api;

-- migrate:down
-- Forward-only: requests, votes and the discussion stay; revoke a token with pulse.dev_queue_token_revoke(prefix).

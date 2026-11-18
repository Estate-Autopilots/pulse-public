-- migrate:up
-- PERSONAL-MERGE (owner, 16 Nov 2026: "Savuzo HQ should be dissolved into the personal account itself. All of the
-- tasks, all of the data transferred to the personal. The personal work of a single person is a different entity from
-- an organisation. Similarly for other people who have created their own organisation: merge that into their own
-- personal account."). An organisation one person made for themselves becomes part of that person's personal space.
--
--  * pulse.org_merge_into_personal(org, account, actor, words) (the platform's tools only: tools/admin/org-merge-personal.py)
--    moves every row of the organisation into the account's personal space (made first when there is none), in one
--    statement, keeping every id: tasks, goals, projects, docs, files, contacts, Focus, settings, history. References are
--    rewritten on the way: the person's seat there becomes their personal seat, the organisation's id becomes the
--    personal space's, and a row the personal space already has its own copy of (a default category, a setting, the
--    person's own profile) stays with the old organisation, and whatever pointed at it points at the personal space's
--    copy. The organisation's own identity (public card, directory listing, brand, its sign-ins) stays with it too.
--    Module switches carry over (anything on in either stays on). One audit note per moved kind of record goes to the
--    personal space, one to the old organisation, and the whole move is kept in pulse_priv.org_merge (what moved, the
--    id map) so pulse.org_merge_undo(merge) can put it back. The emptied organisation is archived (status 'archived',
--    merged_into the personal space): it leaves every switcher, and nothing is deleted.
--  * Only an organisation that really is one person's: active, a company, not the install's own, the account's staff
--    seat in it, nobody else signs in to it, no clients, no other staff. Anything else is refused.
--  * pulse.account_org_redirect(ref): an old link (/@handle/… or /at/<id>/…) to an organisation that was merged into
--    one of the signed-in account's spaces says where it went, so the page opens there.
-- Row security: the move runs as the tables' owner inside one transaction; it lifts FORCE ROW LEVEL SECURITY and the
-- tables' own triggers only on the tables that hold the organisation's rows, only for that transaction, and sets them
-- back (checked) before it returns. Nothing is sent to anyone.

alter table pulse.org drop constraint org_status_check;
alter table pulse.org add constraint org_status_check check (status in ('setup', 'active', 'suspended', 'offboarding', 'archived'));
alter table pulse.org add column merged_into uuid references pulse.org(id);
alter table pulse.org add constraint org_merged_archived check (merged_into is null or status = 'archived');

-- One row per merge, in the personal space it went to.
create table pulse_priv.org_merge (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  from_org uuid not null references pulse.org(id),
  from_name text not null,
  account_id uuid not null references pulse_priv.pulse_account(id),
  from_person uuid not null,
  to_person uuid not null,
  actor text not null check (length(btrim(actor)) between 3 and 200),
  words text not null check (length(btrim(words)) between 3 and 2000),
  moved jsonb not null,
  kept jsonb not null,
  moved_keys jsonb not null,
  id_map jsonb not null,
  merged_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by text
);
create unique index org_merge_live on pulse_priv.org_merge(from_org) where undone_at is null;
alter table pulse_priv.org_merge enable row level security;
alter table pulse_priv.org_merge force row level security;
create policy tenant on pulse_priv.org_merge using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse_priv.org_merge from public;

-- ------------------------------------------------------------------------------------------------ rewriting helpers
-- m is {old id: new id}. A value with no entry stays as it is.
create function pulse_priv.org_merge_uuid(v uuid, m jsonb) returns uuid
  language sql immutable set search_path = pg_catalog, pg_temp as $$ select coalesce((m ->> v::text)::uuid, v) $$;
create function pulse_priv.org_merge_uuids(v uuid[], m jsonb) returns uuid[]
  language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when v is null then null else array(select coalesce((m ->> e::text)::uuid, e) from unnest(v) with ordinality u(e, n) order by n) end $$;
create function pulse_priv.org_merge_text(v text, m jsonb) returns text
  language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare k text;
begin
  if v is null or strpos(v, '-') = 0 then return v; end if;
  for k in select jsonb_object_keys(m) loop
    if strpos(v, k) > 0 then v := replace(v, k, m ->> k); end if;
  end loop;
  return v;
end $$;
create function pulse_priv.org_merge_texts(v text[], m jsonb) returns text[]
  language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when v is null then null else array(select pulse_priv.org_merge_text(e, m) from unnest(v) with ordinality u(e, n) order by n) end $$;
revoke all on function pulse_priv.org_merge_uuid(uuid, jsonb), pulse_priv.org_merge_uuids(uuid[], jsonb),
  pulse_priv.org_merge_text(text, jsonb), pulse_priv.org_merge_texts(text[], jsonb) from public;

-- The SET list that rewrites every id-carrying column of a table (uuid, uuid[], text, jsonb, json, text[]); org_id is
-- set by the caller. Generated columns are left alone.
create function pulse_priv.org_merge_set_list(p_table regclass) returns text
  language sql stable set search_path = pg_catalog, pg_temp as $$
  select coalesce(string_agg(format(case format_type(a.atttypid, null)
      when 'uuid' then '%1$I = pulse_priv.org_merge_uuid(%1$I, $1)'
      when 'uuid[]' then '%1$I = pulse_priv.org_merge_uuids(%1$I, $1)'
      when 'text' then '%1$I = pulse_priv.org_merge_text(%1$I, $1)'
      when 'character varying' then '%1$I = pulse_priv.org_merge_text(%1$I, $1)'
      when 'jsonb' then '%1$I = pulse_priv.org_merge_text(%1$I::text, $1)::jsonb'
      when 'json' then '%1$I = pulse_priv.org_merge_text(%1$I::text, $1)::json'
      when 'text[]' then '%1$I = pulse_priv.org_merge_texts(%1$I, $1)' end, a.attname), ', ' order by a.attnum), '')
    from pg_attribute a
   where a.attrelid = p_table and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attname <> 'org_id'
     and format_type(a.atttypid, null) in ('uuid', 'uuid[]', 'text', 'character varying', 'jsonb', 'json', 'text[]')
$$;
-- How a row is named in the merge record: its primary key (without org_id), or the whole row when it has none.
create function pulse_priv.org_merge_key(p_table regclass) returns text
  language sql stable set search_path = pg_catalog, pg_temp as $$
  select coalesce((select 'jsonb_build_object(' || string_agg(format('%L, t.%I', a.attname, a.attname), ', ' order by k.n) || ')'
      from pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum, n)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
     where i.indrelid = p_table and i.indisprimary and a.attname <> 'org_id'), '(to_jsonb(t) - ''org_id'')')
$$;
-- schema.table, whatever the caller's search_path.
create function pulse_priv.org_merge_name(p_table regclass) returns text
  language sql stable set search_path = pg_catalog, pg_temp as $$
  select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = p_table $$;
revoke all on function pulse_priv.org_merge_set_list(regclass), pulse_priv.org_merge_key(regclass), pulse_priv.org_merge_name(regclass) from public;

-- Move rows of p_from to p_to in one statement (so a record and the records that point at it move together), as the
-- tables' owner. p_keep: {table: [ctid, ...]} rows that stay; p_only: {table: [key, ...]} when only those rows move
-- (an undo). Lifts FORCE ROW LEVEL SECURITY and the user triggers of those tables for this transaction only, and puts
-- them back (checked). Returns {moved: {table: [key of each moved row]}, left: {table: rows of p_from still there}}.
create function pulse_priv.org_rows_move(p_from uuid, p_to uuid, p_tables regclass[], p_map jsonb, p_keep jsonb, p_only jsonb)
  returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare t regclass; nm text; trg record; parts text[] := '{}'; outs text[] := '{}'; n int := 0; sets text; res jsonb;
  off text[] := '{}'; left_over jsonb := '{}'::jsonb; k bigint;
begin
  if p_from is null or p_to is null or p_from = p_to then raise exception 'org_rows_move: two organisations' using errcode = '22023'; end if;
  foreach t in array p_tables loop
    nm := pulse_priv.org_merge_name(t);
    execute format('alter table %s no force row level security', t);
    for trg in select tgname from pg_trigger where tgrelid = t and not tgisinternal and tgenabled = 'O' loop
      execute format('alter table %s disable trigger %I', t, trg.tgname);
      off := off || format('alter table %s enable trigger %I', t, trg.tgname);
    end loop;
    n := n + 1;
    sets := pulse_priv.org_merge_set_list(t);
    parts := parts || format('m%s as (update %s t set org_id = $2%s where t.org_id = $3 and %s returning %s k)', n, t,
      case when sets = '' then '' else ', ' || sets end,
      case when p_only is null then format('not (t.ctid::text = any(array(select jsonb_array_elements_text(coalesce($4 -> %L, ''[]''::jsonb)))))', nm)
           else format('%s in (select value from jsonb_array_elements(coalesce($5 -> %L, ''[]''::jsonb)))', pulse_priv.org_merge_key(t), nm) end,
      pulse_priv.org_merge_key(t));
    outs := outs || format('%L, (select coalesce(jsonb_agg(k), ''[]''::jsonb) from m%s)', nm, n);
  end loop;
  if n = 0 then return jsonb_build_object('moved', '{}'::jsonb, 'left', '{}'::jsonb); end if;
  -- jsonb_build_object takes at most 100 arguments: build it in pieces.
  execute 'with ' || array_to_string(parts, ', ') || ' select ' ||
    (select string_agg('jsonb_build_object(' || array_to_string(outs[i:least(i + 49, n)], ', ') || ')', ' || ')
       from generate_series(1, n, 50) i)
    into res using p_map, p_to, p_from, coalesce(p_keep, '{}'::jsonb), coalesce(p_only, '{}'::jsonb);
  foreach t in array p_tables loop
    execute format('select count(*) from %s where org_id = $1', t) into k using p_from;
    if k > 0 then left_over := left_over || jsonb_build_object(pulse_priv.org_merge_name(t), k); end if;
  end loop;
  foreach sets in array off loop execute sets; end loop;
  foreach t in array p_tables loop execute format('alter table %s force row level security', t); end loop;
  if exists (select 1 from unnest(p_tables) x join pg_class c on c.oid = x where c.relrowsecurity and not c.relforcerowsecurity) then
    raise exception 'org_rows_move: row security was not put back' using errcode = 'XX000';
  end if;
  return jsonb_build_object('moved', res, 'left', left_over);
end $$;
revoke all on function pulse_priv.org_rows_move(uuid, uuid, regclass[], jsonb, jsonb, jsonb) from public;

-- The tenant tables (org_id) that hold rows of an organisation. A table whose row security for its owner is the plain
-- tenant rule is read inside the organisation; one with more (a rule per viewer, a restrictive rule) is read with
-- FORCE lifted for that one query, so no row is missed.
create function pulse_priv.org_tables_with_rows(p_org uuid) returns regclass[]
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare r record; out regclass[] := '{}'; has boolean; was text := coalesce(current_setting('pulse.org_id', true), '');
  wasv text := coalesce(current_setting('pulse.viewer_id', true), '');
begin
  perform set_config('pulse.org_id', p_org::text, true);
  perform set_config('pulse.viewer_id', '', true);
  for r in select c.oid::regclass t, c.relforcerowsecurity forced,
                  exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polcmd in ('*', 'r') and (0 = any(p.polroles) or c.relowner = any(p.polroles))
                            and (not p.polpermissive)) or not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polcmd in ('*', 'r')
                            and (0 = any(p.polroles) or c.relowner = any(p.polroles)) and p.polpermissive
                            and pg_get_expr(p.polqual, p.polrelid) in ('(org_id = pulse.current_org())', '(NOT (org_id IS DISTINCT FROM pulse.current_org()))')) unusual
             from pg_class c join pg_namespace s on s.oid = c.relnamespace
             join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
            where s.nspname in ('pulse', 'pulse_priv', 'privacy', 'memory') and c.relkind in ('r', 'p') and not c.relispartition
              and c.oid <> 'pulse_priv.org_merge'::regclass order by 1 loop
    if r.unusual and r.forced then execute format('alter table %s no force row level security', r.t); end if;
    execute format('select exists (select 1 from %s where org_id = $1)', r.t) into has using p_org;
    if r.unusual and r.forced then execute format('alter table %s force row level security', r.t); end if;
    if has then out := out || r.t; end if;
  end loop;
  perform set_config('pulse.org_id', was, true);
  perform set_config('pulse.viewer_id', wasv, true);
  return out;
end $$;
revoke all on function pulse_priv.org_tables_with_rows(uuid) from public;

-- ------------------------------------------------------------------------------------------------ the merge
create function pulse.org_merge_into_personal(p_org uuid, p_account uuid, p_actor text, p_words text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare
  o org%rowtype; a pulse_priv.pulse_account%rowtype; v_to uuid; s_person uuid; t_person uuid; tabs regclass[]; t regclass;
  m jsonb; keep jsonb := '{}'::jsonb; moved jsonb; ix record; xk text; pk text; pkcol text; hits record; pass int; grew boolean;
  v_merge uuid := gen_random_uuid(); counts jsonb := '{}'::jsonb; kept jsonb := '{}'::jsonb; n int; left_over int; nm text; res jsonb;
  -- The organisation's own identity and sign-ins stay with it; a personal space has no public card, listing or brand.
  stay_whole constant text[] := array['pulse.org_public_card', 'pulse.directory_entry', 'pulse.org_brand', 'pulse.org_domain',
    'pulse.org_pack', 'pulse.org_onboarding', 'pulse.onboarding_sort_receipt', 'pulse.tenant_setup'];
  -- The old seat's own rows (its roles, profile, status, photo, onboarding): the personal seat has its own.
  seat_rows constant text[] := array['pulse.role_assignment', 'pulse.people_profile', 'pulse.person_status', 'pulse.person_photo',
    'pulse_priv.person_onboarding', 'pulse.person_lifecycle', 'pulse.person_lifecycle_event', 'pulse_priv.hr_contact', 'pulse.onboarding_person'];
begin
  if p_actor is null or length(btrim(p_actor)) < 3 or p_words is null or length(btrim(p_words)) < 3 then
    raise exception 'Name who approved the merge and their words' using errcode = '22023';
  end if;
  select * into a from pulse_priv.pulse_account where id = p_account;
  if not found then raise exception 'No such Pulse account' using errcode = 'P0002'; end if;
  perform acct_enter(p_org, null);
  select * into o from org where id = p_org for update;
  if not found then raise exception 'No such organisation' using errcode = 'P0002'; end if;
  if o.status <> 'active' or o.kind <> 'company' then raise exception 'Only an active company is merged into a personal space' using errcode = '22023'; end if;
  if o.id = install_org() then raise exception 'The install''s own organisation is never merged' using errcode = '42501'; end if;
  select person_id into s_person from pulse_priv.account_member where account_id = p_account and member_org = p_org and kind = 'staff';
  if s_person is null then raise exception 'The account has no staff seat in that organisation' using errcode = '42501'; end if;
  if exists (select 1 from pulse_priv.account_member where member_org = p_org and account_id <> p_account and kind <> 'agent') then
    raise exception 'Other people sign in to that organisation: it is a company, not one person''s space' using errcode = '42501';
  end if;
  if exists (select 1 from client where org_id = p_org) then raise exception 'That organisation has clients: it is a company' using errcode = '42501'; end if;
  if exists (select 1 from person where org_id = p_org and side = 'staff' and status = 'active' and id <> s_person) then
    raise exception 'That organisation has other staff: it is a company' using errcode = '42501';
  end if;
  perform acct_leave();

  -- The personal space (made now when the person has none) and the person's seat in it.
  v_to := personal_workspace_ensure(p_account);
  select person_id into t_person from pulse_priv.account_member where account_id = p_account and member_org = v_to and kind = 'staff';
  if t_person is null then raise exception 'The personal space has no seat for the account' using errcode = 'XX000'; end if;
  -- A new space's deferred checks (its seat) run now: a table with pending trigger events cannot be altered below.
  set constraints all immediate;

  tabs := pulse_priv.org_tables_with_rows(p_org);
  m := jsonb_build_object(s_person::text, t_person::text, p_org::text, v_to::text);

  -- Read both organisations' rows of those tables for the comparisons below (this transaction only; org_rows_move puts
  -- FORCE back on every one of them).
  foreach t in array tabs loop execute format('alter table %s no force row level security', t); end loop;

  -- What stays: the person's old seat (their personal seat takes its place), the organisation's identity, its sign-ins
  -- except the person's own browser sign-in (that one follows them), and every row the personal space already has a copy
  -- of under a unique key (compared after the rewrite, until nothing new is found).
  execute 'select coalesce(jsonb_agg(ctid::text), ''[]'') from pulse.person where org_id = $1 and id = $2' into moved using p_org, s_person;
  keep := keep || jsonb_build_object('pulse.person', moved);
  foreach t in array tabs loop
    if pulse_priv.org_merge_name(t) = any(stay_whole) then
      execute format('select coalesce(jsonb_agg(ctid::text), ''[]'') from %s where org_id = $1', t) into moved using p_org;
      keep := keep || jsonb_build_object(pulse_priv.org_merge_name(t), moved);
    elsif pulse_priv.org_merge_name(t) = any(seat_rows) and exists (select 1 from pg_attribute where attrelid = t and attname = 'person_id' and not attisdropped) then
      execute format('select coalesce(jsonb_agg(ctid::text), ''[]'') from %s where org_id = $1 and person_id = $2', t) into moved using p_org, s_person;
      keep := keep || jsonb_build_object(pulse_priv.org_merge_name(t), moved);
    end if;
  end loop;
  if 'pulse.login_session'::regclass = any(tabs) then
    execute 'select coalesce(jsonb_agg(ctid::text), ''[]'') from pulse.login_session where org_id = $1
               and not (parent_hash is null and personal and revoked_at is null and native_device_id is null)' into moved using p_org;
    keep := keep || jsonb_build_object('pulse.login_session', moved);
  end if;
  for pass in 1..4 loop
    grew := false;
    foreach t in array tabs loop
      nm := pulse_priv.org_merge_name(t);
      continue when nm = any(stay_whole);
      select a2.attname into pkcol from pg_index i join pg_attribute a2 on a2.attrelid = i.indrelid and a2.attnum = i.indkey[0]
       where i.indrelid = t and i.indisprimary and i.indnkeyatts = 1 and format_type(a2.atttypid, null) = 'uuid';
      for ix in select i.indexrelid, i.indnkeyatts, i.indkey, pg_get_expr(i.indpred, i.indrelid) pred from pg_index i
                 where i.indrelid = t and i.indisunique and i.indisvalid loop
        -- A key is compared with the moving row's ids rewritten; org_id itself is left out (it is the same after the move).
        select string_agg(format('%s = p.k%s', case when k.attnum = 0 then format('(%s)', pg_get_indexdef(ix.indexrelid, k.n::int, true))
                 when format_type(a2.atttypid, null) = 'uuid' then format('pulse_priv.org_merge_uuid(x.%I, $3)', a2.attname)
                 else format('x.%I', a2.attname) end, k.n), ' and ' order by k.n),
               string_agg(case when k.attnum = 0 then format('(%s) k%s', pg_get_indexdef(ix.indexrelid, k.n::int, true), k.n)
                 else format('%I k%s', a2.attname, k.n) end, ', ' order by k.n)
          into xk, pk
          from unnest(ix.indkey[0:ix.indnkeyatts - 1]) with ordinality k(attnum, n)
          left join pg_attribute a2 on a2.attrelid = t and a2.attnum = k.attnum
         where coalesce(a2.attname, '') <> 'org_id';
        -- Only keys that can meet: ones with org_id, or with an id the move rewrites.
        continue when not exists (select 1 from unnest(ix.indkey[0:ix.indnkeyatts - 1]) k(attnum) join pg_attribute a3 on a3.attrelid = t and a3.attnum = k.attnum
                                   where a3.attname = 'org_id' or format_type(a3.atttypid, null) in ('uuid', 'uuid[]'));
        execute format('select coalesce(jsonb_agg(x.ctid::text), ''[]'') c, coalesce(jsonb_object_agg(x.pkv, p.pkv) filter (where x.pkv is not null), ''{}'') mp
            from (select ctid, %3$s pkv, * from %1$s where org_id = $1 %4$s) x
            join (select %3$s pkv%5$s from %1$s where org_id = $2 %4$s) p on %2$s
           where not (x.ctid::text = any(array(select jsonb_array_elements_text(coalesce($4 -> %6$L, ''[]''::jsonb)))))',
          t, coalesce(xk, 'true'), coalesce(quote_ident(pkcol) || '::text', 'null::text'),
          coalesce(' and (' || ix.pred || ')', ''), coalesce(', ' || pk, ''), nm)
          into hits using p_org, v_to, m, keep;
        if jsonb_array_length(hits.c) > 0 then
          keep := jsonb_set(keep, array[nm], coalesce(keep -> nm, '[]'::jsonb) || hits.c);
          m := m || hits.mp; grew := true;
        end if;
      end loop;
    end loop;
    exit when not grew;
  end loop;

  -- The move itself, then the check: every row of the organisation either moved or is one of the rows that stay.
  res := pulse_priv.org_rows_move(p_org, v_to, tabs, m, keep, null);
  moved := res -> 'moved';
  foreach t in array tabs loop
    nm := pulse_priv.org_merge_name(t);
    n := jsonb_array_length(coalesce(moved -> nm, '[]'::jsonb));
    left_over := coalesce((res -> 'left' ->> nm)::int, 0);
    if left_over <> jsonb_array_length(coalesce(keep -> nm, '[]'::jsonb)) then
      raise exception 'org_merge: % still has % rows of the organisation, % expected', nm, left_over, jsonb_array_length(coalesce(keep -> nm, '[]'::jsonb)) using errcode = 'XX000';
    end if;
    if n > 0 then counts := counts || jsonb_build_object(nm, n); end if;
    if left_over > 0 then kept := kept || jsonb_build_object(nm, left_over); end if;
  end loop;

  -- Anything switched on in either stays on in the personal space (Focus, the product map, Chats, Finance ...).
  perform acct_enter(p_org, null);
  create temp table if not exists org_merge_mods (module text, enabled boolean, doc jsonb) on commit drop;
  truncate org_merge_mods;
  insert into org_merge_mods select module, enabled, null from org_module where org_id = p_org;
  insert into org_merge_mods select null, null, body from tenant_config where org_id = p_org and doc_kind = 'tenant' and doc_key = 'modules' and is_active;
  -- The old organisation's sign-ins that stayed end now.
  update login_session set revoked_at = now() where org_id = p_org and revoked_at is null;
  perform set_config('pulse.actor_account', 'Pulse platform: ' || p_actor, true);
  update org set status = 'archived', merged_into = v_to where id = p_org;
  insert into audit_event(org_id, actor_id, actor_account, action, resource, resource_id, fields, source, changes)
  values (p_org, null, 'Pulse platform: ' || p_actor, 'org_merge.archived', 'org', p_org::text, '{}', 'pulse',
          jsonb_build_object('merge', v_merge, 'into', v_to, 'moved', counts, 'kept', kept, 'words', p_words));
  perform acct_leave();

  perform acct_enter(v_to, t_person);
  perform set_config('pulse.actor_account', 'Pulse platform: ' || p_actor, true);
  update org_module x set enabled = true from org_merge_mods y where x.org_id = v_to and x.module = y.module and y.enabled and not x.enabled;
  if exists (select 1 from org_merge_mods where doc is not null) and exists (select 1 from tenant_config where org_id = v_to and doc_kind = 'tenant' and doc_key = 'modules' and is_active) then
    update tenant_config c set body = jsonb_set(c.body, '{on}', (select coalesce(jsonb_agg(distinct e), '[]'::jsonb) from (
        select jsonb_array_elements_text(coalesce(c.body -> 'on', '[]'::jsonb)) e
        union select jsonb_array_elements_text(coalesce(y.doc -> 'on', '[]'::jsonb)) from org_merge_mods y where y.doc is not null) u
       where not coalesce(c.body -> 'off', '[]'::jsonb) ? e))
     where c.org_id = v_to and c.doc_kind = 'tenant' and c.doc_key = 'modules' and c.is_active;
  end if;
  insert into pulse_priv.org_merge(org_id, id, from_org, from_name, account_id, from_person, to_person, actor, words, moved, kept, moved_keys, id_map)
  values (v_to, v_merge, p_org, o.name, p_account, s_person, t_person, p_actor, p_words, counts, kept, moved, m);
  -- One note per kind of record that moved, in the personal space's Audit.
  insert into audit_event(org_id, actor_id, actor_account, action, resource, resource_id, fields, source, changes)
  select v_to, t_person, 'Pulse platform: ' || p_actor, 'org_merge.moved', k, v_merge::text, '{}', 'pulse',
         jsonb_build_object('from', p_org, 'fromName', o.name, 'rows', (counts ->> k)::int, 'keptThere', coalesce((kept ->> k)::int, 0))
    from jsonb_object_keys(counts) k;
  insert into audit_event(org_id, actor_id, actor_account, action, resource, resource_id, fields, source, changes)
  values (v_to, t_person, 'Pulse platform: ' || p_actor, 'org_merge_into_personal', 'org', p_org::text, '{}', 'pulse',
          jsonb_build_object('merge', v_merge, 'from', p_org, 'fromName', o.name, 'words', p_words));
  perform acct_leave();

  -- The account's own pointers at the old organisation now point at the personal space.
  update pulse_priv.pulse_account set last_org = v_to where id = p_account and last_org = p_org;
  update pulse_priv.account_profile set directory_org = case when directory_org = p_org then v_to else directory_org end,
         photo_from = case when photo_from = p_org then v_to else photo_from end
   where account_id = p_account and (directory_org = p_org or photo_from = p_org);
  return jsonb_build_object('merge', v_merge, 'from', p_org, 'fromName', o.name, 'to', v_to, 'fromPerson', s_person, 'toPerson', t_person,
    'moved', counts, 'kept', kept, 'rewritten', (select count(*) from jsonb_object_keys(m)));
end $$;
revoke all on function pulse.org_merge_into_personal(uuid, uuid, text, text) from public;

-- Put a merge back: the rows it moved go back to the organisation (ids rewritten back), the organisation is active
-- again. Records made in the personal space since then stay there.
create function pulse.org_merge_undo(p_merge uuid, p_actor text, p_words text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare g pulse_priv.org_merge%rowtype; sp uuid; inv jsonb; tabs regclass[]; back jsonb; counts jsonb := '{}'::jsonb; k text;
begin
  if p_actor is null or length(btrim(p_actor)) < 3 or p_words is null or length(btrim(p_words)) < 3 then
    raise exception 'Name who approved the undo and their words' using errcode = '22023';
  end if;
  -- Find the merge in whichever personal space it went to.
  for sp in select distinct o.merged_into from org o where o.merged_into is not null union select o.id from org o where o.kind = 'personal' loop
    perform set_config('pulse.org_id', sp::text, true);
    select * into g from pulse_priv.org_merge where id = p_merge;
    exit when g.id is not null;
  end loop;
  if g.id is null then raise exception 'No such merge' using errcode = 'P0002'; end if;
  if g.undone_at is not null then raise exception 'That merge was already put back' using errcode = '22023'; end if;
  select coalesce(jsonb_object_agg(value, key), '{}'::jsonb) into inv from jsonb_each_text(g.id_map);
  select coalesce(array_agg(key::regclass order by key), '{}') into tabs from jsonb_object_keys(g.moved_keys) key where jsonb_array_length(g.moved_keys -> key) > 0;
  -- The rows moved back are named by their key after the move; the move back rewrites ids the other way.
  back := pulse_priv.org_rows_move(g.org_id, g.from_org, tabs, inv, null, g.moved_keys) -> 'moved';
  for k in select jsonb_object_keys(back) loop counts := counts || jsonb_build_object(k, jsonb_array_length(back -> k)); end loop;
  perform acct_enter(g.from_org, null);
  perform set_config('pulse.actor_account', 'Pulse platform: ' || p_actor, true);
  update org set status = 'active', merged_into = null where id = g.from_org;
  insert into audit_event(org_id, actor_id, actor_account, action, resource, resource_id, fields, source, changes)
  values (g.from_org, null, 'Pulse platform: ' || p_actor, 'org_merge.undone', 'org', g.from_org::text, '{}', 'pulse',
          jsonb_build_object('merge', g.id, 'back', counts, 'words', p_words));
  perform acct_leave();
  perform acct_enter(g.org_id, null);
  update pulse_priv.org_merge set undone_at = now(), undone_by = p_actor where id = g.id;
  insert into audit_event(org_id, actor_id, actor_account, action, resource, resource_id, fields, source, changes)
  values (g.org_id, null, 'Pulse platform: ' || p_actor, 'org_merge.undone', 'org', g.from_org::text, '{}', 'pulse',
          jsonb_build_object('merge', g.id, 'back', counts, 'words', p_words));
  perform acct_leave();
  return jsonb_build_object('merge', g.id, 'org', g.from_org, 'from', g.org_id, 'back', counts);
end $$;
revoke all on function pulse.org_merge_undo(uuid, text, text) from public;

-- The platform tool names an organisation by its handle, slug or id (an active company only).
create function pulse.org_merge_find(p_ref text) returns uuid
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select id from org where status = 'active' and kind = 'company'
     and (id::text = lower(btrim(p_ref)) or lower(handle) = lower(btrim(p_ref)) or lower(slug) = lower(btrim(p_ref))) limit 1
$$;
revoke all on function pulse.org_merge_find(text) from public;

-- ------------------------------------------------------------------------------------------------ old links
-- An organisation the signed-in account was in that was merged into another of its spaces: where it is now.
create function pulse.account_org_redirect(p_ref text) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); r record; ref text := lower(btrim(coalesce(p_ref, '')));
begin
  if v is null or ref = '' then return null; end if;
  select f.id, t.id to_id, t.name, t.handle, t.kind into r from org f join org t on t.id = f.merged_into and t.status = 'active'
   where f.status = 'archived' and (f.id::text = ref or lower(f.handle) = ref)
     and exists (select 1 from pulse_priv.account_member m where m.account_id = v and m.member_org = f.id)
     and exists (select 1 from pulse_priv.account_member m where m.account_id = v and m.member_org = t.id)
   limit 1;
  if r.to_id is null then return null; end if;
  return jsonb_build_object('from', r.id, 'org', r.to_id, 'name', r.name, 'handle', r.handle, 'kind', r.kind);
end $$;
revoke all on function pulse.account_org_redirect(text) from public;
grant execute on function pulse.account_org_redirect(text) to pulse_api;

-- migrate:down
drop function if exists pulse.account_org_redirect(text);
drop function if exists pulse.org_merge_find(text);
drop function if exists pulse.org_merge_undo(uuid, text, text);
drop function if exists pulse.org_merge_into_personal(uuid, uuid, text, text);
drop function if exists pulse_priv.org_tables_with_rows(uuid);
drop function if exists pulse_priv.org_rows_move(uuid, uuid, regclass[], jsonb, jsonb, jsonb);
drop function if exists pulse_priv.org_merge_name(regclass);
drop function if exists pulse_priv.org_merge_key(regclass);
drop function if exists pulse_priv.org_merge_set_list(regclass);
drop function if exists pulse_priv.org_merge_texts(text[], jsonb);
drop function if exists pulse_priv.org_merge_text(text, jsonb);
drop function if exists pulse_priv.org_merge_uuids(uuid[], jsonb);
drop function if exists pulse_priv.org_merge_uuid(uuid, jsonb);
drop table if exists pulse_priv.org_merge;
alter table pulse.org drop constraint if exists org_merged_archived;
alter table pulse.org drop column if exists merged_into;
alter table pulse.org drop constraint org_status_check;
alter table pulse.org add constraint org_status_check check (status in ('setup', 'active', 'suspended', 'offboarding'));

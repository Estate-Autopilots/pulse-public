-- migrate:up
-- SAKOBE-MERGE (owner, 16 Nov 2026: an organisation that is one person's own freelancing work is to become their
-- personal space, all of it). A freelancer's own organisation has clients of its own; on the owner's word they are the
-- person's and move with them.
--
--  * pulse.org_merge_into_personal(org, account, actor, words, p_with_clients) is 2181's merge (same body, same checks)
--    with one more argument; 2181's four-argument function now calls it with false, so a call as before still refuses
--    any organisation with a client. Only with p_with_clients true (the platform tool's --with-clients, which also
--    needs the approver and their words) are the organisation's clients moved too, with everything that points at
--    them: their contacts, client projects, quotations and invoices, payments, shares, files and the rest (the same
--    one-statement move, ids kept). Additive: nothing is dropped, so older code keeps working (pulse-train's rule).
--  * Every other refusal stays: another person signs in, other staff, not an active company, the install's own. On the
--    client path two more: a client signs in to the organisation's portal (a live portal grant), or the organisation
--    is linked to another organisation (a connection or an invitation): someone else is involved, it is a company.
--  * On the client path nothing that belongs to a client stays behind: if a client, or a row that points at one, would
--    be kept because the personal space already has a copy under the same key, the merge raises and nothing moves.
--  * The merge record says whether clients moved (pulse_priv.org_merge.with_clients); pulse.org_merge_undo is
--    unchanged and puts the clients back with the rest (they are in the merge record's moved rows).
-- Nothing is sent to anyone.

alter table pulse_priv.org_merge add column with_clients boolean not null default false;

create function pulse.org_merge_into_personal(p_org uuid, p_account uuid, p_actor text, p_words text, p_with_clients boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare
  o org%rowtype; a pulse_priv.pulse_account%rowtype; v_to uuid; s_person uuid; t_person uuid; tabs regclass[]; t regclass;
  w_clients constant boolean := coalesce(p_with_clients, false); fk record;
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
  if exists (select 1 from client where org_id = p_org) then
    if not w_clients then raise exception 'That organisation has clients: it is a company' using errcode = '42501'; end if;
    -- The owner's freelancer path: the clients are the person's own. Still refused when someone on a client's side
    -- signs in (the portal) or the organisation is linked to another one (a connection or an invitation).
    if exists (select 1 from pulse_priv.portal_grant where org_id = p_org and active) then
      raise exception 'A client of that organisation signs in to its portal: it is a company' using errcode = '42501';
    end if;
    if exists (select 1 from pulse_priv.org_connection where p_org in (a_org, b_org))
       or exists (select 1 from pulse_priv.connect_request where from_org = p_org) then
      raise exception 'That organisation is linked to another organisation: it is a company' using errcode = '42501';
    end if;
  end if;
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

  -- With clients: every client, and every row that points at one, moves. None may stay behind as "the personal space
  -- already has a copy" (that would hand a client's record to another one): raise, and nothing moves.
  if w_clients then
    for fk in select c.conrelid::regclass t, a2.attname::text col from pg_constraint c
                join pg_attribute a2 on a2.attrelid = c.conrelid and a2.attnum = any(c.conkey) and a2.attname <> 'org_id'
               where c.contype = 'f' and c.confrelid = 'pulse.client'::regclass and c.conrelid::regclass = any(tabs)
              union all select 'pulse.client'::regclass, 'id' where 'pulse.client'::regclass = any(tabs) loop
      nm := pulse_priv.org_merge_name(fk.t);
      execute format('select count(*) from %s where org_id = $1 and %I is not null
                        and ctid::text = any(array(select jsonb_array_elements_text(coalesce($2 -> %L, ''[]''::jsonb))))', fk.t, fk.col, nm)
        into n using p_org, keep;
      if n > 0 then
        raise exception 'org_merge: % rows of % belong to a client and would stay behind; nothing was moved', n, nm using errcode = 'XX000';
      end if;
    end loop;
  end if;

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
  delete from org_merge_mods;
  insert into org_merge_mods select module, enabled, null from org_module where org_id = p_org;
  insert into org_merge_mods select null, null, body from tenant_config where org_id = p_org and doc_kind = 'tenant' and doc_key = 'modules' and is_active;
  -- The old organisation's sign-ins that stayed end now.
  update login_session set revoked_at = now() where org_id = p_org and revoked_at is null;
  perform set_config('pulse.actor_account', 'Pulse platform: ' || p_actor, true);
  update org set status = 'archived', merged_into = v_to where id = p_org;
  insert into audit_event(org_id, actor_id, actor_account, action, resource, resource_id, fields, source, changes)
  values (p_org, null, 'Pulse platform: ' || p_actor, 'org_merge.archived', 'org', p_org::text, '{}', 'pulse',
          jsonb_build_object('merge', v_merge, 'into', v_to, 'moved', counts, 'kept', kept, 'withClients', w_clients, 'words', p_words));
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
  insert into pulse_priv.org_merge(org_id, id, from_org, from_name, account_id, from_person, to_person, actor, words, moved, kept, moved_keys, id_map, with_clients)
  values (v_to, v_merge, p_org, o.name, p_account, s_person, t_person, p_actor, p_words, counts, kept, moved, m, w_clients);
  -- One note per kind of record that moved, in the personal space's Audit.
  insert into audit_event(org_id, actor_id, actor_account, action, resource, resource_id, fields, source, changes)
  select v_to, t_person, 'Pulse platform: ' || p_actor, 'org_merge.moved', k, v_merge::text, '{}', 'pulse',
         jsonb_build_object('from', p_org, 'fromName', o.name, 'rows', (counts ->> k)::int, 'keptThere', coalesce((kept ->> k)::int, 0))
    from jsonb_object_keys(counts) k;
  insert into audit_event(org_id, actor_id, actor_account, action, resource, resource_id, fields, source, changes)
  values (v_to, t_person, 'Pulse platform: ' || p_actor, 'org_merge_into_personal', 'org', p_org::text, '{}', 'pulse',
          jsonb_build_object('merge', v_merge, 'from', p_org, 'fromName', o.name, 'withClients', w_clients, 'words', p_words));
  perform acct_leave();

  -- The account's own pointers at the old organisation now point at the personal space.
  update pulse_priv.pulse_account set last_org = v_to where id = p_account and last_org = p_org;
  update pulse_priv.account_profile set directory_org = case when directory_org = p_org then v_to else directory_org end,
         photo_from = case when photo_from = p_org then v_to else photo_from end
   where account_id = p_account and (directory_org = p_org or photo_from = p_org);
  return jsonb_build_object('merge', v_merge, 'from', p_org, 'fromName', o.name, 'to', v_to, 'fromPerson', s_person, 'toPerson', t_person,
    'moved', counts, 'kept', kept, 'withClients', w_clients, 'rewritten', (select count(*) from jsonb_object_keys(m)));
end $$;
revoke all on function pulse.org_merge_into_personal(uuid, uuid, text, text, boolean) from public;

-- 2181's call, unchanged in what it does: an organisation with a client is refused.
create or replace function pulse.org_merge_into_personal(p_org uuid, p_account uuid, p_actor text, p_words text) returns jsonb
  language sql security definer set search_path = pulse, pg_temp as $$
  select pulse.org_merge_into_personal(p_org, p_account, p_actor, p_words, false)
$$;
revoke all on function pulse.org_merge_into_personal(uuid, uuid, text, text) from public;

-- migrate:down
-- Forward-only (pulse-migrate runs the up section only). By hand: re-run 2181's "create function
-- pulse.org_merge_into_personal(p_org uuid, p_account uuid, p_actor text, p_words text)" as "create or replace", then:
drop function if exists pulse.org_merge_into_personal(uuid, uuid, text, text, boolean);
alter table pulse_priv.org_merge drop column if exists with_clients;

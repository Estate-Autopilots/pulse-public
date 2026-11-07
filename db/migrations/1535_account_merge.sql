-- migrate:up
-- CONSOLIDATION (owner, 4 Nov 2026: every organisation on one Pulse at app.vitalsos.ai; "people who exist in several
-- places, e.g. Savuzo with several accounts and usernames, must be merged into ONE account with one username and seats
-- in each organisation"). Builds on ORG (0920), AUTH-UNIFY (1291) and ACCOUNT-CODE (1465). Three things:
--
--  1. pulse.handle_check(handle): the public "is this username free?" answer for the sign-up page. It says only
--     'available', 'taken' or 'invalid' (never whose it is, never an organisation or an e-mail). A handle kept as a
--     redirect after a merge is taken. The API rate-limits it per address (personal-accounts.ts).
--  2. pulse.account_merge_candidates(): the accounts that share one verified e-mail (1291's rule: the account's own
--     proven e-mail, a Google-linked identity, or the organisation's own Google Workspace directory; never a name, a
--     username or an unconfirmed e-mail), and the active people with that e-mail who have no account yet. Read only.
--  3. pulse.account_merge(keep, drop, handle, actor, same_org) and pulse.account_unmerge(record, actor): two accounts of
--     one human become one. Every seat of the dropped account moves to the kept one (a seat in an organisation where
--     the kept account already has one refuses, unless same_org = 'unlink': then the kept seat stays and the other
--     person stays in that organisation without an account, listed in the record). Every other row that points at the
--     dropped account (found from the catalogue, so later tables are covered) moves too; where the kept account already
--     has the same row (one profile, one per-app subject) the kept one stays and the other is listed. The username is
--     the one given (one of the two, or a free one); every handle either account had stays reserved and points at the
--     merged account (pulse_priv.handle_name), so @old still means this person. The record that comes back lists
--     exactly what moved (keys only, never a password hash or a code), and account_unmerge puts it back. Each
--     organisation the human has a seat in gets an audit row (account_merge / account_unmerge).
-- Owner-only: no runtime role may call the merge functions (tools/consolidate/pulse-accounts.py runs them as the
-- database owner, dry run by default). Safe on a live install: functions only; nothing changes until a merge is run.

-- ------------------------------------------------------------------------------------------------ the username check
create function pulse.handle_check(p_handle text) returns text
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare h text := lower(ltrim(btrim(coalesce(p_handle, '')), '@'));
begin
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then return 'invalid'; end if;
  if exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h)
     or exists (select 1 from pulse_priv.pulse_account where handle = h) then
    return 'taken';
  end if;
  return 'available';
end $$;
revoke all on function pulse.handle_check(text) from public;
grant execute on function pulse.handle_check(text) to pulse_api;

-- ------------------------------------------------------------------------------------------------ who is one human
create function pulse.account_merge_candidates() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o record; seen jsonb := '[]'; part jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('email', lower(btrim(a.email)), 'account', a.id, 'source', 'account')), '[]') into seen
    from pulse_priv.pulse_account a where a.email is not null and coalesce(a.email_verified_at, a.email_confirmed_at) is not null;
  for o in select id from org order by created_at, id loop
    perform acct_enter(o.id, null);
    select coalesce(jsonb_agg(x), '[]') into part from (
      select jsonb_build_object('email', lower(btrim(g.email)), 'org', o.id, 'person', g.person_id, 'account', am.account_id,
                                'source', 'google', 'active', p.status = 'active' and p.side in ('staff', 'freelancer')) x
        from pulse_priv.google_identity g join person p on p.id = g.person_id
        left join pulse_priv.account_member am on am.person_id = g.person_id
       where g.org_id = o.id
      union all
      select jsonb_build_object('email', lower(btrim(w.email)), 'org', o.id, 'person', pp.person_id, 'account', am.account_id,
                                'source', 'workspace', 'active', p.status = 'active' and p.side in ('staff', 'freelancer'))
        from pulse_priv.workspace_account w
        join people_profile pp on pp.org_id = o.id and lower(btrim(pp.email)) = lower(btrim(w.email))
        join person p on p.id = pp.person_id
        left join pulse_priv.account_member am on am.person_id = pp.person_id
       where w.org_id = o.id and not w.suspended) q;
    perform acct_leave();
    seen := seen || part;
  end loop;
  return coalesce((
    select jsonb_agg(g order by g ->> 'email') from (
      select jsonb_build_object(
        'email', s.email,
        'sources', (select jsonb_agg(distinct x ->> 'source') from jsonb_array_elements(seen) x where x ->> 'email' = s.email),
        'accounts', (select coalesce(jsonb_agg(jsonb_build_object(
              'id', a.id, 'handle', a.handle, 'created_at', a.created_at, 'password', a.password_hash is not null,
              'own_email', lower(btrim(coalesce(a.email, ''))) = s.email,
              'seats', (select coalesce(jsonb_agg(jsonb_build_object('org', m.member_org, 'person', m.person_id, 'kind', m.kind,
                          'last_used_at', m.last_used_at) order by m.joined_at), '[]') from pulse_priv.account_member m where m.account_id = a.id))
              order by a.created_at, a.id), '[]')
            from pulse_priv.pulse_account a
           where a.id in (select (x ->> 'account')::uuid from jsonb_array_elements(seen) x where x ->> 'email' = s.email and x ->> 'account' is not null)),
        'unlinked', (select coalesce(jsonb_agg(distinct jsonb_build_object('org', x ->> 'org', 'person', x ->> 'person')), '[]')
            from jsonb_array_elements(seen) x where x ->> 'email' = s.email and x ->> 'account' is null and (x ->> 'active')::boolean)) g
      from (select distinct x ->> 'email' email from jsonb_array_elements(seen) x) s) q
    where jsonb_array_length(g -> 'accounts') > 1
       or (jsonb_array_length(g -> 'accounts') + jsonb_array_length(g -> 'unlinked') > 1 and jsonb_array_length(g -> 'unlinked') > 0)), '[]');
end $$;
revoke all on function pulse.account_merge_candidates() from public;

-- ------------------------------------------------------------------------------------------------ merging
-- Columns that are never written into a merge record (a removed row of such a table is listed by key only).
create function pulse.acct_merge_secret_cols(p_rel regclass) returns text[]
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(array_agg(a.attname::text), '{}') from pg_attribute a
   where a.attrelid = p_rel and a.attnum > 0 and not a.attisdropped and a.attname ~ '(hash|secret|token|code|key)'
$$;

-- The tables (other than account_member) with a one-column foreign key to pulse_account, and whether they are
-- organisation tables (row security: written inside each organisation).
create function pulse.acct_merge_refs() returns table(rel regclass, tname text, col text, has_org boolean, pk text[])
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select con.conrelid::regclass, format('%I.%I', n.nspname, c.relname), a.attname::text,
         exists (select 1 from pg_attribute x where x.attrelid = con.conrelid and x.attname = 'org_id' and not x.attisdropped),
         (select array_agg(pa.attname::text order by k.ord) from pg_index i cross join lateral unnest(i.indkey) with ordinality k(n, ord)
            join pg_attribute pa on pa.attrelid = i.indrelid and pa.attnum = k.n where i.indrelid = con.conrelid and i.indisprimary)
    from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
   where con.contype = 'f' and con.confrelid = 'pulse_priv.pulse_account'::regclass and cardinality(con.conkey) = 1
     and con.conrelid <> 'pulse_priv.account_member'::regclass and con.conparentid = 0
   order by 2, 3
$$;

create function pulse.account_merge(p_keep uuid, p_drop uuid, p_handle text, p_actor text, p_same_org text default 'refuse')
  returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k pulse_priv.pulse_account%rowtype; d pulse_priv.pulse_account%rowtype; h text := lower(ltrim(btrim(coalesce(p_handle, '')), '@'));
  seats jsonb := '[]'; unlinked jsonb := '[]'; moved jsonb := '[]'; removed jsonb := '[]'; m record; f record; o record;
  uq record; orgs uuid[]; scope uuid; n bigint; keys jsonb; gone jsonb; secret text[]; cond text; other text[]; keyexpr text;
  handles text[]; rec jsonb; pw_moved boolean := false; email_moved boolean := false;
begin
  if p_same_org not in ('refuse', 'unlink') then raise exception 'account_merge: same_org is refuse or unlink' using errcode = '22023'; end if;
  if p_keep is null or p_drop is null or p_keep = p_drop then raise exception 'account_merge: two different accounts' using errcode = '22023'; end if;
  if coalesce(btrim(p_actor), '') = '' then raise exception 'account_merge: say who runs it (actor)' using errcode = '22023'; end if;
  select * into k from pulse_priv.pulse_account where id = p_keep for update;
  if not found then raise exception 'account_merge: no account %', p_keep using errcode = 'P0002'; end if;
  select * into d from pulse_priv.pulse_account where id = p_drop for update;
  if not found then raise exception 'account_merge: no account %', p_drop using errcode = 'P0002'; end if;
  if h = '' then h := k.handle; end if;
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then raise exception 'account_merge: % is not a handle', h using errcode = '22023'; end if;
  if h not in (k.handle, d.handle) and (exists (select 1 from org where handle = h)
       or exists (select 1 from pulse_priv.handle_name where handle = h and not (kind = 'person' and ref in (p_keep, p_drop)))) then
    raise exception 'account_merge: @% is taken', h using errcode = '23505';
  end if;
  select array_agg(handle order by created_at, handle) into handles from pulse_priv.handle_name where kind = 'person' and ref = p_drop;

  -- 1. Seats.
  for m in select * from pulse_priv.account_member where account_id = p_drop order by joined_at loop
    if exists (select 1 from pulse_priv.account_member where account_id = p_keep and member_org = m.member_org) then
      if p_same_org <> 'unlink' then
        raise exception 'account_merge: both accounts have a seat in organisation % (people % and %): decide which one stays, or same_org=unlink',
          m.member_org, (select person_id from pulse_priv.account_member where account_id = p_keep and member_org = m.member_org), m.person_id
          using errcode = '23505';
      end if;
      delete from pulse_priv.account_member where account_id = p_drop and member_org = m.member_org;
      unlinked := unlinked || jsonb_build_object('org', m.member_org, 'person', m.person_id, 'kind', m.kind,
                                                 'joined_at', m.joined_at, 'last_used_at', m.last_used_at);
    else
      update pulse_priv.account_member set account_id = p_keep where account_id = p_drop and member_org = m.member_org;
      seats := seats || jsonb_build_object('org', m.member_org, 'person', m.person_id);
    end if;
  end loop;

  -- 2. Everything else that points at the dropped account.
  select coalesce(array_agg(id order by created_at, id), '{}') into orgs from org;
  for f in select * from acct_merge_refs() loop
    secret := acct_merge_secret_cols(f.rel);
    -- How a moved row is found again (account_unmerge): its primary key; a row keyed by the account alone is the only one
    -- the kept account has; a table without a primary key, by its whole row (secrets left out).
    keyexpr := case when f.pk = array[f.col] then '''{}''::jsonb' when f.pk is null then 'to_jsonb(t) - $3::text[]'
                    else format('jsonb_build_object(%s)', (select string_agg(format('%L, t.%I', x, x), ', ') from unnest(f.pk) x)) end;
    foreach scope in array (case when f.has_org then orgs else array[null::uuid] end) loop
      if scope is not null then perform acct_enter(scope, null); end if;
      -- Where the kept account already has the same row (a unique key with this column), the kept one stays.
      for uq in select i.indexrelid, (select array_agg(att.attname::text order by z.ord) from unnest(i.indkey) with ordinality z(n, ord)
                  join pg_attribute att on att.attrelid = i.indrelid and att.attnum = z.n) cols
                  from pg_index i where i.indrelid = f.rel and i.indisunique loop
        if not f.col = any(uq.cols) then continue; end if;
        other := array_remove(uq.cols, f.col);
        cond := (select string_agg(format('k.%1$I = t.%1$I', x), ' and ') from unnest(other) x);
        execute format('with gone as (delete from %s as t where t.%I = $1 and exists (select 1 from %s k where k.%I = $2%s) returning t.*)
                        select count(*), coalesce(jsonb_agg(to_jsonb(gone) - $3::text[]), ''[]'') from gone',
                       f.tname, f.col, f.tname, f.col, case when cond is null then '' else ' and ' || cond end)
          into n, gone using p_drop, p_keep, secret;
        if n > 0 then
          removed := removed || jsonb_build_object('table', f.tname, 'column', f.col, 'org', scope, 'rows', gone,
                                                   'restorable', cardinality(secret) = 0);
        end if;
      end loop;
      execute format('with up as (update %s as t set %I = $1 where t.%I = $2 returning %s as key) select count(*), coalesce(jsonb_agg(key), ''[]'') from up',
                     f.tname, f.col, f.col, keyexpr)
        into n, keys using p_keep, p_drop, secret;
      if n > 0 then moved := moved || jsonb_build_object('table', f.tname, 'column', f.col, 'org', scope, 'keys', keys); end if;
      if scope is not null then perform acct_leave(); end if;
    end loop;
  end loop;

  -- 3. The account itself: one username, the e-mail and password it lacked, every old handle pointing here.
  rec := jsonb_build_object('drop_account', to_jsonb(d) - array['password_hash'], 'keep_before', to_jsonb(k) - array['password_hash']);
  pw_moved := k.password_hash is null and d.password_hash is not null;
  email_moved := k.email is null and d.email is not null;
  update pulse_priv.handle_name set ref = p_keep where kind = 'person' and ref = p_drop;
  delete from pulse_priv.pulse_account where id = p_drop;
  update pulse_priv.pulse_account set handle = h,
         email = coalesce(k.email, d.email),
         email_confirmed_at = case when k.email is null then d.email_confirmed_at else k.email_confirmed_at end,
         email_verified_at = case when k.email is null then d.email_verified_at else k.email_verified_at end,
         password_hash = coalesce(k.password_hash, d.password_hash),
         last_org = coalesce(k.last_org, d.last_org), failed = 0, locked_until = null, updated_at = now()
   where id = p_keep;
  if not exists (select 1 from pulse_priv.handle_name where handle = h) then
    insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', p_keep);
  end if;
  perform acct_event(p_keep, 'account_merged');
  rec := rec || jsonb_build_object('contract', 'pulse-account-merge.v1', 'keep', p_keep, 'drop', p_drop, 'handle', h,
    'handle_before', k.handle, 'drop_handles', coalesce(to_jsonb(handles), '[]'), 'seats', seats, 'unlinked', unlinked,
    'moved', moved, 'removed', removed, 'password_moved', pw_moved, 'email_moved', email_moved, 'actor', left(p_actor, 300), 'at', now());
  -- 4. An audit row in every organisation the human has a seat in (or had one, for an unlinked seat).
  for o in select distinct x.org from (select member_org org from pulse_priv.account_member where account_id = p_keep
                                       union select (u ->> 'org')::uuid from jsonb_array_elements(unlinked) u) x loop
    perform acct_enter(o.org, null);
    insert into audit_event(org_id, actor_account, action, resource, resource_id, source, changes)
    values (o.org, left(p_actor, 300), 'account_merge', 'account', p_keep::text, 'data-change',
            jsonb_build_object('kept', p_keep, 'merged', p_drop, 'handle', h, 'handle_before', k.handle,
                               'seats_moved', jsonb_array_length(seats), 'seats_unlinked', jsonb_array_length(unlinked)));
    perform acct_leave();
  end loop;
  return rec;
end $$;
revoke all on function pulse.account_merge(uuid, uuid, text, text, text), pulse.acct_merge_refs(), pulse.acct_merge_secret_cols(regclass) from public;

-- Put a merge back from its record: the dropped account (same id, handle, e-mail and password it had), its seats, its
-- handles and every row that moved. Rows the merge removed come back unless they held a secret (then they are listed).
create function pulse.account_unmerge(p_record jsonb, p_actor text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare keep uuid := (p_record ->> 'keep')::uuid; drp uuid := (p_record ->> 'drop')::uuid; e jsonb; r jsonb; key jsonb;
  n bigint; total bigint := 0; skipped jsonb := '[]'; o record; dacct pulse_priv.pulse_account%rowtype;
begin
  if p_record ->> 'contract' is distinct from 'pulse-account-merge.v1' then raise exception 'account_unmerge: not a merge record' using errcode = '22023'; end if;
  if coalesce(btrim(p_actor), '') = '' then raise exception 'account_unmerge: say who runs it (actor)' using errcode = '22023'; end if;
  if not exists (select 1 from pulse_priv.pulse_account where id = keep) then raise exception 'account_unmerge: the kept account % is gone', keep using errcode = 'P0002'; end if;
  if exists (select 1 from pulse_priv.pulse_account where id = drp) then raise exception 'account_unmerge: account % exists already', drp using errcode = '23505'; end if;
  perform 1 from pulse_priv.pulse_account where id = keep for update;
  dacct := jsonb_populate_record(null::pulse_priv.pulse_account, p_record -> 'drop_account');
  -- The kept account gets its own handle (and gives back the e-mail and password it took) before the other returns.
  update pulse_priv.pulse_account set handle = p_record #>> '{keep_before,handle}', updated_at = now() where id = keep;
  if (p_record ->> 'password_moved')::boolean then
    select password_hash into dacct.password_hash from pulse_priv.pulse_account where id = keep;
    update pulse_priv.pulse_account set password_hash = null where id = keep;
  end if;
  if (p_record ->> 'email_moved')::boolean then
    update pulse_priv.pulse_account set email = null, email_confirmed_at = null, email_verified_at = null where id = keep;
  end if;
  insert into pulse_priv.pulse_account select dacct.*;
  update pulse_priv.handle_name set ref = drp where kind = 'person' and handle in (select jsonb_array_elements_text(p_record -> 'drop_handles'));
  if p_record ->> 'handle' not in (p_record #>> '{keep_before,handle}', dacct.handle)
     and not exists (select 1 from pulse_priv.pulse_account where handle = p_record ->> 'handle') then
    delete from pulse_priv.handle_name where handle = p_record ->> 'handle' and kind = 'person' and ref = keep;
  end if;
  for e in select * from jsonb_array_elements(p_record -> 'seats') loop
    update pulse_priv.account_member set account_id = drp where account_id = keep and person_id = (e ->> 'person')::uuid;
  end loop;
  for e in select * from jsonb_array_elements(p_record -> 'unlinked') loop
    insert into pulse_priv.account_member(account_id, member_org, person_id, kind, joined_at, last_used_at)
    values (drp, (e ->> 'org')::uuid, (e ->> 'person')::uuid, e ->> 'kind', (e ->> 'joined_at')::timestamptz, (e ->> 'last_used_at')::timestamptz)
    on conflict do nothing;
  end loop;
  for e in select * from jsonb_array_elements(p_record -> 'moved') loop
    if e ->> 'org' is not null then perform acct_enter((e ->> 'org')::uuid, null); end if;
    for key in select * from jsonb_array_elements(e -> 'keys') loop
      execute format('update %s as t set %I = $1 where t.%I = $2 and to_jsonb(t) @> $3', e ->> 'table', e ->> 'column', e ->> 'column')
        using drp, keep, key - (e ->> 'column');
      get diagnostics n = row_count; total := total + n;
    end loop;
    if e ->> 'org' is not null then perform acct_leave(); end if;
  end loop;
  for e in select * from jsonb_array_elements(p_record -> 'removed') loop
    if not (e ->> 'restorable')::boolean then skipped := skipped || jsonb_build_object('table', e ->> 'table', 'rows', jsonb_array_length(e -> 'rows')); continue; end if;
    if e ->> 'org' is not null then perform acct_enter((e ->> 'org')::uuid, null); end if;
    for r in select * from jsonb_array_elements(e -> 'rows') loop
      execute format('insert into %s select * from jsonb_populate_record(null::%s, $1) on conflict do nothing', e ->> 'table', e ->> 'table') using r;
    end loop;
    if e ->> 'org' is not null then perform acct_leave(); end if;
  end loop;
  perform acct_event(keep, 'account_unmerged');
  perform acct_event(drp, 'account_unmerged');
  for o in select distinct member_org org from pulse_priv.account_member where account_id in (keep, drp) loop
    perform acct_enter(o.org, null);
    insert into audit_event(org_id, actor_account, action, resource, resource_id, source, changes)
    values (o.org, left(p_actor, 300), 'account_unmerge', 'account', keep::text, 'data-change',
            jsonb_build_object('kept', keep, 'restored', drp, 'handle', p_record #>> '{keep_before,handle}', 'restored_handle', dacct.handle));
    perform acct_leave();
  end loop;
  return jsonb_build_object('restored', drp, 'kept', keep, 'rows_moved_back', total, 'not_restored', skipped);
end $$;
revoke all on function pulse.account_unmerge(jsonb, text) from public;

-- migrate:down
drop function if exists pulse.account_unmerge(jsonb, text);
drop function if exists pulse.account_merge(uuid, uuid, text, text, text);
drop function if exists pulse.acct_merge_refs();
drop function if exists pulse.acct_merge_secret_cols(regclass);
drop function if exists pulse.account_merge_candidates();
drop function if exists pulse.handle_check(text);

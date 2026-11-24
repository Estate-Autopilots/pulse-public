-- migrate:up
-- LOGIN-MAIL-VITALS (owner, 23 Nov 2026 00:30 IST: "E-mail me a sign-in code" sent nothing): the owner typed his username.
-- His seat's only e-mail is admin@ (a shared mailbox), so the staff code (1449) refuses it (signin_code_refused), as
-- ACCOUNT-META (2125, the owner's rule) says. But the account code then also declined: acct_code_target returns null for
-- any name of this company's staff, leaving it to the staff code. So the username reached nobody, although the
-- account has a verified personal e-mail that the same code reaches when it is typed. Now a staff name whose staff code
-- has no address falls through to the account (the same match, delivery and checks as the @handle: acct_code_ok,
-- acct_code_delivery). A seat whose staff code has an address keeps the staff code, as before. Shared mailboxes still sign
-- nobody in. The API's answer and timing do not change.
create or replace function pulse.acct_code_target(p_login text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare l text := lower(btrim(coalesce(p_login, ''))); cand uuid[] := '{}'; x uuid[]; o record; e uuid; s uuid;
begin
  if l = '' or length(l) > 254 or mailbox_shared(l) then return null; end if;
  -- A name of this company's staff is the staff code's (1449), unless that code has nowhere to go (the seat's only
  -- e-mail is a shared mailbox, taken off by 2125): then it means the person's account, as their @handle does, and the
  -- code goes only where acct_code_delivery sends an account's code (a personal e-mail first; never a shared mailbox).
  s := auth_signin_code_actor('staff', l);
  if s is not null and coalesce(btrim(auth_delivery('staff', s)), '') <> '' then return null; end if;
  if position('@' in l) > 1 then return acct_by_signin_email(l); end if;
  select coalesce(array_agg(pa.id), '{}') into cand from pulse_priv.pulse_account pa where pa.handle = ltrim(l, '@');
  cand := cand || coalesce((select array_agg(h.ref) from pulse_priv.handle_name h join pulse_priv.pulse_account pa on pa.id = h.ref
                             where h.handle = ltrim(l, '@') and h.kind = 'person'), '{}');
  for o in select org.id from org where org.status = 'active' loop
    perform acct_enter(o.id, null);
    select coalesce(array_agg(distinct am.account_id), '{}') into x from people_profile pp
      join pulse_priv.account_member am on am.person_id = pp.person_id and am.member_org = o.id
     where pp.org_id = o.id and pp.username = l;
    perform acct_leave();
    cand := cand || x;
  end loop;
  select coalesce(array_agg(distinct u), '{}') into cand from unnest(cand) u;
  return case when cardinality(cand) = 1 then cand[1] end;
end $$;

-- migrate:down
create or replace function pulse.acct_code_target(p_login text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare l text := lower(btrim(coalesce(p_login, ''))); cand uuid[] := '{}'; x uuid[]; o record; e uuid;
begin
  if l = '' or length(l) > 254 or mailbox_shared(l) then return null; end if;
  if auth_signin_code_actor('staff', l) is not null then return null; end if;
  if position('@' in l) > 1 then return acct_by_signin_email(l); end if;
  select coalesce(array_agg(pa.id), '{}') into cand from pulse_priv.pulse_account pa where pa.handle = ltrim(l, '@');
  cand := cand || coalesce((select array_agg(h.ref) from pulse_priv.handle_name h join pulse_priv.pulse_account pa on pa.id = h.ref
                             where h.handle = ltrim(l, '@') and h.kind = 'person'), '{}');
  for o in select org.id from org where org.status = 'active' loop
    perform acct_enter(o.id, null);
    select coalesce(array_agg(distinct am.account_id), '{}') into x from people_profile pp
      join pulse_priv.account_member am on am.person_id = pp.person_id and am.member_org = o.id
     where pp.org_id = o.id and pp.username = l;
    perform acct_leave();
    cand := cand || x;
  end loop;
  select coalesce(array_agg(distinct u), '{}') into cand from unnest(cand) u;
  return case when cardinality(cand) = 1 then cand[1] end;
end $$;

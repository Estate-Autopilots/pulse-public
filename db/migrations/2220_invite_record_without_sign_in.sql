-- migrate:up
-- WL-ONBOARD-FIX (17 Nov 2026): Willow Lane's owner was added to the company's people (admin and leadership, for his
-- e-mail) before he had any way to sign in. Inviting that e-mail answered "member" and sent nothing: an active record with
-- the address counted as already in, though it has no Pulse account and no company sign-in, so the owner could never get
-- in. Such a record is now invited like anyone else; joining links it (1463 acct_join: the company's one record of the
-- invited e-mail that is not on an account), so the owner lands on it with its roles, history and pay data, never as a
-- second person. A record that can already sign in (a Pulse account, or a company sign-in of its own) stays "member".
-- Same patch pattern as 1351/1410/1690/2201.
do $$
declare src text; was text;
begin
  src := pg_get_functiondef('pulse.onboard_invites(jsonb)'::regprocedure); was := src;
  src := replace(src, $q$where pp.org_id = current_org() and lower(pp.email) = e and pe.status = 'active')$q$,
    $q$where pp.org_id = current_org() and lower(pp.email) = e and pe.status = 'active'
           and (exists (select 1 from pulse_priv.account_member am where am.person_id = pp.person_id)
             or exists (select 1 from account ac where ac.holder_person_id = pp.person_id and not coalesce(ac.is_shared, false))))$q$);
  if src = was then raise exception 'onboard_invites changed upstream: update 2220'; end if;
  execute src;
end $$;

-- migrate:down
do $$
declare src text;
begin
  src := pg_get_functiondef('pulse.onboard_invites(jsonb)'::regprocedure);
  execute replace(src, $q$where pp.org_id = current_org() and lower(pp.email) = e and pe.status = 'active'
           and (exists (select 1 from pulse_priv.account_member am where am.person_id = pp.person_id)
             or exists (select 1 from account ac where ac.holder_person_id = pp.person_id and not coalesce(ac.is_shared, false))))$q$,
    $q$where pp.org_id = current_org() and lower(pp.email) = e and pe.status = 'active')$q$);
end $$;

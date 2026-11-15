-- migrate:up
-- FEATURES-1024 / CONNECT 2 ("referral credit surfaced: who referred which organisation"): every client request that
-- brought an organisation or a person to Pulse (pulse_priv.org_referral, 0953), for the platform's leaders in Pulse HQ
-- (the same organisation licence_list allows, 0946/0949): who referred whom, whether a new organisation or account was
-- made, and whether they are still connected. Read only; only objects from this repository's migrations are used.
create function pulse.referral_list() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if not exists (select 1 from pulse.org o where o.id = current_org()
      and (o.handle = 'pulsehq' or (o.handle = 'estateautopilots' and not exists (select 1 from pulse.org p where p.handle = 'pulsehq')))) then
    raise exception 'Referrals are kept by the platform organisation' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'at', r.created_at, 'referrer', a.name, 'referrerHandle', a.handle,
      'referred', coalesce(b.name, acc.display_name), 'referredHandle', coalesce(b.handle, acc.handle), 'individual', r.referred_org is null,
      'newOrg', r.new_org, 'newAccount', r.new_account,
      'connected', exists (select 1 from pulse_priv.org_connection c where c.request_id = r.request_id and c.status = 'active')) order by r.created_at desc)
    from pulse_priv.org_referral r join pulse.org a on a.id = r.referrer_org
      left join pulse.org b on b.id = r.referred_org left join pulse_priv.pulse_account acc on acc.id = r.referred_account), '[]'::jsonb);
end $$;
revoke all on function pulse.referral_list() from public;
grant execute on function pulse.referral_list() to pulse_api;

-- migrate:down
-- Forward-only.

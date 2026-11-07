-- migrate:up
-- Active staff can recover before first activation, including the only admin.
-- Missing credentials are not disabled credentials; confirmed delivery, rate limits,
-- tenant isolation, single-use redemption and enrolled two-step factors still apply.
create or replace function pulse.auth_recover(r text,input text,k text,h text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a uuid; u text; d text; n int;
begin
 if r='staff' then
  select count(*),min(p.id::text)::uuid into n,a from person p join people_profile pp on pp.person_id=p.id left join login_credential lc on lc.org_id=p.org_id and lc.person_id=p.id
  where p.org_id=current_org() and p.status='active' and p.side='staff' and (lc.person_id is null or lc.status='active') and (pp.username=lower(trim(input)) or lower(auth_delivery(r,p.id))=lower(trim(input)));
 else
  select count(*),min(id::text)::uuid into n,a from pulse_priv.portal_principal where org_id=current_org() and active and (username=lower(trim(input)) or lower(auth_delivery(r,id))=lower(trim(input)));
 end if;
 if n<>1 then perform auth_event_add(r,null,'recovery_requested');return null;end if;
 if not auth_allow('recovery-account:'||r||':'||a,3) then return null;end if;
 d:=auth_delivery(r,a);
 if r='staff' then select username into u from people_profile where person_id=a;else select username into u from pulse_priv.portal_principal where id=a;end if;
 perform auth_event_add(r,a,'recovery_requested');
 if d is null or d='' then
  if r='staff' and k='reset' then perform login_forgot(u);elsif r='client' and k='reset' then perform portal_forgot(u);end if;return null;
 end if;
 if k='username' then return jsonb_build_object('username',u,'delivery',d,'actor',a);end if;
 return auth_link_make(r,a,'reset',h);
end $$;
-- migrate:down

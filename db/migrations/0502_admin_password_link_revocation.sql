-- migrate:up
-- Self-service recovery preserves invites; explicit admin replacement revokes every old password link.
do $$
declare definition text; marker text := $needle$  result:=auth_link_make(r,a,case when op='invite' then 'invite' else 'reset' end,b->>'hash');$needle$;
begin
 definition:=pg_get_functiondef('pulse.auth_admin(text,uuid,text,jsonb)'::regprocedure);
 if length(definition)-length(replace(definition,marker,''))<>length(marker) then
  raise exception 'auth_admin password-link branch changed shape';
 end if;
 -- auth_admin has already checked privileges/confirmation and acquired the account lock.
 execute replace(definition,marker,$fix$  update pulse_priv.auth_link set used_at=now()
   where org_id=current_org() and realm=r and actor=a and kind in('reset','invite') and used_at is null;
  if r='staff' then
   update pulse_priv.staff_invitation set token_hash=null,expires_at=null
    where org_id=current_org() and person_id=a and used_at is null;
  end if;
$fix$ || marker);
end $$;

-- migrate:up
-- A draft address never becomes a recovery destination until the existing confirmation flow completes.
alter table pulse_priv.auth_account add column pending_delivery text;

-- Serialize new address claims within a tenant; check again when a confirmation is redeemed.
create function pulse.auth_email_available(r text,a uuid,email text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare e text:=lower(trim(coalesce(email,'')));
begin
 if e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(e)>254 then raise exception 'Enter a valid email address' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('auth-email:'||current_org()::text,0));
 if r='staff' and (exists(select 1 from people_profile pp left join pulse_priv.hr_contact hc on hc.org_id=pp.org_id and hc.person_id=pp.person_id
   where pp.org_id=current_org() and pp.person_id<>a and (lower(pp.email)=e or lower(hc.personal_email)=e))
  or exists(select 1 from account where org_id=current_org() and lower(handle)=e and (is_shared or holder_person_id is distinct from a)))
  or exists(select 1 from pulse_priv.auth_account where org_id=current_org() and realm=r and actor<>a and (lower(delivery)=e or lower(pending_delivery)=e))
  or exists(select 1 from pulse_priv.auth_link where org_id=current_org() and realm=r and actor<>a and kind='email' and used_at is null and expires_at>now() and lower(delivery)=e)
  or r='client' and exists(select 1 from pulse_priv.portal_principal where org_id=current_org() and id<>a and lower(delivery_email)=e)
 then raise exception 'This address is already assigned. HR must confirm a unique address.' using errcode='22023';end if;
end $$;
revoke all on function pulse.auth_email_available(text,uuid,text) from public;

create function pulse.auth_admin_email(a uuid,op text,b jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare e text:=lower(trim(coalesce(b->>'email',''))); old_email text;
begin
 perform auth_manage('staff',a);
 perform auth_lock('staff',a);
 if op='email-state' then
  return jsonb_build_object('workEmail',(select email from people_profile where org_id=current_org() and person_id=a),
    'draftDelivery',(select pending_delivery from pulse_priv.auth_account where org_id=current_org() and realm='staff' and actor=a),
    'verifiedDelivery',(select delivery from pulse_priv.auth_account where org_id=current_org() and realm='staff' and actor=a),
    'emailPending',(select jsonb_build_object('email',delivery,'expiresAt',expires_at) from pulse_priv.auth_link where org_id=current_org() and realm='staff' and actor=a and kind='email' and used_at is null));
 end if;
 if op not in('email-work-save','email-delivery-save','email-delivery-verify') then raise exception 'Choose an email action' using errcode='22023';end if;
 if op='email-delivery-verify' then
  select pending_delivery into e from pulse_priv.auth_account where org_id=current_org() and realm='staff' and actor=a;
 end if;
 perform auth_email_available('staff',a,e);
 if op='email-work-save' then
  if length(e)>120 then raise exception 'Work email must be at most 120 characters' using errcode='22023';end if;
  select email into old_email from people_profile where org_id=current_org() and person_id=a for update;
  if not found then raise exception 'People profile required' using errcode='22023';end if;
  update people_profile set email=e,locked=array(select distinct unnest(locked||'email'::text)),updated_at=now() where org_id=current_org() and person_id=a;
  if old_email is distinct from e then
   insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values(current_org(),'person',a,'email',old_email,e,current_viewer());
   perform auth_event_add('staff',a,'work_email_saved');
  end if;
 elsif op='email-delivery-save' then
  insert into pulse_priv.auth_account(org_id,realm,actor,pending_delivery) values(current_org(),'staff',a,e)
   on conflict(org_id,realm,actor) do update set pending_delivery=excluded.pending_delivery;
  -- Invalidate a superseded confirmation, without creating an invitation or ending sessions.
  update pulse_priv.auth_link set used_at=now() where org_id=current_org() and realm='staff' and actor=a and kind='email' and used_at is null;
  perform auth_event_add('staff',a,'delivery_email_draft_saved');
 else
  -- Reuse username preparation, without creating credentials or a sign-in invitation.
  perform login_identity(a);
  return auth_link_make('staff',a,'email',b->>'hash',e);
 end if;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function pulse.auth_admin_email(uuid,text,jsonb) from public;
grant execute on function pulse.auth_admin_email(uuid,text,jsonb) to pulse_api;

create or replace function pulse.auth_link_make(r text,a uuid,k text,h text,email text default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare u text; d text; expiry timestamptz:=now()+case when k='invite' then interval '7 days' else interval '60 minutes' end;
begin
 perform auth_lock(r,a);
 if r not in('staff','client') or k not in('invite','reset','email') or h !~ '^[a-f0-9]{64}$' then raise exception 'Invalid link request' using errcode='22023';end if;
 if r='staff' then
  select pp.username into u from person p join people_profile pp on pp.person_id=p.id where p.org_id=current_org() and p.id=a and p.side='staff' and p.status='active' and not exists(select 1 from login_credential where person_id=a and status='disabled');
 else select username into u from pulse_priv.portal_principal where org_id=current_org() and id=a and active;
 end if;
 if u is null then raise exception 'Account is unavailable or disabled' using errcode='22023';end if;
 if k='email' then perform auth_email_available(r,a,email);end if;
 d:=coalesce(email,auth_delivery(r,a));
 if k in('reset','invite') then update pulse_priv.auth_link set used_at=now() where org_id=current_org() and realm=r and actor=a and kind in('reset','invite');end if;
 insert into pulse_priv.auth_link values(current_org(),r,a,k,h,expiry,null,email)
 on conflict(org_id,realm,actor,kind) do update set token_hash=h,expires_at=expiry,used_at=null,delivery=email;
 if r='staff' and k in('reset','invite') then update pulse_priv.staff_invitation set token_hash=null,expires_at=null where org_id=current_org() and person_id=a and used_at is null;end if;
 perform auth_event_add(r,a,case when email is not null then 'email_confirmation_requested' else k||'_link_issued' end);
 return jsonb_build_object('actor',a,'username',u,'delivery',d,'expiresAt',expiry);
end $$;
create or replace function pulse.auth_email_confirm(r text,h text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare l pulse_priv.auth_link%rowtype; old_email text;
begin
 select actor into l.actor from pulse_priv.auth_link where org_id=current_org() and realm=r and token_hash=h and kind='email';
 if l.actor is not null then perform auth_lock(r,l.actor);end if;
 select * into l from pulse_priv.auth_link where org_id=current_org() and realm=r and kind='email' and token_hash=h and used_at is null and expires_at>now() for update;
 if not found then return null;end if;
 if r='staff' and not exists(select 1 from person p where p.org_id=current_org() and p.id=l.actor and p.side='staff' and p.status='active' and not exists(select 1 from login_credential c where c.org_id=current_org() and c.person_id=p.id and c.status='disabled')) or r='client' and not exists(select 1 from pulse_priv.portal_principal where org_id=current_org() and id=l.actor and active) then return null;end if;
 perform auth_email_available(r,l.actor,l.delivery);
 old_email:=auth_delivery(r,l.actor);
 insert into pulse_priv.auth_account(org_id,realm,actor,delivery) values(current_org(),r,l.actor,l.delivery) on conflict(org_id,realm,actor) do update set delivery=excluded.delivery,pending_delivery=null;
 update pulse_priv.auth_link set used_at=now() where org_id=current_org() and realm=r and actor=l.actor and kind in('email','reset','invite');
 perform auth_event_add(r,l.actor,'delivery_email_changed');return jsonb_build_object('oldDelivery',old_email,'delivery',l.delivery,'actor',l.actor);
end $$;

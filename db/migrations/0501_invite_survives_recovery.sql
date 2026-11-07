-- migrate:up
-- Preserve fresh invites until successful password setting; retain same-kind rotation and expiry.
create or replace function pulse.auth_link_make(r text,a uuid,k text,h text,email text default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare u text; d text; expiry timestamptz:=now()+case when k='invite' then interval '7 days' when k='signin' then interval '15 minutes' else interval '60 minutes' end;
begin
 perform auth_lock(r,a);
 if r not in('staff','client') or k not in('invite','reset','email','signin') or h !~ '^[a-f0-9]{64}$' then raise exception 'Invalid link request' using errcode='22023';end if;
 if r='staff' then
  select pp.username into u from person p join people_profile pp on pp.person_id=p.id where p.org_id=current_org() and p.id=a and p.side='staff' and p.status='active' and not exists(select 1 from login_credential where person_id=a and status='disabled');
 else select username into u from pulse_priv.portal_principal where org_id=current_org() and id=a and active;
 end if;
 if u is null then raise exception 'Account is unavailable or disabled' using errcode='22023';end if;
 if k='email' then perform auth_email_available(r,a,email);end if;
 d:=coalesce(email,auth_delivery(r,a));
 -- The upsert rotates only the requested kind; requesting a reset preserves invitations.
 insert into pulse_priv.auth_link values(current_org(),r,a,k,h,expiry,null,email)
 on conflict(org_id,realm,actor,kind) do update set token_hash=h,expires_at=expiry,used_at=null,delivery=email;
 if r='staff' and k='invite' then update pulse_priv.staff_invitation set token_hash=null,expires_at=null where org_id=current_org() and person_id=a and used_at is null;end if;
 perform auth_event_add(r,a,case when email is not null then 'email_confirmation_requested' else k||'_link_issued' end);
 return jsonb_build_object('actor',a,'username',u,'delivery',d,'expiresAt',expiry);
end $$;

-- Legacy redemption must use the same account lock and consume coexisting password-setting links.
create or replace function pulse.invitation_redeem(p_hash text,p_password text) returns uuid language plpgsql security definer set search_path=pulse,public,pg_temp as $$
declare who uuid;
begin
 if octet_length(p_password) not between 10 and 72 then return null;end if;
 select person_id into who from pulse_priv.staff_invitation where org_id=current_org() and token_hash=p_hash;
 if who is null then return null;end if;
 perform auth_lock('staff',who);
 select i.person_id into who from pulse_priv.staff_invitation i join person p on p.id=i.person_id
 where i.org_id=current_org() and i.token_hash=p_hash and i.status in('sent','prepared') and i.used_at is null and i.expires_at>now() and p.status='active'
 and not exists(select 1 from login_credential where person_id=p.id and status='disabled') for update of i;
 if not found then return null;end if;
 if exists(select 1 from pulse_priv.auth_account where org_id=current_org() and realm='staff' and actor=who and totp is not null) then return null;end if;
 perform set_config('pulse.viewer_id',who::text,true);
 insert into login_credential(org_id,person_id,password_hash,must_change,status,issued_at)
 values(current_org(),who,crypt(p_password,gen_salt('bf',10)),false,'active',now())
 on conflict(person_id) do update set password_hash=excluded.password_hash,must_change=false,status='active',issued_at=now(),failed_attempts=0,locked_until=null;
 update login_session set revoked_at=now() where person_id=who and revoked_at is null;
 update pulse_priv.staff_invitation set status='used',used_at=now(),token_hash=null where person_id=who;
 update pulse_priv.auth_link set used_at=now() where org_id=current_org() and realm='staff' and actor=who and kind in('reset','invite');
 perform audit_write('password_set','staff_invitation',who::text);return who;
end $$;

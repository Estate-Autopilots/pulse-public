-- migrate:up
-- Invitation mail contains a single-use capability, never a password. Tokens are stored only as SHA-256 hashes.
create table pulse_priv.staff_invitation (
 org_id uuid not null references pulse.org(id), person_id uuid primary key references pulse.person(id) on delete cascade,
 batch_id uuid not null, recipient text, username text not null,
 status text not null check(status in('prepared','blocked','sending','sent','used','failed')),
 blocked_reason text, token_hash text unique, expires_at timestamptz, used_at timestamptz,
 prepared_by uuid references pulse.person(id), prepared_at timestamptz not null default now(), sent_at timestamptz
);
alter table pulse_priv.staff_invitation enable row level security;
alter table pulse_priv.staff_invitation force row level security;
create policy tenant_isolation on pulse_priv.staff_invitation using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
grant select,insert,update,delete on pulse_priv.staff_invitation to pulse_worker;

create function pulse.invitation_preview() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not viewer_is('admin','hr') or current_viewer() is null then raise exception 'HR or admin required' using errcode='42501';end if;
 perform audit_write('restricted_read','staff_invitations');
 return coalesce((select jsonb_agg(jsonb_build_object('personId',i.person_id,'name',p.display_name,'username',i.username,'recipient',i.recipient,'status',i.status,'reason',i.blocked_reason,'batchId',i.batch_id,'expiresAt',i.expires_at) order by p.display_name)
 from pulse_priv.staff_invitation i join person p on p.id=i.person_id where p.status='active'),'[]'::jsonb);
end $$;
create function pulse.invitation_prepare() returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare batch uuid:=gen_random_uuid();r record;email text;blocked text;
begin
 if not viewer_is('admin','hr') or current_viewer() is null then raise exception 'HR or admin required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtext('staff-invitation:'||current_org()));
 for r in select p.id,pp.email,pp.username from person p join people_profile pp on pp.person_id=p.id where p.side='staff' and p.status='active' loop
  perform login_identity(r.id);
  select pp.username,pp.email into r.username,email from people_profile pp where pp.person_id=r.id;
  if coalesce(email,'')='' and hr_can('hr.contact.read') then select personal_email into email from pulse_priv.hr_contact where person_id=r.id;end if;
  blocked:=null;
  if coalesce(email,'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then email:=null;blocked:='HR needs to confirm a delivery email';end if;
  if not viewer_is('admin') and exists(select 1 from role_assignment where person_id=r.id and role_key in('admin','leadership') and current_date between valid_from and coalesce(valid_to,'infinity')) then blocked:='An admin manages leadership invitations';end if;
  if exists(select 1 from login_credential where person_id=r.id and status='disabled') then blocked:='Sign-in is disabled; an admin must review it first';end if;
  insert into pulse_priv.staff_invitation(org_id,person_id,batch_id,recipient,username,status,blocked_reason,prepared_by)
  values(current_org(),r.id,batch,email,r.username,case when blocked is null then 'prepared' else 'blocked' end,blocked,current_viewer())
  on conflict(person_id) do update set batch_id=excluded.batch_id,recipient=excluded.recipient,username=excluded.username,status=excluded.status,blocked_reason=excluded.blocked_reason,prepared_by=excluded.prepared_by,prepared_at=now(),token_hash=null,expires_at=null
  where staff_invitation.status in('prepared','blocked','failed');
 end loop;
 perform audit_write('prepare','staff_invitations',batch::text);
 return batch;
end $$;
create function pulse.invitation_start(p_person uuid,p_batch uuid,p_hash text) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare email text;
begin
 if not viewer_is('admin','hr') or current_viewer() is null then raise exception 'HR or admin required' using errcode='42501';end if;
 if not viewer_is('admin') and exists(select 1 from role_assignment where person_id=p_person and role_key in('admin','leadership') and current_date between valid_from and coalesce(valid_to,'infinity')) then raise exception 'admin manages leadership credentials' using errcode='42501';end if;
 if p_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid token' using errcode='22023';end if;
 update pulse_priv.staff_invitation i set status='sending',token_hash=p_hash,expires_at=now()+interval '7 days'
 where i.person_id=p_person and batch_id=p_batch and status='prepared' and exists(select 1 from person where id=p_person and status='active')
 and not exists(select 1 from login_credential where person_id=p_person and status='disabled') returning recipient into email;
 if email is null then raise exception 'Invitation changed; preview it again' using errcode='40001';end if;
 perform audit_write('send_attempt','staff_invitation',p_person::text);return email;
end $$;
create function pulse.invitation_finish(p_person uuid,p_ok boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not viewer_is('admin','hr') or current_viewer() is null then raise exception 'HR or admin required' using errcode='42501';end if;
 update pulse_priv.staff_invitation set status=case when p_ok then 'sent' else 'failed' end,sent_at=case when p_ok then now() end,token_hash=case when p_ok then token_hash end where person_id=p_person and status='sending';
 perform audit_write(case when p_ok then 'send' else 'send_failed' end,'staff_invitation',p_person::text);
end $$;
create function pulse.invitation_redeem(p_hash text,p_password text) returns uuid language plpgsql security definer set search_path=pulse,public,pg_temp as $$
declare who uuid;
begin
 if octet_length(p_password) not between 10 and 72 then return null;end if;
 select i.person_id into who from pulse_priv.staff_invitation i join person p on p.id=i.person_id
 where i.org_id=current_org() and i.token_hash=p_hash and i.status='sent' and i.used_at is null and i.expires_at>now() and p.status='active'
 and not exists(select 1 from login_credential where person_id=p.id and status='disabled') for update of i;
 if not found then return null;end if;
 perform set_config('pulse.viewer_id',who::text,true);
 insert into login_credential(org_id,person_id,password_hash,must_change,status,issued_at)
 values(current_org(),who,crypt(p_password,gen_salt('bf',10)),false,'active',now())
 on conflict(person_id) do update set password_hash=excluded.password_hash,must_change=false,status='active',issued_at=now(),failed_attempts=0,locked_until=null;
 update login_session set revoked_at=now() where person_id=who and revoked_at is null;
 update pulse_priv.staff_invitation set status='used',used_at=now(),token_hash=null where person_id=who;
 perform audit_write('password_set','staff_invitation',who::text);return who;
end $$;
revoke all on function pulse.invitation_preview(),pulse.invitation_prepare(),pulse.invitation_start(uuid,uuid,text),pulse.invitation_finish(uuid,boolean),pulse.invitation_redeem(text,text) from public;
grant execute on function pulse.invitation_preview(),pulse.invitation_prepare(),pulse.invitation_start(uuid,uuid,text),pulse.invitation_finish(uuid,boolean),pulse.invitation_redeem(text,text) to pulse_api;
-- migrate:down

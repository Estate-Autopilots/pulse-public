-- migrate:up
-- A public directory is distinct from personal work. Managers/PGS need explicit role/unit assignments.
alter table pulse.people_profile add column pulse_id text generated always as ('PLS-'||lpad(user_no::text,6,'0')) stored;
create function pulse.person_work_access(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer()=p_person or viewer_is('admin','leadership') or manages(p_person)
$$;
create or replace function pulse.manages(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and p_person<>current_viewer() and (
 exists(select 1 from people_profile where person_id=p_person and manager_id=current_viewer()) or
 exists(select 1 from role_assignment r join unit u on u.id=r.unit_id join people_profile target on target.person_id=p_person
 where r.person_id=current_viewer() and (r.is_manager_of_unit or r.role_key in('manager','pgs','head_pgs'))
 and current_date between r.valid_from and coalesce(r.valid_to,'infinity') and u.valid_to is null and target.pod=u.name))
$$;
create function pulse.work_project(p_project uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select viewer_is('admin','leadership') or exists(select 1 from project pr join role_assignment r on r.unit_id=pr.unit_id
 where pr.id=p_project and r.person_id=current_viewer() and (r.is_manager_of_unit or r.role_key in('manager','pgs','head_pgs')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity'))
 or exists(select 1 from task t where t.project_id=p_project and (t.owner_id=current_viewer() or t.assignee_person_id=current_viewer() or manages(t.owner_id)))
 or exists(select 1 from delivery d join delivery_actor a using(org_id,file_id) where d.project_id=p_project and (a.actor_id=current_viewer() or manages(a.actor_id)))
$$;
-- Avoid work_project -> task RLS recursion by not invoking work_project in the task policy.
drop policy task_person on pulse.task;
create policy task_person on pulse.task as restrictive for select to pulse_api using(
 pulse.viewer_is('admin','leadership') or owner_id=pulse.current_viewer() or assignee_person_id=pulse.current_viewer() or pulse.manages(owner_id) or
 exists(select 1 from pulse.project pr join pulse.role_assignment r on r.unit_id=pr.unit_id where pr.id=task.project_id and r.person_id=pulse.current_viewer() and (r.is_manager_of_unit or r.role_key in('manager','pgs','head_pgs')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity')));
create or replace function pulse.delivery_matches(p_file text,p_scope text) returns boolean language sql stable security invoker set search_path=pulse,pg_temp as $$
 select p_scope is null or case when p_scope like 'person:%' then
 exists(select 1 from delivery_actor a where a.file_id=p_file and a.actor_id=nullif(substr(p_scope,8),'')::uuid)
 when p_scope like 'team:%' then exists(select 1 from delivery d where d.file_id=p_file and work_project(d.project_id))
 else exists(select 1 from delivery d where d.file_id=p_file and d.uploader_account=p_scope) end
$$;
-- HR receives payroll and people data by role. Leadership receives company and financial data by role.
-- Admins keep the previous named grants so an operational admin is not silently given salary or finance.
create or replace function pulse.hr_can(p_permission text) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select p_permission=any(array['hr.salary.read','hr.salary.write','hr.contact.read','hr.contact.write','hr.documents.read']) and
 (viewer_is('hr','leadership') or viewer_is('admin') and exists(select 1 from sensitive_permission where person_id=current_viewer() and permission=p_permission and revoked_at is null))
$$;
create or replace function pulse.money_can(p_permission text) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select p_permission=any(array['money.read','money.amount.read','money.plan.write']) and (viewer_is('leadership') or viewer_is('admin') and exists(select 1 from money_permission where person_id=current_viewer() and permission=p_permission and revoked_at is null))
$$;
-- Include leadership in the existing HR rows' policies, without granting them organisation-admin role controls.
do $$ declare t text; pol record; begin
 for pol in select schemaname,tablename,policyname,cmd,qual,with_check from pg_policies where schemaname='pulse' and
 (qual like '%viewer_is%admin%hr%' or with_check like '%viewer_is%admin%hr%') loop
 execute format('alter policy %I on %I.%I %s %s',pol.policyname,pol.schemaname,pol.tablename,
 case when pol.qual is not null then 'using ('||replace(pol.qual,'ARRAY[''admin''::text, ''hr''::text]','ARRAY[''admin''::text, ''hr''::text, ''leadership''::text]')||')' else '' end,
 case when pol.with_check is not null then 'with check ('||replace(pol.with_check,'ARRAY[''admin''::text, ''hr''::text]','ARRAY[''admin''::text, ''hr''::text, ''leadership''::text]')||')' else '' end);
 end loop;
end $$;
create function pulse.login_identity(p_person uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n int; base text; uname text; suffix int:=1; who person%rowtype; profile people_profile%rowtype; words text[];
begin
 if not viewer_is('admin','hr') then raise exception 'HR or admin required' using errcode='42501'; end if;
 select * into who from person where id=p_person and side='staff' and status='active';if not found then raise exception 'active person required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtext('staff-identity:'||current_org()::text));
 select * into profile from people_profile where person_id=p_person for update;
 if not found then raise exception 'People profile required' using errcode='22023'; end if;
 n:=profile.user_no;if n is null then select coalesce(max(user_no),0)+1 into n from people_profile;end if;
 uname:=profile.username;
 if uname is null then
 words:=regexp_split_to_array(trim(lower(regexp_replace(who.display_name,'[^a-zA-Z0-9 ]','','g'))),'\s+');
 base:=left(coalesce(nullif(words[1],''),'person')||'.'||coalesce(nullif(words[array_length(words,1)],''),'staff'),32);uname:=base;
 while exists(select 1 from people_profile where username=uname) loop suffix:=suffix+1;uname:=base||'.'||suffix;end loop;
 end if;
 update people_profile set user_no=n,username=uname where person_id=p_person and (user_no is distinct from n or username is distinct from uname);
end $$;
create or replace function pulse.login_issue(p_person uuid,p_password text) returns void language plpgsql security definer set search_path=pulse,public,pg_temp as $$
begin
 if not viewer_is('admin','hr') or current_viewer() is null then raise exception 'HR or admin required' using errcode='42501';end if;
 if not viewer_is('admin') and exists(select 1 from role_assignment where person_id=p_person and role_key in('admin','leadership') and current_date between valid_from and coalesce(valid_to,'infinity')) then raise exception 'admin manages leadership credentials' using errcode='42501';end if;
 if octet_length(p_password) not between 10 and 72 then raise exception 'password length invalid' using errcode='22023'; end if;
 perform login_identity(p_person);
 insert into login_credential(org_id,person_id,password_hash,issued_by) values(current_org(),p_person,crypt(p_password,gen_salt('bf',10)),current_viewer())
 on conflict(person_id) do update set password_hash=excluded.password_hash,must_change=true,status='active',issued_by=excluded.issued_by,issued_at=now(),failed_attempts=0,locked_until=null;
 update login_session set revoked_at=now() where person_id=p_person and revoked_at is null;
 update password_reset_request set status='resolved',resolved_by=current_viewer(),resolved_at=now() where person_id=p_person and status='pending';
 perform audit_write('invite','person',p_person::text,array['username','one_time_password']);
end $$;
create or replace function pulse.login_disable(p_person uuid) returns void language plpgsql security definer set search_path=pulse,public,pg_temp as $$
begin
 if not viewer_is('admin','hr') or current_viewer()=p_person then raise exception 'HR/admin required; cannot disable yourself' using errcode='42501';end if;
 if not viewer_is('admin') and exists(select 1 from role_assignment where person_id=p_person and role_key in('admin','leadership') and current_date between valid_from and coalesce(valid_to,'infinity')) then raise exception 'admin manages leadership credentials' using errcode='42501';end if;
 update login_credential set status='disabled' where person_id=p_person;
 update login_session set revoked_at=now() where person_id=p_person and revoked_at is null;
end $$;
-- Issued passwords expire after seven days, and cannot be chosen as the person's new password.
create or replace function pulse.login_verify(p_username text,p_password text) returns table(person_id uuid,must_change boolean)
 language plpgsql security definer set search_path=pulse,public,pg_temp as $$
declare cred login_credential%rowtype;
begin
 select lc.* into cred from login_credential lc join people_profile pp on pp.person_id=lc.person_id join person p on p.id=lc.person_id
 where pp.username=lower(trim(p_username)) and lc.status='active' and p.status='active' and p.side='staff' for update of lc;
 if not found or octet_length(p_password)>72 then perform crypt(left(p_password,72),gen_salt('bf',10));return;end if;
 if cred.locked_until>now() or cred.must_change and cred.issued_at<now()-interval '7 days' then return;end if;
 if cred.password_hash=crypt(p_password,cred.password_hash) then
 update login_credential set failed_attempts=0,locked_until=null,last_login_at=now() where login_credential.person_id=cred.person_id;
 return query select cred.person_id,cred.must_change;
 else
 update login_credential set failed_attempts=case when cred.failed_attempts>=4 then 0 else cred.failed_attempts+1 end,locked_until=case when cred.failed_attempts>=4 then now()+interval '15 minutes' end where login_credential.person_id=cred.person_id;
 end if;
end $$;
create or replace function pulse.login_change(p_old text,p_new text) returns boolean language plpgsql security definer set search_path=pulse,public,pg_temp as $$
declare cred login_credential%rowtype;
begin
 if octet_length(p_new) not between 10 and 72 or p_old=p_new then raise exception 'choose a different password of 10 to 72 bytes' using errcode='22023';end if;
 select * into cred from login_credential where person_id=current_viewer() and status='active' for update;
 if not found or cred.password_hash<>crypt(p_old,cred.password_hash) then return false;end if;
 update login_credential set password_hash=crypt(p_new,gen_salt('bf',10)),must_change=false where person_id=cred.person_id;return true;
end $$;
create function pulse.offboard_access() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.status is distinct from old.status and new.status<>'active' then
 update login_credential set status='disabled' where person_id=new.id;
 update login_session set revoked_at=now() where person_id=new.id and revoked_at is null;
 delete from chat_member where person_id=new.id;
 perform audit_write('deactivate','person',new.id::text,array['sessions','chats','username']);
 end if;return null;
end $$;
create trigger offboard_access after update of status on pulse.person for each row execute function pulse.offboard_access();
drop policy credential_visible on pulse.login_credential;
create policy credential_visible on pulse.login_credential as restrictive for select to pulse_api using(person_id=pulse.current_viewer() or pulse.viewer_is('admin','hr'));
drop policy reset_admin on pulse.password_reset_request;
create policy reset_admin on pulse.password_reset_request as restrictive to pulse_api using(pulse.viewer_is('admin','hr')) with check(pulse.viewer_is('admin','hr'));
drop policy role_grant on pulse.role_assignment;
create policy role_grant on pulse.role_assignment as restrictive for insert to pulse_api with check(pulse.viewer_is('admin') and role_key in('admin','hr','leadership','manager','pgs','head_pgs'));
drop policy role_end on pulse.role_assignment;
create policy role_end on pulse.role_assignment as restrictive for update to pulse_api using(pulse.viewer_is('admin') and role_key in('admin','hr','leadership','manager','pgs','head_pgs')) with check(pulse.viewer_is('admin'));
revoke all on function pulse.person_work_access(uuid),pulse.work_project(uuid),pulse.login_identity(uuid),pulse.offboard_access() from public;
grant execute on function pulse.person_work_access(uuid),pulse.work_project(uuid),pulse.login_identity(uuid) to pulse_api;
-- migrate:down

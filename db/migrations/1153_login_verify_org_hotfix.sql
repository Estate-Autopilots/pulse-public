-- migrate:up
-- AUTH-UNIFY hotfix (27 Oct 2026): a staff password is checked only against the credential of the organisation the
-- sign-in runs in. pulse.google_password_verify (0645, called by login_verify and auth_login) found the credential by
-- username alone; row-level security on login_credential already keeps it to current_org(), but the same username in
-- two organisations (one person in Estate Autopilots and Atlas Crest) must never depend on that: both the
-- credential and the profile are now filtered by the organisation explicitly. Same signature, same answers otherwise.
create or replace function pulse.google_password_verify(p_username text, p_password text)
 returns table(person_id uuid, must_change boolean)
 language plpgsql security definer set search_path to 'pulse', 'public', 'pg_temp' as $function$
declare cred login_credential%rowtype;
begin
 if current_org() is null then perform crypt(left(p_password,72),gen_salt('bf',10)); return; end if;
 select lc.* into cred from login_credential lc join people_profile pp on pp.person_id=lc.person_id and pp.org_id=lc.org_id
   join person p on p.id=lc.person_id and p.org_id=lc.org_id
 where lc.org_id=current_org() and pp.org_id=current_org() and pp.username=lower(trim(p_username))
   and lc.status='active' and p.status='active' and p.side='staff' for update of lc;
 if not found or octet_length(p_password)>72 then perform crypt(left(p_password,72),gen_salt('bf',10));return;end if;
 if cred.locked_until>now() or cred.must_change and cred.issued_at<now()-interval '7 days' then perform crypt(left(p_password,72),gen_salt('bf',10));return;end if;
 if cred.password_hash=crypt(p_password,cred.password_hash) then
 update login_credential set failed_attempts=0,locked_until=null,last_login_at=now() where login_credential.person_id=cred.person_id and login_credential.org_id=current_org();
 return query select cred.person_id,cred.must_change;
 else
 update login_credential set failed_attempts=case when cred.failed_attempts>=4 then 0 else cred.failed_attempts+1 end,locked_until=case when cred.failed_attempts>=4 then now()+interval '15 minutes' end where login_credential.person_id=cred.person_id and login_credential.org_id=current_org();
 end if;
end $function$;
revoke all on function pulse.google_password_verify(text,text) from public, pulse_api;

-- migrate:down
create or replace function pulse.google_password_verify(p_username text, p_password text)
 returns table(person_id uuid, must_change boolean)
 language plpgsql security definer set search_path to 'pulse', 'public', 'pg_temp' as $function$
declare cred login_credential%rowtype;
begin
 select lc.* into cred from login_credential lc join people_profile pp on pp.person_id=lc.person_id join person p on p.id=lc.person_id
 where pp.username=lower(trim(p_username)) and lc.status='active' and p.status='active' and p.side='staff' for update of lc;
 if not found or octet_length(p_password)>72 then perform crypt(left(p_password,72),gen_salt('bf',10));return;end if;
 if cred.locked_until>now() or cred.must_change and cred.issued_at<now()-interval '7 days' then perform crypt(left(p_password,72),gen_salt('bf',10));return;end if;
 if cred.password_hash=crypt(p_password,cred.password_hash) then
 update login_credential set failed_attempts=0,locked_until=null,last_login_at=now() where login_credential.person_id=cred.person_id;
 return query select cred.person_id,cred.must_change;
 else
 update login_credential set failed_attempts=case when cred.failed_attempts>=4 then 0 else cred.failed_attempts+1 end,locked_until=case when cred.failed_attempts>=4 then now()+interval '15 minutes' end where login_credential.person_id=cred.person_id;
 end if;
end $function$;

-- migrate:up
-- SHIP-2 (owner, 25 Oct 2026; OPS-1025 gap): "Bank details for X were changed by HR. Check them" also reaches the
-- people who hold the right to check them, not only the HR role. pulse.bank_confirm lets anyone passing identity_hr()
-- check details (the HR role, or an admin or leader holding hr.documents.read), but bank_checkers() (0211), which
-- bank_save (1002) tells, returned the HR role only, and notification_recipient_allowed let people.bank reach the HR
-- role only: with a one-person HR team, details HR entered were announced to nobody.
--  * pulse.bank_checker(p): identity_hr()'s rule (0149) for any person; keep the two in step. bank_checkers() lists
--    them and people.bank may reach exactly them, so the admins and leaders who can check are told too. bank_save still
--    leaves out the person and whoever made the change.
--  * bank_state's canCheck leaves out whoever entered the details, as bank_confirm does since 1002 (HR saw "Mark as
--    checked" on their own entry and was refused).
-- Who may see, change or check bank details is untouched. Additive: one new function, three bodies.
create function pulse.bank_checker(p_who uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select p_who is not null and exists(select 1 from person where org_id=current_org() and id=p_who and status='active')
  and exists(select 1 from role_assignment r where r.org_id=current_org() and r.person_id=p_who
   and current_date between r.valid_from and coalesce(r.valid_to,'infinity')
   and (r.role_key='hr' or r.role_key in ('admin','leadership') and exists(select 1 from sensitive_permission s
    where s.org_id=current_org() and s.person_id=p_who and s.permission='hr.documents.read' and s.revoked_at is null)))
$$;
revoke all on function pulse.bank_checker(uuid) from public;

create or replace function pulse.bank_checkers() returns setof uuid
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select distinct r.person_id from role_assignment r
 where r.org_id=current_org() and r.role_key in ('hr','admin','leadership') and current_date between r.valid_from and coalesce(r.valid_to,'infinity')
  and bank_checker(r.person_id)
$$;

do $$
declare definition text; changed text;
begin
 definition:=pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
 changed:=replace(definition,' elsif p_type=''people.bank'' then
  return p_subject=''person'' and p_id<>p_person and exists(select 1 from role_assignment where org_id=current_org() and person_id=p_person and role_key=''hr'' and current_date between valid_from and coalesce(valid_to,''infinity''));',
 ' elsif p_type=''people.bank'' then
  -- 1026: whoever may check bank details (bank_checker: the HR role, or an admin or leader holding hr.documents.read).
  return p_subject=''person'' and p_id<>p_person and bank_checker(p_person);');
 if changed=definition then raise exception 'notification_recipient_allowed changed shape'; end if;
 execute changed;
end $$;

-- pulse.bank_state: the repository's definition (0211_my_info_bank.sql), with the change marked 1026.
create or replace function pulse.bank_state(p_person uuid) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare o pulse_priv.person_onboarding; self boolean;
begin
 if not bank_can_see(p_person) then raise exception 'Bank details are for the person and HR' using errcode='42501'; end if;
 self:=p_person=current_viewer();
 select * into o from pulse_priv.person_onboarding where org_id=current_org() and person_id=p_person;
 if not self and o.bank is not null then perform hr_log(p_person,'onboarding.bank','hr_profile_view'); end if;
 return jsonb_build_object('masked',o.bank_masked,'summary',o.bank_summary,'status',case when o.bank is null then 'missing' else coalesce(o.bank_status,'pending') end,
  'source',o.bank_source,'updatedAt',o.bank_updated_at,'updatedBy',(select display_name from person where id=o.bank_updated_by),
  'checkedAt',o.bank_checked_at,'checkedBy',(select display_name from person where id=o.bank_checked_by),
  -- 1026: never whoever entered them (bank_confirm, 1002).
  'canEdit',bank_can_write(p_person),'canCheck',identity_hr() and not self and o.bank is not null and coalesce(o.bank_status,'pending')='pending'
   and o.bank_updated_by is distinct from current_viewer(),
  'canReveal',o.bank is not null);
end $$;

-- migrate:down
-- Back to the HR role only (0211, 0420) and 0211's bank_state.
do $$
declare definition text; changed text;
begin
 definition:=pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
 changed:=replace(definition,' elsif p_type=''people.bank'' then
  -- 1026: whoever may check bank details (bank_checker: the HR role, or an admin or leader holding hr.documents.read).
  return p_subject=''person'' and p_id<>p_person and bank_checker(p_person);',
 ' elsif p_type=''people.bank'' then
  return p_subject=''person'' and p_id<>p_person and exists(select 1 from role_assignment where org_id=current_org() and person_id=p_person and role_key=''hr'' and current_date between valid_from and coalesce(valid_to,''infinity''));');
 if changed=definition then raise exception 'notification_recipient_allowed changed shape'; end if;
 execute changed;
end $$;
create or replace function pulse.bank_checkers() returns setof uuid
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select distinct r.person_id from role_assignment r join person p on p.id=r.person_id and p.status='active'
 where r.org_id=current_org() and r.role_key='hr' and current_date between r.valid_from and coalesce(r.valid_to,'infinity')
$$;
create or replace function pulse.bank_state(p_person uuid) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare o pulse_priv.person_onboarding; self boolean;
begin
 if not bank_can_see(p_person) then raise exception 'Bank details are for the person and HR' using errcode='42501'; end if;
 self:=p_person=current_viewer();
 select * into o from pulse_priv.person_onboarding where org_id=current_org() and person_id=p_person;
 if not self and o.bank is not null then perform hr_log(p_person,'onboarding.bank','hr_profile_view'); end if;
 return jsonb_build_object('masked',o.bank_masked,'summary',o.bank_summary,'status',case when o.bank is null then 'missing' else coalesce(o.bank_status,'pending') end,
  'source',o.bank_source,'updatedAt',o.bank_updated_at,'updatedBy',(select display_name from person where id=o.bank_updated_by),
  'checkedAt',o.bank_checked_at,'checkedBy',(select display_name from person where id=o.bank_checked_by),
  'canEdit',bank_can_write(p_person),'canCheck',identity_hr() and not self and o.bank is not null and coalesce(o.bank_status,'pending')='pending',
  'canReveal',o.bank is not null);
end $$;
drop function pulse.bank_checker(uuid);

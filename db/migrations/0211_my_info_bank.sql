-- migrate:up
-- PEOPLE-CONTACTS part 2 (owner, 11 Oct 2026): profiles that are easy for the person themself, and bank details for
-- every team member so HR and payroll have them.
--  * Bank details stay sealed by the API (PRESENCE-2 envelope, document-keys.ts); PostgreSQL keeps the sealed bytes, the
--    masked line and a summary without the account number (holder, bank, branch, IFSC, last four, a masked UPI ID).
--    Only the person and HR see them (pulse.bank_can_see: the person, the HR role, or an admin or leader holding the
--    explicit hr.documents.read permission; plain leadership no longer sees even the masked line). Only the person and
--    HR change them. The full number leaves the API only for HR (payroll) or the person, one logged read at a time.
--  * A change the person makes waits for HR's check before payroll relies on it ("pending"); HR is told in Pulse. A
--    change HR makes is checked already, and the person is told. Nobody checks their own.
--  * "My info" fields the person sets directly: about, pronouns, languages (plus phone and skills, as before). A new
--    legal name, or a different date of birth once one is on file, is a request HR approves (pulse.profile_change).
--  * HR's Onboard team sees who has no bank details (or unchecked ones) and can nudge them in Pulse.

-- ------------------------------------------------------------------------------------------------------- bank
alter table pulse_priv.person_onboarding
 add column bank_summary jsonb check (bank_summary is null or (jsonb_typeof(bank_summary)='object' and pg_column_size(bank_summary)<2048)),
 add column bank_status text check (bank_status in ('pending','confirmed')),
 add column bank_source text check (bank_source in ('self','hr')),
 add column bank_updated_at timestamptz,
 add column bank_updated_by uuid,          -- no foreign key: the release smoke's cleanup deletes validation people
 add column bank_checked_at timestamptz,
 add column bank_checked_by uuid;
update pulse_priv.person_onboarding set bank_status='pending',bank_source=case when updated_by=person_id then 'self' else 'hr' end,bank_updated_at=updated_at,bank_updated_by=updated_by
 where bank is not null;

create function pulse.bank_can_see(p_person uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (p_person=current_viewer() or identity_hr())
  and exists(select 1 from person where org_id=current_org() and id=p_person and side='staff')
$$;
create function pulse.bank_can_write(p_person uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$ select bank_can_see(p_person) $$;

-- The HR role's current members (who checks bank details and is told when one changes).
create function pulse.bank_checkers() returns setof uuid
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select distinct r.person_id from role_assignment r join person p on p.id=r.person_id and p.status='active'
 where r.org_id=current_org() and r.role_key='hr' and current_date between r.valid_from and coalesce(r.valid_to,'infinity')
$$;

-- Save sealed bank details. p_data: masked, keyId, dataKey, sealed (base64), summary {holder,bank,branch,ifsc,last4,upi}.
create function pulse.bank_save(p_person uuid, p_data jsonb) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare self boolean; who text; s jsonb:=coalesce(p_data->'summary','{}'); h uuid;
begin
 if not bank_can_write(p_person) then raise exception 'Only the person and HR can change bank details' using errcode='42501'; end if;
 if coalesce(p_data->>'masked','')='' or length(p_data->>'masked')>80 or coalesce(p_data->>'sealed','')='' or coalesce(p_data->>'dataKey','')=''
  or coalesce(p_data->>'keyId','') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$' then raise exception 'Bank details are incomplete' using errcode='22023'; end if;
 -- The summary never carries the account number: four digits at most, a masked UPI ID, bounded text.
 if jsonb_typeof(s)<>'object' or coalesce(s->>'last4','') !~ '^[0-9]{4}$' or coalesce(s->>'ifsc','') !~ '^[A-Z]{4}0[A-Z0-9]{6}$'
  or length(coalesce(s->>'holder',''))>80 or length(coalesce(s->>'bank',''))>80 or length(coalesce(s->>'branch',''))>120
  or coalesce(s->>'upi','') ~ '[0-9]{5,}' or length(coalesce(s->>'upi',''))>80 then raise exception 'Bank summary is not valid' using errcode='22023'; end if;
 self:=p_person=current_viewer();
 insert into pulse_priv.person_onboarding(org_id,person_id) values(current_org(),p_person) on conflict do nothing;
 update pulse_priv.person_onboarding set bank=decode(p_data->>'sealed','base64'),bank_key=decode(p_data->>'dataKey','base64'),bank_key_id=p_data->>'keyId',
  bank_masked=p_data->>'masked',bank_summary=jsonb_build_object('holder',s->>'holder','bank',s->>'bank','branch',nullif(s->>'branch',''),'ifsc',s->>'ifsc','last4',s->>'last4','upi',nullif(s->>'upi','')),
  bank_status=case when self then 'pending' else 'confirmed' end,bank_source=case when self then 'self' else 'hr' end,
  bank_updated_at=now(),bank_updated_by=current_viewer(),bank_checked_at=case when self then null else now() end,bank_checked_by=case when self then null else current_viewer() end,
  updated_by=current_viewer(),updated_at=now() where org_id=current_org() and person_id=p_person;
 perform hr_log(p_person,'onboarding.bank',case when self then 'self_update' else 'hr_onboarding_update' end);
 select display_name into who from person where id=p_person;
 if self then
  -- HR checks a change before the next payroll relies on it (a changed account is how salaries get diverted).
  for h in select bank_checkers() loop
   if h<>p_person then perform notification_emit(h,'people.bank','person',p_person,'bank:'||p_person||':'||extract(epoch from clock_timestamp())::bigint,
    who||' changed their bank details. Check them before the next payroll.','/people/'||p_person||'?tab=info','profile'); end if;
  end loop;
 else
  perform notification_emit(p_person,'profile.bank','person',p_person,'bank:'||extract(epoch from clock_timestamp())::bigint,
   'HR updated your bank details for salary. If this was not expected, tell HR.','/people/'||p_person||'?tab=info','profile');
 end if;
 update pulse_priv.person_onboarding set completed_at=case when cardinality(onboarding_missing(p_person))=0 then coalesce(completed_at,now()) end where person_id=p_person;
 return jsonb_build_object('status',case when self then 'pending' else 'confirmed' end,'missing',to_jsonb(onboarding_missing(p_person)));
end $$;

-- What the person and HR see: the masked line and the summary, who changed it and whether HR checked it.
create function pulse.bank_state(p_person uuid) returns jsonb
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

-- The sealed bytes, for the API to open one account number for the person or HR. Every read is logged.
create function pulse.bank_sealed(p_person uuid) returns table(key_id text, data_key bytea, sealed bytea)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not bank_can_see(p_person) then raise exception 'Bank details are for the person and HR' using errcode='42501'; end if;
 perform hr_log(p_person,'onboarding.bank.account',case when p_person=current_viewer() then 'self' else 'payroll_view' end);
 return query select o.bank_key_id,o.bank_key,o.bank from pulse_priv.person_onboarding o where o.org_id=current_org() and o.person_id=p_person and o.bank is not null;
end $$;

create function pulse.bank_confirm(p_person uuid) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not identity_hr() then raise exception 'HR checks bank details' using errcode='42501'; end if;
 if p_person=current_viewer() then raise exception 'Someone else in HR checks your own bank details' using errcode='42501'; end if;
 update pulse_priv.person_onboarding set bank_status='confirmed',bank_checked_at=now(),bank_checked_by=current_viewer()
  where org_id=current_org() and person_id=p_person and bank is not null and coalesce(bank_status,'pending')='pending';
 if not found then raise exception 'There are no bank details waiting for a check' using errcode='22023'; end if;
 perform hr_log(p_person,'onboarding.bank','hr_bank_check');
 return bank_state(p_person);
end $$;

-- The onboarding flow saves through the same rules (it used to let leadership and admins write bank details too), and
-- a date of birth already on file changes only through HR (pulse.profile_change below).
create function pulse.swap_text(p_text text, p_from text, p_to text) returns text
 language plpgsql immutable set search_path=pulse,pg_temp as $$
begin
 if position(p_from in p_text)=0 then raise exception 'migration 0211: expected text not found: %', left(p_from,80); end if;
 return replace(p_text,p_from,p_to);
end $$;
do $$
declare definition text; changed text;
begin
 definition:=pg_get_functiondef('pulse.onboarding_save(uuid,text,jsonb)'::regprocedure);
 changed:=regexp_replace(definition, E' elsif p_section=''bank'' then.*? elsif p_section=''step'' then', E' elsif p_section=''bank'' then\n  return bank_save(p_person,p_data);\n elsif p_section=''step'' then');
 if changed=definition then raise exception 'onboarding_save changed shape'; end if;
 changed:=pulse.swap_text(changed, $r$ if p_section='details' then$r$, $r$ if p_section='details' then
  if self and p_data ? 'dob' and coalesce((select details->>'dob' from pulse_priv.person_onboarding where org_id=current_org() and person_id=p_person),'') not in ('',coalesce(p_data->>'dob','')) then
   raise exception 'Your date of birth is on file. Ask HR to change it' using errcode='42501'; end if;$r$);
 execute changed;
 definition:=pg_get_functiondef('pulse.onboarding_state(uuid)'::regprocedure);
 execute pulse.swap_text(definition, $r$'bank',case when see_details then o.bank_masked end,$r$,
  $r$'bank',case when bank_can_see(p_person) then o.bank_masked end,'bankStatus',case when bank_can_see(p_person) and o.bank is not null then coalesce(o.bank_status,'pending') end,$r$);
 -- Onboard team: whether bank details are on file and checked (never what they are), and change requests waiting.
 definition:=pg_get_functiondef('pulse.onboarding_roster()'::regprocedure);
 changed:=pulse.swap_text(definition, $r$'completedAt',(select o.completed_at from pulse_priv.person_onboarding o where o.person_id=p.id)) row$r$,
  $r$'bank',coalesce((select case when o.bank is null then 'missing' else coalesce(o.bank_status,'pending') end from pulse_priv.person_onboarding o where o.person_id=p.id),'missing'),
   'changes',(select count(*) from profile_change x where x.org_id=current_org() and x.person_id=p.id and x.status='pending'),
   'completedAt',(select o.completed_at from pulse_priv.person_onboarding o where o.person_id=p.id)) row$r$);
 changed:=pulse.swap_text(changed, $r$case when n.event_type='attendance.nudge' then 'checkin' else 'profile' end$r$,
  $r$case when n.event_type='attendance.nudge' then 'checkin' when n.event_key like 'bank:%' then 'bank' else 'profile' end$r$);
 changed:=pulse.swap_text(changed, $r$select distinct on (event_type) event_type,created_at from notification$r$, $r$select distinct on (event_type,event_key like 'bank:%') event_type,event_key,created_at from notification$r$);
 changed:=pulse.swap_text(changed, $r$order by event_type,created_at desc) n)$r$, $r$order by event_type,event_key like 'bank:%',created_at desc) n)$r$);
 execute changed;
end $$;

create or replace function pulse.onboarding_nudge(p_person uuid, p_kind text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare nid uuid; day date:=(clock_timestamp() at time zone 'Asia/Kolkata')::date;
begin
 if not viewer_is('admin','hr') or current_viewer() is null then raise exception 'HR nudges' using errcode='42501'; end if;
 if p_kind='checkin' then
  nid:=notification_emit(p_person,'attendance.nudge','person',p_person,'hr:'||day,'A reminder from HR: check in on Pulse when you start work. It’s one tap.','/me','attendance');
  if nid is not null then insert into attendance_event(org_id,person_id,work_date,kind,detail,signals) values(current_org(),p_person,day,'nudge','checkin','{hr}'); end if;
 elsif p_kind='profile' then
  nid:=notification_emit(p_person,'profile.reminder','person',p_person,'hr:'||day,'HR asks you to finish your Pulse profile. It takes about 3 minutes.','/welcome','profile');
 elsif p_kind='bank' then
  -- PEOPLE-CONTACTS: only someone without bank details on file; the reminder opens their own My info.
  if exists(select 1 from pulse_priv.person_onboarding where org_id=current_org() and person_id=p_person and bank is not null) then return null; end if;
  nid:=notification_emit(p_person,'profile.reminder','person',p_person,'bank:'||day,'HR asks you to add your bank details, so your salary can be paid. It takes a minute.','/people/'||p_person||'?tab=info','profile');
 else raise exception 'Unknown nudge' using errcode='22023';
 end if;
 return nid;
end $$;

-- -------------------------------------------------------------------------------------------- the person's own info
alter table pulse.people_profile
 add column about text check (about is null or length(about)<=400),
 add column pronouns text check (pronouns is null or length(pronouns)<=30),
 add column languages text[] not null default '{}' check (cardinality(languages)<=8);

-- About, pronouns, languages and the work phone: the person, or HR and admins. Each change is a record_change row.
create function pulse.profile_info_save(p_person uuid, p_data jsonb) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare before people_profile; v text; langs text[];
begin
 if current_viewer() is null or not (p_person=current_viewer() or viewer_is('admin','hr')) then raise exception 'Your own profile, or HR' using errcode='42501'; end if;
 select * into before from people_profile where org_id=current_org() and person_id=p_person for update;
 if not found then raise exception 'No staff record' using errcode='P0002'; end if;
 if p_data ? 'about' then
  v:=nullif(btrim(p_data->>'about'),''); if length(v)>400 then raise exception 'About is up to 400 characters' using errcode='22023'; end if;
  if v is distinct from before.about then update people_profile set about=v,updated_at=now() where person_id=p_person;
   insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values(current_org(),'person',p_person,'about',before.about,v,current_viewer()); end if;
 end if;
 if p_data ? 'pronouns' then
  v:=nullif(btrim(p_data->>'pronouns'),''); if length(v)>30 then raise exception 'Pronouns are up to 30 characters' using errcode='22023'; end if;
  if v is distinct from before.pronouns then update people_profile set pronouns=v,updated_at=now() where person_id=p_person;
   insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values(current_org(),'person',p_person,'pronouns',before.pronouns,v,current_viewer()); end if;
 end if;
 if p_data ? 'languages' then
  if jsonb_typeof(p_data->'languages')<>'array' then raise exception 'Languages are a list' using errcode='22023'; end if;
  langs:=array(select l from (select distinct on (lower(btrim(x))) left(btrim(x),32) l,n from jsonb_array_elements_text(p_data->'languages') with ordinality t(x,n)
   where btrim(x)<>'' order by lower(btrim(x)),n) d order by n limit 8);
  if langs is distinct from before.languages then update people_profile set languages=langs,updated_at=now() where person_id=p_person;
   insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values(current_org(),'person',p_person,'languages',array_to_string(before.languages,', '),array_to_string(langs,', '),current_viewer()); end if;
 end if;
end $$;

-- A legal name, or a different date of birth once one is on file: the person asks, HR approves.
create table pulse.profile_change (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id),
 field text not null check (field in ('name','dob')),
 old_value text check (length(old_value)<=120),
 new_value text not null check (length(new_value) between 1 and 120),
 note text check (length(note)<=300),
 status text not null default 'pending' check (status in ('pending','approved','declined','withdrawn')),
 requested_by uuid not null,               -- no foreign keys to people here beyond the subject (release smoke cleanup)
 requested_at timestamptz not null default now(),
 decided_by uuid, decided_at timestamptz, decision_note text check (length(decision_note)<=300)
);
create unique index profile_change_open on pulse.profile_change(org_id,person_id,field) where status='pending';
alter table pulse.profile_change enable row level security;
alter table pulse.profile_change force row level security;
create policy tenant on pulse.profile_change using (org_id=pulse.current_org()) with check (org_id=pulse.current_org());
create policy own_or_hr on pulse.profile_change as restrictive for select to pulse_api using (person_id=pulse.current_viewer() or pulse.viewer_is('admin','hr','leadership'));
grant select on pulse.profile_change to pulse_api, pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse.profile_change for each row execute function pulse.audit_mutation();

create function pulse.profile_change_request(p_field text, p_value text, p_note text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); old text; v text:=btrim(coalesce(p_value,'')); nid uuid; h uuid; who text;
begin
 if me is null or not exists(select 1 from person where org_id=current_org() and id=me and side='staff') then raise exception 'For a member of staff' using errcode='42501'; end if;
 if p_field='name' then
  select display_name into old from person where id=me;
  if length(v)<2 or length(v)>80 or v !~ '[[:alpha:]]' then raise exception 'Write the full name, 2 to 80 characters' using errcode='22023'; end if;
 elsif p_field='dob' then
  select details->>'dob' into old from pulse_priv.person_onboarding where org_id=current_org() and person_id=me;
  begin
   if v !~ '^\d{4}-\d{2}-\d{2}$' or v::date>current_date-interval '15 years' or v::date<current_date-interval '80 years' then raise exception 'bad'; end if;
  exception when others then raise exception 'Check the date of birth' using errcode='22023';
  end;
 else raise exception 'This detail is not changed by request' using errcode='22023';
 end if;
 if v=coalesce(old,'') then raise exception 'That is already the value on file' using errcode='22023'; end if;
 update profile_change set status='withdrawn',decided_at=now(),decided_by=me where org_id=current_org() and person_id=me and field=p_field and status='pending';
 insert into profile_change(org_id,person_id,field,old_value,new_value,note,requested_by) values(current_org(),me,p_field,old,v,nullif(left(btrim(coalesce(p_note,'')),300),''),me) returning id into nid;
 select display_name into who from person where id=me;
 for h in select r.person_id from role_assignment r join person p on p.id=r.person_id and p.status='active' where r.org_id=current_org() and r.role_key in ('hr','admin')
  and current_date between r.valid_from and coalesce(r.valid_to,'infinity') group by r.person_id loop
  if h<>me then perform notification_emit(h,'people.change','person',me,'change:'||nid,who||' asks to change their '||case when p_field='name' then 'name' else 'date of birth' end||'. Approve or decline it.','/people/'||me||'?tab=info','profile'); end if;
 end loop;
 return nid;
end $$;

create function pulse.profile_change_decide(p_id uuid, p_approve boolean, p_note text) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare x profile_change;
begin
 if current_viewer() is null or not viewer_is('admin','hr') then raise exception 'HR approves changes to a record' using errcode='42501'; end if;
 select * into x from profile_change where org_id=current_org() and id=p_id and status='pending' for update;
 if not found then raise exception 'This request is already settled' using errcode='22023'; end if;
 if x.person_id=current_viewer() then raise exception 'Someone else approves a change to your own record' using errcode='42501'; end if;
 if not p_approve and length(btrim(coalesce(p_note,'')))<3 then raise exception 'Say why, so the person knows what to do' using errcode='22023'; end if;
 update profile_change set status=case when p_approve then 'approved' else 'declined' end,decided_by=current_viewer(),decided_at=now(),decision_note=nullif(left(btrim(coalesce(p_note,'')),300),'') where id=p_id;
 if p_approve then
  if x.field='name' then
   update person set display_name=x.new_value where id=x.person_id;
   update people_profile set locked=array(select distinct unnest(locked||'name'::text)),updated_at=now() where person_id=x.person_id;
  else
   insert into pulse_priv.person_onboarding(org_id,person_id) values(current_org(),x.person_id) on conflict do nothing;
   update pulse_priv.person_onboarding set details=details||jsonb_build_object('dob',x.new_value),updated_by=current_viewer(),updated_at=now() where person_id=x.person_id;
   perform hr_log(x.person_id,'onboarding.details','hr_profile_edit');
  end if;
  insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values(current_org(),'person',x.person_id,x.field,
   case when x.field='dob' then null else x.old_value end,case when x.field='dob' then 'changed on request' else x.new_value end,current_viewer());
 end if;
 perform notification_emit(x.person_id,'profile.changed','person',x.person_id,'change:'||x.id,
  case when p_approve then 'HR approved the change to your '||case when x.field='name' then 'name' else 'date of birth' end||'.'
   else 'HR declined the change to your '||case when x.field='name' then 'name' else 'date of birth' end||': '||left(btrim(p_note),120) end,'/people/'||x.person_id||'?tab=info','profile');
end $$;

create function pulse.profile_change_withdraw(p_id uuid) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 update profile_change set status='withdrawn',decided_at=now(),decided_by=current_viewer() where org_id=current_org() and id=p_id and person_id=current_viewer() and status='pending';
 if not found then raise exception 'Nothing to withdraw' using errcode='22023'; end if;
end $$;

-- ---------------------------------------------------------------------------------------------- notifications
alter table pulse.notification drop constraint notification_event_type_check;
alter table pulse.notification add constraint notification_event_type_check check(event_type in ('update.self','chat.message','chat.mention','chat.reply','policy.published','holiday.announced',
 'task.assigned','task.blocked','task.unblocked','task.due_soon','task.done','task.accepted','task.ask','project.ask','ask.answered',
 'task.mention','project.mention','task.comment','project.comment','project.added','task.update',
 'domain.proposed','domain.answered','domain.policy','domain.ended','pool.claimed','pool.match',
 'leave.decision','request.updated','request.decision','approval.waiting','approval.reminder','payroll.processed',
 'attendance.start','attendance.end','attendance.done','attendance.departure','attendance.confirmed','attendance.arrival','attendance.break','attendance.nudge',
 'profile.reminder','kudos.received','people.bank','people.change','profile.bank','profile.changed'));
do $$
declare definition text; changed text;
begin
 definition:=pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
 -- HR hears about someone else's bank change (the HR role only: nobody else may see bank details) and about change
 -- requests (HR and admins, who decide them). The person's own notices are 'profile.*' (themself only, as before).
 changed:=replace(definition,' elsif p_type=''policy.published'' then',
 ' elsif p_type=''people.bank'' then
  return p_subject=''person'' and p_id<>p_person and exists(select 1 from role_assignment where org_id=current_org() and person_id=p_person and role_key=''hr'' and current_date between valid_from and coalesce(valid_to,''infinity''));
 elsif p_type=''people.change'' then
  return p_subject=''person'' and p_id<>p_person and exists(select 1 from role_assignment where org_id=current_org() and person_id=p_person and role_key in (''hr'',''admin'') and current_date between valid_from and coalesce(valid_to,''infinity''));
 elsif p_type=''policy.published'' then');
 if changed=definition then raise exception 'notification_recipient_allowed changed shape'; end if;
 execute changed;
end $$;

drop function pulse.swap_text(text,text,text);

revoke all on function pulse.bank_can_see(uuid),pulse.bank_can_write(uuid),pulse.bank_checkers(),pulse.bank_save(uuid,jsonb),pulse.bank_state(uuid),pulse.bank_sealed(uuid),pulse.bank_confirm(uuid),
 pulse.profile_info_save(uuid,jsonb),pulse.profile_change_request(text,text,text),pulse.profile_change_decide(uuid,boolean,text),pulse.profile_change_withdraw(uuid) from public;
grant execute on function pulse.bank_can_see(uuid),pulse.bank_save(uuid,jsonb),pulse.bank_state(uuid),pulse.bank_sealed(uuid),pulse.bank_confirm(uuid),
 pulse.profile_info_save(uuid,jsonb),pulse.profile_change_request(text,text,text),pulse.profile_change_decide(uuid,boolean,text),pulse.profile_change_withdraw(uuid) to pulse_api;

-- migrate:down
-- Forward-only: bank details and change requests are kept.

-- migrate:up
-- ONBOARD-GATE (owner, 27 Oct 2026): nobody uses Pulse until the basic and important parts of their profile are in.
-- After the forced password change, a staff person with something missing sees only "Set up your profile"
-- (/welcome); every other API call answers 403 with code profile_incomplete (services/api/src/routes.ts asks
-- pulse.onboarding_gate() on every request, after the active organisation and the viewer are set).
--
-- What counts as "missing" is pulse.onboarding_missing(), the same list HR → Onboard team shows. This adds:
--   legalName, preferredName, city, the emergency contact's relation, skills (people_profile.skills) and "work"
--   (the person confirmed their role, pod/team and joining date). Private values stay in pulse_priv.
-- The organisation can switch the gate off (HR → Onboard team → Settings → Profiles); it is on by default for EA.
-- The platform owner gets "Finish later" (seven days at a time) so the owner is never locked out; nobody else does.
-- Finishing the profile writes an audit row (profile_complete).

alter table pulse_priv.person_onboarding add column if not exists gate_skip_until timestamptz;

create table pulse.onboarding_gate_setting (
 org_id uuid primary key references pulse.org(id),
 enabled boolean not null,
 updated_by uuid references pulse.person(id),
 updated_at timestamptz not null default now()
);
alter table pulse.onboarding_gate_setting enable row level security;
alter table pulse.onboarding_gate_setting force row level security;
create policy tenant_isolation on pulse.onboarding_gate_setting using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- Read and written only through the functions below.

-- ------------------------------------------------------------------------------------------- what is missing
create or replace function pulse.onboarding_missing(p_person uuid) returns text[]
 language sql stable security definer set search_path=pulse,pg_temp as $$
 with o as (select details,bank_masked,contact_email,contact_phone from pulse_priv.person_onboarding where org_id=current_org() and person_id=p_person)
 select array_remove(array[
  case when coalesce((select details->>'legalName' from o),'')='' then 'legalName' end,
  case when coalesce((select details->>'preferredName' from o),'')='' then 'preferredName' end,
  case when coalesce((select details->>'dob' from o),'')='' then 'dob' end,
  case when not coalesce((select contact_phone from o),false) and coalesce((select phone from people_profile where person_id=p_person),'')='' then 'phone' end,
  case when not coalesce((select contact_email from o),false) then 'email' end,
  case when coalesce((select details->>'address' from o),'')='' then 'address' end,
  case when coalesce((select details->>'city' from o),'')='' then 'city' end,
  case when coalesce((select details->>'emergencyName' from o),'')='' or coalesce((select details->>'emergencyPhone' from o),'')=''
    or coalesce((select details->>'emergencyRelation' from o),'')='' then 'emergency' end,
  case when coalesce((select details->>'workConfirmedAt' from o),'')='' then 'work' end,
  case when coalesce((select cardinality(skills) from people_profile where person_id=p_person),0)=0 then 'skills' end,
  case when (select bank_masked from o) is null then 'bank' end,
  case when not exists(select 1 from person_photo where person_id=p_person) then 'photo' end],null)
  || coalesce((select array_agg('doc:'||k.kind order by k.sort) from onboarding_document_kind k where k.org_id=current_org() and k.active and k.required
   and not exists(select 1 from pulse_priv.identity_document d where d.org_id=current_org() and d.person_id=p_person and d.kind=k.kind and d.status in ('on_file','verified'))),'{}')
$$;

-- The percent: twelve fields now, not seven (onboarding_state and the HR roster).
do $$
declare definition text; fn text;
begin
 foreach fn in array array['pulse.onboarding_state(uuid)','pulse.onboarding_roster()'] loop
  definition:=pg_get_functiondef(fn::regprocedure);
  if position('total:=7+' in definition)=0 then raise exception 'migration 1195: % changed shape', fn; end if;
  definition:=replace(definition,'total:=7+','total:=12+');
  -- The work step shows the skills already on the profile.
  if fn='pulse.onboarding_state(uuid)' then
   if position($r$'workPhone',pp.phone,$r$ in definition)=0 then raise exception 'migration 1195: onboarding_state changed shape'; end if;
   definition:=replace(definition,$r$'workPhone',pp.phone,$r$,$r$'workPhone',pp.phone,'skills',coalesce(pp.skills,'{}'),$r$);
  end if;
  execute definition;
 end loop;

 -- onboarding_save: legal and preferred names, a note about the work details, the "work" section and step.
 definition:=pg_get_functiondef('pulse.onboarding_save(uuid,text,jsonb)'::regprocedure);
 if position($r$'emergencyPhone','fatherName'];$r$ in definition)=0
  or position($r$ elsif p_section='consent' then$r$ in definition)=0
  or position($r$('welcome','details','bank','documents',$r$ in definition)=0 then raise exception 'migration 1195: onboarding_save changed shape'; end if;
 definition:=replace(definition,$r$'emergencyPhone','fatherName'];$r$,$r$'emergencyPhone','fatherName','legalName','preferredName','workNote'];$r$);
 definition:=replace(definition,$r$('welcome','details','bank','documents',$r$,$r$('welcome','details','work','bank','documents',$r$);
 definition:=replace(definition,$r$ elsif p_section='consent' then$r$,$r$ elsif p_section='work' then
  -- The person (or HR) confirms role, pod/team and joining date as HR keeps them, and lists their skills and tools.
  if jsonb_typeof(p_data->'skills') is distinct from 'array' or jsonb_array_length(p_data->'skills')=0 then raise exception 'Add at least one skill or tool' using errcode='22023'; end if;
  if jsonb_array_length(p_data->'skills')>15 or exists(select 1 from jsonb_array_elements_text(p_data->'skills') s where length(btrim(s))=0 or length(s)>40) then
   raise exception 'Up to 15 skills, each up to 40 characters' using errcode='22023'; end if;
  update people_profile set skills=(select array_agg(distinct btrim(s)) from jsonb_array_elements_text(p_data->'skills') s),updated_at=now() where person_id=p_person;
  if not found then raise exception 'Person not found' using errcode='P0002'; end if;
  update pulse_priv.person_onboarding set details=jsonb_strip_nulls(details||jsonb_build_object('workConfirmedAt',now()::text,
    'workNote',nullif(btrim(left(coalesce(p_data->>'note',''),300)),''))),updated_by=current_viewer(),updated_at=now() where person_id=p_person;
  if not self then perform hr_log(p_person,'onboarding.work','hr_onboarding_update'); end if;
 elsif p_section='consent' then$r$);
 execute definition;
end $$;

-- ------------------------------------------------------------------------------------------- the gate itself
create function pulse.onboarding_gate_enabled() returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select enabled from onboarding_gate_setting where org_id=current_org()), current_org()='6f1a455d-ced2-504d-b8d5-5ae0efbe7c75'::uuid)
$$;

/** The platform owner: a Pulse platform admin, or the install's own owner account. Only they may "Finish later". */
create function pulse.onboarding_gate_owner() returns boolean
 language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or current_org() is distinct from install_org() then return false; end if;
 if to_regprocedure('pulse.platform_admin()') is not null then
  if (select platform_admin()) then return true; end if;
 end if;
 return exists(select 1 from account a where a.holder_person_id=current_viewer() and a.provider='google'
   and a.handle in ('user-668d21b6@estateautopilots.com','admin@estateautopilots.com'));
end $$;

/** For the signed-in person: whether Pulse opens, and what is missing. p_files: whether the server can seal bank
 *  details (without the document keyring nobody could ever finish, so bank details are not asked then). */
create function pulse.onboarding_gate(p_files boolean default true) returns jsonb
 language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); m text[]; skip timestamptz; owner boolean;
begin
 if me is null or current_org() is null then return jsonb_build_object('enabled',false,'blocked',false); end if;
 if not onboarding_gate_enabled() then return jsonb_build_object('enabled',false,'blocked',false); end if;
 if not exists(select 1 from person p where p.id=me and p.org_id=current_org() and p.side='staff' and p.status='active')
  or exists(select 1 from agent_member a where a.person_id=me) or is_accountant(me) then
  return jsonb_build_object('enabled',true,'blocked',false);
 end if;
 m:=onboarding_missing(me);
 if not p_files then m:=array_remove(m,'bank'); end if;
 owner:=onboarding_gate_owner();
 select gate_skip_until into skip from pulse_priv.person_onboarding where org_id=current_org() and person_id=me;
 return jsonb_build_object('enabled',true,'blocked',cardinality(m)>0 and not (owner and coalesce(skip>now(),false)),
  'missing',to_jsonb(m),'canSkip',owner,'skippedUntil',case when owner then skip end);
end $$;

/** "Finish later": the platform owner only, seven days at a time, audited. */
create function pulse.onboarding_gate_skip() returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not onboarding_gate_owner() then raise exception 'Only the platform owner can finish this later' using errcode='42501'; end if;
 insert into pulse_priv.person_onboarding(org_id,person_id,gate_skip_until) values(current_org(),current_viewer(),now()+interval '7 days')
 on conflict(person_id) do update set gate_skip_until=excluded.gate_skip_until,updated_at=now();
 perform audit_write('onboarding_gate_skip','person_onboarding',current_viewer()::text);
 return onboarding_gate(true);
end $$;

/** HR → Onboard team → Settings: the safety valve. */
create function pulse.onboarding_gate_set(p_enabled boolean) returns boolean
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or not viewer_is('admin','hr') then raise exception 'HR or an organisation admin decides this' using errcode='42501'; end if;
 insert into onboarding_gate_setting(org_id,enabled,updated_by) values(current_org(),p_enabled,current_viewer())
 on conflict(org_id) do update set enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=now();
 perform audit_write('onboarding_gate_set','org',current_org()::text,array[case when p_enabled then 'on' else 'off' end]);
 return p_enabled;
end $$;

-- ------------------------------------------------------------------------------- "You're all set": the audit row
create function pulse.onboarding_completed_audit() returns trigger
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 insert into audit_event(org_id,actor_id,actor_account,action,resource,resource_id)
 values(new.org_id,nullif(current_setting('pulse.viewer_id',true),'')::uuid,nullif(current_setting('pulse.actor_account',true),''),'profile_complete','person_onboarding',new.person_id::text);
 return new;
end $$;
create trigger onboarding_completed_audit after update of completed_at on pulse_priv.person_onboarding for each row
 when (old.completed_at is null and new.completed_at is not null) execute function pulse.onboarding_completed_audit();

revoke all on function pulse.onboarding_gate_enabled(),pulse.onboarding_gate_owner(),pulse.onboarding_gate(boolean),pulse.onboarding_gate_skip(),
 pulse.onboarding_gate_set(boolean),pulse.onboarding_completed_audit() from public;
grant execute on function pulse.onboarding_gate_enabled(),pulse.onboarding_gate_owner(),pulse.onboarding_gate(boolean),pulse.onboarding_gate_skip(),
 pulse.onboarding_gate_set(boolean) to pulse_api;

-- migrate:down
drop trigger if exists onboarding_completed_audit on pulse_priv.person_onboarding;
drop function if exists pulse.onboarding_completed_audit();
drop function if exists pulse.onboarding_gate_set(boolean);
drop function if exists pulse.onboarding_gate_skip();
drop function if exists pulse.onboarding_gate(boolean);
drop function if exists pulse.onboarding_gate_owner();
drop function if exists pulse.onboarding_gate_enabled();
drop table if exists pulse.onboarding_gate_setting;
alter table pulse_priv.person_onboarding drop column if exists gate_skip_until;

-- migrate:up
-- TASKS-3 (owner, 11 Oct 2026: "who is managing who: set up pod heads and proper reporting lines, so workflows can be
-- seen and visualised").
--  * A reporting line is people_profile.manager_id; a pod head is hr_pod.head_id (and the pod unit's head). HR and admins
--    set both (org_line_set, org_pod_head_set); each change is locked against imports and written to the audit log.
--  * Managers see their reports' work: manages() now also holds for a person's manager and everyone above them in the
--    line (eight levels), besides the pod head and the unit roles it already covered.
--  * Pulse proposes initial lines from the roster, pods, roles, groups and PEOPLE-LIVE evidence (org_line_proposal, with
--    the evidence and a confidence). Nothing changes until HR confirms; one click confirms one, or all above a confidence.

create or replace function pulse.manages(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and p_person<>current_viewer() and (
 coalesce(hr_head(p_person)=current_viewer(),false) or exists(select 1 from role_assignment r join unit u on u.id=r.unit_id join people_profile target on target.person_id=p_person
 where r.org_id=current_org() and r.person_id=current_viewer() and (r.is_manager_of_unit or r.role_key in('manager','pgs','head_pgs'))
 and current_date between r.valid_from and coalesce(r.valid_to,'infinity') and u.valid_to is null and target.pod=u.name)
 or exists(with recursive up(id,depth) as (
   select pp.manager_id,1 from people_profile pp where pp.org_id=current_org() and pp.person_id=p_person and pp.manager_id is not null
   union all select pp.manager_id,up.depth+1 from up join people_profile pp on pp.org_id=current_org() and pp.person_id=up.id where pp.manager_id is not null and up.depth<8)
  select 1 from up where up.id=current_viewer()))
$$;

create table pulse.org_line_proposal (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 kind text not null check(kind in ('manager','pod_head')),person_id uuid not null references pulse.person(id),
 manager_id uuid references pulse.person(id),pod text check(length(pod) between 1 and 80),
 confidence numeric(4,3) not null check(confidence between 0 and 1),evidence jsonb not null default '[]' check(jsonb_typeof(evidence)='array'),
 status text not null default 'pending' check(status in ('pending','confirmed','dismissed','retired')),
 created_at timestamptz not null default now(),decided_by uuid references pulse.person(id),decided_at timestamptz,
 check((kind='manager' and manager_id is not null) or (kind='pod_head' and pod is not null))
);
create unique index org_line_proposal_open on pulse.org_line_proposal(org_id,kind,person_id) where status='pending' and kind='manager';
create unique index org_line_proposal_pod on pulse.org_line_proposal(org_id,pod) where status='pending' and kind='pod_head';
alter table pulse.org_line_proposal enable row level security;
alter table pulse.org_line_proposal force row level security;
create policy tenant_isolation on pulse.org_line_proposal using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy hr_read on pulse.org_line_proposal as restrictive for select to pulse_api using(pulse.viewer_is('admin','hr','leadership'));
grant select on pulse.org_line_proposal to pulse_api;

-- One reporting line, set by HR or an admin. No loops; nobody reports to themselves.
create function pulse.org_line_set(p_person uuid,p_manager uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();
begin
 if me is null or not viewer_is('admin','hr') then raise exception 'HR and admins set reporting lines' using errcode='42501';end if;
 if not exists(select 1 from people_profile where org_id=current_org() and person_id=p_person) then raise exception 'Choose a team member' using errcode='22023';end if;
 if p_manager is not null then
  if p_manager=p_person then raise exception 'Nobody reports to themselves' using errcode='22023';end if;
  if not exists(select 1 from person where org_id=current_org() and id=p_manager and side='staff' and status='active') then raise exception 'Choose an active team member as the manager' using errcode='22023';end if;
  if exists(with recursive up(id,depth) as (select p_manager,0 union all select pp.manager_id,up.depth+1 from up join people_profile pp on pp.org_id=current_org() and pp.person_id=up.id where pp.manager_id is not null and up.depth<30)
   select 1 from up where id=p_person) then raise exception 'That would make a loop: they already report (through others) to this person' using errcode='22023';end if;
 end if;
 update people_profile set manager_id=p_manager,updated_at=now(),locked=array(select distinct unnest(locked||array['manager_id'])) where org_id=current_org() and person_id=p_person;
 update org_line_proposal set status='retired' where org_id=current_org() and kind='manager' and person_id=p_person and status='pending';
 perform audit_write('reporting_line','person',p_person::text,array['manager_id']);
end $$;

-- A pod's head, set by HR or an admin. Members who reported to nobody (or to the old head) now report to the new head.
create function pulse.org_pod_head_set(p_pod text,p_head uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();old uuid;
begin
 if me is null or not viewer_is('admin','hr') then raise exception 'HR and admins set pod heads' using errcode='42501';end if;
 if not exists(select 1 from unit where org_id=current_org() and kind='pod' and name=p_pod and valid_to is null) then raise exception 'Choose a current pod' using errcode='22023';end if;
 select head_id into old from hr_pod where org_id=current_org() and name=p_pod;
 if p_head is null then
  delete from hr_pod where org_id=current_org() and name=p_pod;
  update unit set head_person_id=null where org_id=current_org() and kind='pod' and name=p_pod and valid_to is null;
 else
  if not exists(select 1 from person where org_id=current_org() and id=p_head and side='staff' and status='active') then raise exception 'Choose an active team member' using errcode='22023';end if;
  insert into hr_pod(org_id,name,head_id,updated_by) values(current_org(),p_pod,p_head,me) on conflict(org_id,name) do update set head_id=excluded.head_id,updated_by=excluded.updated_by,updated_at=now();
  update unit set head_person_id=p_head where org_id=current_org() and kind='pod' and name=p_pod and valid_to is null;
  update people_profile set pod=p_pod,updated_at=now(),locked=array(select distinct unnest(locked||array['pod'])) where org_id=current_org() and person_id=p_head and pod is distinct from p_pod;
  update people_profile set manager_id=p_head,updated_at=now(),locked=array(select distinct unnest(locked||array['manager_id']))
   where org_id=current_org() and pod=p_pod and person_id<>p_head and (manager_id is null or manager_id is not distinct from old);
 end if;
 update org_line_proposal set status='retired' where org_id=current_org() and kind='pod_head' and pod=p_pod and status='pending';
 perform audit_write('pod_head','pod',p_pod,array['head_id']);
end $$;

-- Proposals arrive from the API's evidence reader as one batch; earlier pending ones are retired, decided ones stay.
create function pulse.org_line_propose(p jsonb) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();x jsonb;n int:=0;
begin
 if me is null or not viewer_is('admin','hr','leadership') then raise exception 'HR, leadership and admins look for reporting lines' using errcode='42501';end if;
 if jsonb_typeof(p)<>'array' then raise exception 'Send proposals' using errcode='22023';end if;
 update org_line_proposal set status='retired' where org_id=current_org() and status='pending';
 for x in select * from jsonb_array_elements(p) loop
  if exists(select 1 from org_line_proposal where org_id=current_org() and status='dismissed' and kind=x->>'kind' and person_id=(x->>'personId')::uuid
   and manager_id is not distinct from nullif(x->>'managerId','')::uuid and pod is not distinct from nullif(x->>'pod','')) then continue;end if;
  insert into org_line_proposal(org_id,kind,person_id,manager_id,pod,confidence,evidence)
  values(current_org(),x->>'kind',(x->>'personId')::uuid,nullif(x->>'managerId','')::uuid,nullif(x->>'pod',''),least(1,greatest(0,(x->>'confidence')::numeric)),coalesce(x->'evidence','[]'))
  on conflict do nothing;
  n:=n+1;
 end loop;
 return n;
end $$;

create function pulse.org_line_decide(p_id uuid,p_accept boolean,p_manager uuid default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();x org_line_proposal;
begin
 if me is null or not viewer_is('admin','hr') then raise exception 'HR and admins confirm reporting lines' using errcode='42501';end if;
 select * into x from org_line_proposal where org_id=current_org() and id=p_id and status='pending' for update;
 if not found then raise exception 'This proposal was already decided' using errcode='P0002';end if;
 if p_accept then
  if x.kind='manager' then perform org_line_set(x.person_id,coalesce(p_manager,x.manager_id));else perform org_pod_head_set(x.pod,x.person_id);end if;
 end if;
 update org_line_proposal set status=case when p_accept then 'confirmed' else 'dismissed' end,decided_by=me,decided_at=now() where id=p_id;
 return jsonb_build_object('status',case when p_accept then 'confirmed' else 'dismissed' end);
end $$;

revoke all on function pulse.org_line_set(uuid,uuid),pulse.org_pod_head_set(text,uuid),pulse.org_line_propose(jsonb),pulse.org_line_decide(uuid,boolean,uuid) from public;
grant execute on function pulse.org_line_set(uuid,uuid),pulse.org_pod_head_set(text,uuid),pulse.org_line_propose(jsonb),pulse.org_line_decide(uuid,boolean,uuid) to pulse_api;

-- migrate:down
-- Forward-only.

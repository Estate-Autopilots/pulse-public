-- migrate:up
-- TASKS-3 (owner, 11 Oct 2026: "the work pool should be filled from data: tasks fetched from the Drive analysis sweep and
-- earlier task groups and pods").
--  * Pulse proposes pool tasks in batches, each from one source: client projects whose Drive folders show no finals yet;
--    the usual steps of a client package (learnt from the tracker task groups) that a current package has no task for;
--    and unowned tracker tasks of recent weeks. The pod that usually does that kind of work is the pool it goes to.
--  * Nothing is published by itself: leadership approves a batch in one click (after taking out what does not belong,
--    or changing a value) or dismisses it. Approving makes the tasks (or pools the existing ones) through task_save, so the
--    usual rules, value and "fits your domains" notices apply.

create table pulse.pool_batch (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 source text not null check(source in ('drive','steps','tracker')),title text not null check(length(title) between 1 and 200),summary text check(length(summary)<=1000),
 status text not null default 'pending' check(status in ('pending','approved','dismissed','replaced')),
 created_at timestamptz not null default now(),created_by uuid references pulse.person(id),decided_at timestamptz,decided_by uuid references pulse.person(id)
);
create table pulse.pool_proposal (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),batch_id uuid not null references pulse.pool_batch(id),
 position int not null default 0,title text not null check(length(title) between 1 and 300),notes text check(length(notes)<=4000),category text,
 project_id uuid references pulse.project(id),scope text not null check(scope in ('company','department','pod')),ref text check(length(ref)<=80),
 value_points smallint check(value_points between 1 and 100),estimate_minutes int check(estimate_minutes between 5 and 20000),
 task_ids uuid[] not null default '{}',evidence jsonb not null default '[]' check(jsonb_typeof(evidence)='array'),
 status text not null default 'pending' check(status in ('pending','published','removed','skipped')),published_task_id uuid references pulse.task(id),
 check(scope='company' or ref is not null)
);
create index pool_proposal_batch on pulse.pool_proposal(org_id,batch_id,position);
do $$ declare t text;begin
 foreach t in array array['pool_batch','pool_proposal'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant_isolation on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('create policy lead_read on pulse.%I as restrictive for select to pulse_api using(pulse.viewer_is(''admin'',''leadership'',''hr''))',t);
  execute format('grant select on pulse.%I to pulse_api',t);
 end loop;
end $$;

create function pulse.pool_require_lead() returns uuid language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or work_role()<>'leadership' then raise exception 'Leadership approves what goes in the pool' using errcode='42501';end if;
 return current_viewer();
end $$;

-- A batch from the API's evidence reader. A newer batch from the same source replaces a pending older one.
create function pulse.pool_batch_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=pool_require_lead();bid uuid;x jsonb;i int:=0;
begin
 if jsonb_typeof(p->'items')<>'array' or jsonb_array_length(p->'items')=0 then return null;end if;
 update pool_batch set status='replaced',decided_at=now(),decided_by=me where org_id=current_org() and source=p->>'source' and status='pending';
 insert into pool_batch(org_id,source,title,summary,created_by) values(current_org(),p->>'source',left(p->>'title',200),left(p->>'summary',1000),me) returning id into bid;
 for x in select * from jsonb_array_elements(p->'items') loop
  i:=i+1;
  insert into pool_proposal(org_id,batch_id,position,title,notes,category,project_id,scope,ref,value_points,estimate_minutes,task_ids,evidence)
  values(current_org(),bid,i,left(x->>'title',300),left(x->>'notes',4000),nullif(x->>'category',''),nullif(x->>'projectId','')::uuid,coalesce(x->>'scope','company'),nullif(x->>'ref',''),
   least(100,greatest(1,nullif(x->>'valuePoints','')::int)),nullif(x->>'estimateMinutes','')::int,
   coalesce(array(select y::uuid from jsonb_array_elements_text(coalesce(x->'taskIds','[]')) y),'{}'),coalesce(x->'evidence','[]'));
 end loop;
 return bid;
end $$;

-- Before approving: take an item out (or put it back), or change its value.
create function pulse.pool_proposal_edit(p_id uuid,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=pool_require_lead();
begin
 if not exists(select 1 from pool_proposal x join pool_batch b on b.id=x.batch_id where x.org_id=current_org() and x.id=p_id and b.status='pending' and x.status in ('pending','removed')) then
  raise exception 'This batch was already decided' using errcode='P0002';end if;
 update pool_proposal set status=case when p ? 'removed' then case when (p->>'removed')::boolean then 'removed' else 'pending' end else status end,
  value_points=case when p ? 'valuePoints' then least(100,greatest(1,(p->>'valuePoints')::int)) else value_points end where id=p_id;
 perform me;
end $$;

-- One click: every item still in the batch becomes a pool task (or pools the tracker tasks it names).
create function pulse.pool_batch_approve(p_id uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=pool_require_lead();b pool_batch;x pool_proposal;tid uuid;made int:=0;pooled int:=0;skipped int:=0;t uuid;
begin
 select * into b from pool_batch where org_id=current_org() and id=p_id for update;
 if not found or b.status<>'pending' then raise exception 'This batch was already decided' using errcode='P0002';end if;
 for x in select * from pool_proposal where org_id=current_org() and batch_id=p_id and status='pending' order by position loop
  if cardinality(x.task_ids)>0 then
   foreach t in array x.task_ids loop
    if exists(select 1 from task where org_id=current_org() and id=t and deleted_at is null and assignee_person_id is null and owner_id is null and status in ('open','unknown') and pool_scope is null) then
     perform task_save(t,jsonb_build_object('pool',jsonb_build_object('scope',x.scope,'ref',x.ref)));pooled:=pooled+1;
    else skipped:=skipped+1;end if;
   end loop;
   update pool_proposal set status='published' where id=x.id;
  else
   tid:=task_save(null,jsonb_strip_nulls(jsonb_build_object('title',x.title,'notes',x.notes,'projectId',x.project_id,'category',x.category,'estimateMinutes',x.estimate_minutes,
    'pool',jsonb_build_object('scope',x.scope,'ref',x.ref))));
   if x.value_points is not null then perform task_value_set(tid,jsonb_build_object('valuePoints',x.value_points));end if;
   update pool_proposal set status='published',published_task_id=tid where id=x.id;made:=made+1;
  end if;
 end loop;
 update pool_batch set status='approved',decided_at=now(),decided_by=me where id=p_id;
 perform audit_write('approve','pool_batch',p_id::text);
 return jsonb_build_object('made',made,'pooled',pooled,'skipped',skipped);
end $$;

create function pulse.pool_batch_dismiss(p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=pool_require_lead();
begin
 update pool_batch set status='dismissed',decided_at=now(),decided_by=me where org_id=current_org() and id=p_id and status='pending';
 if not found then raise exception 'This batch was already decided' using errcode='P0002';end if;
 perform audit_write('dismiss','pool_batch',p_id::text);
end $$;

revoke all on function pulse.pool_require_lead(),pulse.pool_batch_save(jsonb),pulse.pool_proposal_edit(uuid,jsonb),pulse.pool_batch_approve(uuid),pulse.pool_batch_dismiss(uuid) from public;
grant execute on function pulse.pool_require_lead(),pulse.pool_batch_save(jsonb),pulse.pool_proposal_edit(uuid,jsonb),pulse.pool_batch_approve(uuid),pulse.pool_batch_dismiss(uuid) to pulse_api;

-- migrate:down
-- Forward-only.

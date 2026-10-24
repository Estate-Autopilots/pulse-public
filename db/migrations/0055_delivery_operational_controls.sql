-- migrate:up
create or replace function pulse.portal_document_read(d uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare doc pulse_priv.portal_document%rowtype;paid numeric:=0;returned numeric:=0;total numeric;docbody jsonb;
begin
 select * into doc from pulse_priv.portal_document where org_id=current_org() and id=d;if not found then raise exception 'Client document unavailable' using errcode='42501';end if;
 perform portal_access(doc.project_id);docbody:=doc.body;
 if doc.kind='invoice' then
 select coalesce(sum(a.minor) filter(where dec.body->>'treatment'='payment'),0),coalesce(sum(a.minor) filter(where dec.body->>'treatment'='refund'),0) into paid,returned
 from pulse_priv.finance_allocation a join pulse_priv.finance_decision dec on dec.id=a.decision_id and dec.org_id=a.org_id where a.org_id=current_org() and a.source_id=(docbody->>'sourceId')::uuid and a.role='obligation' and a.active and dec.active;
 total:=(docbody->>'minor')::numeric;docbody:=docbody||jsonb_build_object('paid',paid,'refunded',returned,'balance',greatest(0,total-paid+returned),'status',case when paid-returned>=total then 'settled' when paid>returned then 'partially_settled' else 'issued' end);
 end if;
 return jsonb_build_object('id',doc.id,'kind',doc.kind,'revision',doc.revision,'body',docbody);
end $$;
alter table pulse_priv.delivery_blocker add column approved boolean not null default false;
create function pulse.delivery_blocker_approve(b uuid,a boolean,reason text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.delivery_task%rowtype;
begin select d.* into t from pulse_priv.delivery_task d join pulse_priv.delivery_blocker x on x.task_id=d.id where x.org_id=current_org() and x.id=b;perform delivery_access(t.project_id,true);
 if length(trim(reason))<3 then raise exception 'Blocker review reason required' using errcode='22023';end if;
 update pulse_priv.delivery_blocker set approved=a where org_id=current_org() and id=b;
 insert into pulse_priv.delivery_event(org_id,task_id,actor,kind,body) values(current_org(),t.id,current_viewer(),'blocker_review',jsonb_build_object('blockerId',b,'approved',a,'reason',reason));end $$;
create table pulse_priv.delivery_review_policy(org_id uuid not null references pulse.org(id),task_id uuid primary key references pulse.task(id),body jsonb not null,at timestamptz not null default now());
alter table pulse_priv.delivery_review_policy enable row level security;alter table pulse_priv.delivery_review_policy force row level security;
create policy tenant on pulse_priv.delivery_review_policy using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create trigger audit_mutation after insert or update or delete on pulse_priv.delivery_review_policy for each row execute function pulse.audit_mutation();
create function pulse.delivery_review_policy_set(tid uuid,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.delivery_task%rowtype;begin select * into t from pulse_priv.delivery_task where org_id=current_org() and id=tid;perform delivery_access(t.project_id,true);
 if t.state<>'ready_for_review' or p->>'version' is distinct from t.body->>'version' or coalesce(p->>'calendarName','')='' or coalesce(p->>'pauseConditions','')='' or coalesce(p->>'escalationOwner','')='' or jsonb_typeof(p->'intervals') is distinct from 'array' or (p->>'dueAt')::timestamptz<(p->>'startAt')::timestamptz then raise exception 'Exact review request named working calendar start deadline pause conditions and escalation owner required' using errcode='22023';end if;
 insert into pulse_priv.delivery_review_policy values(current_org(),tid,p,now()) on conflict(task_id) do update set body=excluded.body,at=excluded.at;
 insert into pulse_priv.delivery_event(org_id,task_id,actor,kind,body) values(current_org(),tid,current_viewer(),'review_agreement',p);end $$;
create function pulse.delivery_escalate(tid uuid,reason text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.delivery_task%rowtype;result uuid;policy jsonb;begin
 select * into t from pulse_priv.delivery_task where org_id=current_org() and id=tid;perform delivery_access(t.project_id,true);select body into policy from pulse_priv.delivery_review_policy where org_id=current_org() and task_id=tid;
 if policy is null or now()<=(policy->>'dueAt')::timestamptz or t.state<>'ready_for_review' or length(trim(reason))<3 then raise exception 'Active overdue agreed review and escalation reason required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('delivery:'||current_org()::text,0));
 select id into result from task where org_id=current_org() and source_ref='delivery-escalation:'||tid::text;
 if result is null then insert into task(org_id,project_id,title,owner_id,assignee_person_id,status,source,source_ref) values(current_org(),t.project_id,'Resolve agreed review handoff',t.owner_id,t.owner_id,'open','pulse','delivery-escalation:'||tid::text) returning id into result;end if;return result;
end $$;
create table pulse_priv.delivery_readiness(org_id uuid not null references pulse.org(id),project_id uuid primary key references pulse.project(id),body jsonb not null,at timestamptz not null default now());
alter table pulse_priv.delivery_readiness enable row level security;alter table pulse_priv.delivery_readiness force row level security;
create policy tenant on pulse_priv.delivery_readiness using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create trigger audit_mutation after insert or update or delete on pulse_priv.delivery_readiness for each row execute function pulse.audit_mutation();
create function pulse.delivery_readiness_set(pr uuid,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin perform delivery_access(pr,true);if jsonb_typeof(p->'checks') is distinct from 'array' or jsonb_array_length(p->'checks')<>5 or exists(select 1 from jsonb_array_elements(p->'checks') c where c->>'kind' not in('site','talent','shot_list','permission','footage') or c->>'done'='true' and length(coalesce(c->>'evidence',''))<3) or (select count(distinct c->>'kind') from jsonb_array_elements(p->'checks') c)<>5 then raise exception 'Five shoot readiness checks and explicit acceptance evidence required' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(p->'checks') c where c->>'kind'='footage' and c->>'done'='true') and p->>'actualShootAt' is null then raise exception 'Accepted footage needs a real verified shoot date' using errcode='22023';end if;
 if p->>'actualShootAt' is not null then perform (p->>'actualShootAt')::timestamptz;end if;
 insert into pulse_priv.delivery_readiness values(current_org(),pr,p,now()) on conflict(project_id) do update set body=excluded.body,at=excluded.at;end $$;
create function pulse.delivery_shoot_readiness(pr uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin perform delivery_access(pr);return jsonb_build_object('reviewed',(select body from pulse_priv.delivery_readiness where org_id=current_org() and project_id=pr),'checks',coalesce((select jsonb_agg(jsonb_build_object('id',id,'kind',input_kind,'accepted',false,'expectedAt',expected_at,'receivedAt',received_at)) from input where org_id=current_org() and project_id=pr),'[]'),'rule','Raw upload timestamps are observations; shoot requires reviewed site talent permissions shot list and accepted footage');end $$;
revoke all on function pulse.delivery_blocker_approve(uuid,boolean,text),pulse.delivery_review_policy_set(uuid,jsonb),pulse.delivery_escalate(uuid,text),pulse.delivery_shoot_readiness(uuid),pulse.delivery_readiness_set(uuid,jsonb) from public;
grant execute on function pulse.delivery_blocker_approve(uuid,boolean,text),pulse.delivery_review_policy_set(uuid,jsonb),pulse.delivery_escalate(uuid,text),pulse.delivery_shoot_readiness(uuid),pulse.delivery_readiness_set(uuid,jsonb) to pulse_api;
-- migrate:down

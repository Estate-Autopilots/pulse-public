-- migrate:up
-- Person-first task evidence. API has execute-only access to the private receipts.
create table pulse_priv.fair_baseline(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),task_id uuid not null references pulse.task(id),
 person_id uuid not null references pulse.person(id),family text not null,unit_kind text not null,weight numeric not null check(weight>0 and weight<=100),share numeric not null check(share>0 and share<=1),
 due date not null,eligible numeric not null check(eligible>=0),model text not null default 'ewu-convention-v1',reason text not null,authority uuid not null references pulse.person(id),
 effective_at timestamptz not null,supersedes uuid unique references pulse_priv.fair_baseline(id),at timestamptz not null default now());
create table pulse_priv.fair_credit(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),task_id uuid not null references pulse.task(id),acceptance_id uuid not null references pulse_priv.delivery_event(id),
 person_id uuid references pulse.person(id),family text not null,weight numeric not null check(weight>0 and weight<=100),share numeric not null check(share>0 and share<=1),
 version text not null,model text not null,reason text not null,authority uuid not null references pulse.person(id),
 supersedes uuid unique references pulse_priv.fair_credit(id),at timestamptz not null default now());
create table pulse_priv.fair_coverage(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),person_id uuid not null references pulse.person(id),
 start_on date not null,end_on date not null check(end_on>=start_on),expected int not null check(expected>0),detected int not null check(detected>=0 and detected<=expected),
 weeks int not null check(weeks>=0 and weeks<=52),source_state text not null check(source_state in('covered','outage','unknown')),
 reason text not null,authority uuid not null references pulse.person(id),at timestamptz not null default now());
create table pulse_priv.fair_projection(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),person_id uuid not null references pulse.person(id),score_id uuid not null references pulse.score(id),
 dimension text not null check(dimension in('delivery','quality','learning','market','flow')),state text not null check(state in('draft','self_visible','manager_visible','superseded')),
 review_after timestamptz,reviewer uuid not null references pulse.person(id),body jsonb not null,at timestamptz not null default now());
create table pulse_priv.fair_dispute(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),person_id uuid not null references pulse.person(id),dimension text not null,
 reason text not null,state text not null default 'open' check(state in('open','resolved')),resolution text,resolver uuid references pulse.person(id),at timestamptz not null default now());
create table pulse_priv.fair_access(
 org_id uuid not null references pulse.org(id),person_id uuid not null references pulse.person(id),manager_id uuid not null references pulse.person(id),purpose text not null check(purpose='supportive_coaching'),
 granted_at timestamptz not null default now(),revoked_at timestamptz,primary key(org_id,person_id,manager_id));
create table pulse_priv.fair_note(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),person_id uuid not null references pulse.person(id),task_id uuid not null references pulse.task(id),
 version text not null,author uuid not null references pulse.person(id),body jsonb not null,feedback text check(feedback in('useful','incorrect')),at timestamptz not null default now());
create table pulse_priv.fair_experiment(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),person_id uuid not null references pulse.person(id),note_id uuid not null references pulse_priv.fair_note(id),
 hypothesis text not null,skill text not null,anchor text not null,state text not null check(state in('chosen','reviewed')),sample uuid references pulse_priv.delivery_event(id),
 result text,reviewer uuid references pulse.person(id),before_value numeric,after_value numeric,at timestamptz not null default now(),unique(org_id,person_id,note_id));
create table pulse_priv.fair_preference(
 org_id uuid not null references pulse.org(id),person_id uuid primary key references pulse.person(id),extras boolean not null default true,reduced_motion boolean not null default true,sound boolean not null default false);
create table pulse_priv.fair_kudos(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),sender uuid not null references pulse.person(id),recipient uuid not null references pulse.person(id),
 message text not null,consented_at timestamptz,at timestamptz not null default now());
do $$declare t text;begin foreach t in array array['fair_baseline','fair_credit','fair_coverage','fair_projection','fair_dispute','fair_access','fair_note','fair_experiment','fair_preference','fair_kudos'] loop
 execute format('alter table pulse_priv.%I enable row level security',t);execute format('alter table pulse_priv.%I force row level security',t);
 execute format('create policy tenant on pulse_priv.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('create trigger audit_mutation after insert or update or delete on pulse_priv.%I for each row execute function pulse.audit_mutation()',t);
 end loop;end $$;
create function pulse.fair_self() returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
begin if current_viewer() is null or not exists(select 1 from person where id=current_viewer() and org_id=current_org() and side='staff' and status='active') or viewer_is('hr') then raise exception 'Individual work account required' using errcode='42501';end if;return current_viewer();end $$;
create function pulse.fair_review(pe uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin perform fair_self();if pe is null or pe=current_viewer() or not exists(select 1 from person where id=pe and org_id=current_org() and side='staff' and status='active') or not(viewer_is('admin','leadership') or manages(pe) or exists(select 1 from pulse_priv.delivery_task where org_id=current_org() and assignee_id=pe and reviewer_id=current_viewer())) then raise exception 'Independent accountable reviewer required' using errcode='42501';end if;end $$;
create function pulse.fair_baseline_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.delivery_task%rowtype;old pulse_priv.fair_baseline%rowtype;pe uuid:=(p->>'personId')::uuid;nid uuid;w numeric;sh numeric:=(p->>'share')::numeric;eff timestamptz:=(p->>'effectiveAt')::timestamptz;
begin
 perform fair_review(pe);select * into t from pulse_priv.delivery_task where org_id=current_org() and id=(p->>'taskId')::uuid;perform delivery_access(t.project_id,true);
 perform pg_advisory_xact_lock(hashtextextended('fair:'||current_org()::text,0));
 if t.id is null or length(trim(coalesce(p->>'reason','')))<3 or eff is null or eff>now()+interval '5 minutes' or length(coalesce(p->>'family','')) not between 1 and 160 then raise exception 'Reviewed task family reason and effective date required' using errcode='22023';end if;
 if exists(select 1 from pulse_priv.delivery_event where org_id=current_org() and task_id=t.id and kind='accepted') then raise exception 'New commitment cannot follow acceptance' using errcode='22023';end if;
 select * into old from pulse_priv.fair_baseline where id=nullif(p->>'supersedes','')::uuid and org_id=current_org();
 if old.id is null and exists(select 1 from pulse_priv.fair_baseline b where org_id=current_org() and task_id=t.id and person_id=pe and not exists(select 1 from pulse_priv.fair_baseline x where x.supersedes=b.id)) then raise exception 'Baseline amendment must name original receipt' using errcode='40001';end if;
 w:=case p->>'unitKind' when 'main_video' then 4 when 'vov' then 2 when 'hook' then 1 when 'image' then .5 when 'carousel_card' then .25 when 'reviewed_other' then (p->>'weight')::numeric end;
 if w is null or sh is null or sh<=0 or sh>1 or p->>'due' is null or (p->>'eligible')::numeric is null or (p->>'eligible')::numeric not between 0 and w*sh then raise exception 'Frozen convention weight share due and eligibility required' using errcode='22023';end if;
 if old.id is not null and (old.task_id<>t.id or old.person_id<>pe or old.family<>p->>'family' or old.weight<>w or old.share<>sh or old.effective_at>eff or exists(select 1 from pulse_priv.fair_credit where org_id=current_org() and task_id=t.id)) then raise exception 'Amendment cannot rewrite accepted identity weight or shares' using errcode='22023';end if;
 if coalesce((select sum(share) from pulse_priv.fair_baseline b where org_id=current_org() and family=p->>'family' and b.id is distinct from old.id and not exists(select 1 from pulse_priv.fair_baseline x where x.supersedes=b.id)),0)+sh>1 then raise exception 'Family collaborator shares exceed one' using errcode='22023';end if;
 insert into pulse_priv.fair_baseline(org_id,task_id,person_id,family,unit_kind,weight,share,due,eligible,reason,authority,effective_at,supersedes)
 values(current_org(),t.id,pe,p->>'family',p->>'unitKind',w,sh,(p->>'due')::date,(p->>'eligible')::numeric,p->>'reason',current_viewer(),eff,old.id) returning id into nid;update pulse_priv.fair_projection set state='superseded' where org_id=current_org() and person_id=pe and dimension='delivery';return nid;
end $$;
create function pulse.fair_credit_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare e pulse_priv.delivery_event%rowtype;b pulse_priv.fair_baseline%rowtype;old pulse_priv.fair_credit%rowtype;pe uuid:=nullif(p->>'personId','')::uuid;sh numeric:=(p->>'share')::numeric;nid uuid;fam text:=p->>'family';
begin
 perform fair_self();select * into e from pulse_priv.delivery_event where org_id=current_org() and id=(p->>'acceptanceId')::uuid and kind='accepted';
 if e.id is null or e.actor<>current_viewer() or e.body->>'reviewerId' is distinct from current_viewer()::text then raise exception 'Exact acceptance reviewer must confirm creator evidence' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('fair:'||current_org()::text,0));
 if p->>'basis' is distinct from 'human_confirmed' or pe=current_viewer() or (pe is not null and not exists(select 1 from person where org_id=current_org() and id=pe and side='staff')) or length(trim(coalesce(p->>'reason','')))<3 or length(coalesce(fam,'')) not between 1 and 160 or sh is null then raise exception 'Independent creator confirmation family shares and basis required' using errcode='22023';end if;
 select * into old from pulse_priv.fair_credit where id=nullif(p->>'supersedes','')::uuid and org_id=current_org();
 if old.id is not null and (old.acceptance_id<>e.id or old.family<>fam) then raise exception 'Correction must retain accepted event and family' using errcode='22023';end if;
 if old.id is null and exists(select 1 from pulse_priv.fair_credit c where org_id=current_org() and family=fam and person_id is not distinct from pe and not exists(select 1 from pulse_priv.fair_credit x where x.supersedes=c.id)) then raise exception 'Family already credited use correction receipt' using errcode='23505';end if;
 select * into b from pulse_priv.fair_baseline where org_id=current_org() and task_id=e.task_id and family=fam and person_id=pe and effective_at<=e.at order by effective_at desc,at desc limit 1;
 if old.id is null and b.id is null and (p->>'weight')::numeric is null then raise exception 'Uncommitted work needs reviewed unit convention' using errcode='22023';end if;
 if not exists(select 1 from version v join asset a on a.id=v.asset_id where v.org_id=current_org() and a.org_id=current_org() and v.id::text=e.body->>'version' and fam=a.project_id::text||':'||coalesce(a.family,a.id::text)) then raise exception 'Credit family must match canonical accepted asset family' using errcode='22023';end if;
 if coalesce((select sum(share) from pulse_priv.fair_credit c where org_id=current_org() and family=fam and c.id is distinct from old.id and not exists(select 1 from pulse_priv.fair_credit x where x.supersedes=c.id)),0)+sh>1 then raise exception 'Accepted family shares exceed one' using errcode='22023';end if;
 if exists(select 1 from pulse_priv.fair_credit c where org_id=current_org() and family=fam and c.weight<>coalesce(old.weight,b.weight,(p->>'weight')::numeric)) then raise exception 'Family weight convention must remain frozen' using errcode='22023';end if;
 if b.id is not null and sh<>b.share then raise exception 'Credit must use frozen collaborator share' using errcode='22023';end if;
 insert into pulse_priv.fair_credit(org_id,task_id,acceptance_id,person_id,family,weight,share,version,model,reason,authority,supersedes)
 values(current_org(),e.task_id,e.id,pe,fam,coalesce(old.weight,b.weight,(p->>'weight')::numeric),sh,e.body->>'version',coalesce(old.model,b.model,'ewu-convention-v1'),p->>'reason',current_viewer(),old.id) returning id into nid;
 update pulse_priv.fair_projection set state='superseded' where org_id=current_org() and dimension='delivery' and person_id in(pe,old.person_id);
 return nid;
end $$;
create function pulse.fair_coverage_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pe uuid:=(p->>'personId')::uuid;nid uuid;begin perform fair_review(pe);
 if length(trim(coalesce(p->>'reason','')))<3 or (p->>'end')::date>current_date or ((p->>'end')::date-(p->>'start')::date+1)<(p->>'weeks')::int*7 then raise exception 'Completed coverage window and independent source control required' using errcode='22023';end if;
 insert into pulse_priv.fair_coverage(org_id,person_id,start_on,end_on,expected,detected,weeks,source_state,reason,authority)
 values(current_org(),pe,(p->>'start')::date,(p->>'end')::date,(p->>'expected')::int,(p->>'detected')::int,(p->>'weeks')::int,p->>'state',p->>'reason',current_viewer()) returning id into nid;
 update pulse_priv.fair_projection set state='superseded' where org_id=current_org() and person_id=pe and dimension='delivery';return nid;end $$;
create function pulse.fair_delivery(pe uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cov pulse_priv.fair_coverage%rowtype;num numeric:=0;den numeric:=0;orig numeric:=0;units int:=0;unc numeric:=0;begin
 select * into cov from pulse_priv.fair_coverage where org_id=current_org() and person_id=pe order by at desc,id desc limit 1;
 select coalesce(sum(b.eligible),0),coalesce(sum(b.weight*b.share),0) into den,orig from pulse_priv.fair_baseline b where b.org_id=current_org() and b.person_id=pe and b.due between cov.start_on and cov.end_on and not exists(select 1 from pulse_priv.fair_baseline x where x.supersedes=b.id);
 select coalesce(sum(least(c.weight*c.share,b.eligible)),0),count(distinct c.family)::int into num,units from pulse_priv.fair_credit c join pulse_priv.delivery_event e on e.id=c.acceptance_id
 join pulse_priv.fair_baseline b on b.org_id=c.org_id and b.task_id=c.task_id and b.person_id=c.person_id and b.family=c.family
 where c.org_id=current_org() and c.person_id=pe and b.due between cov.start_on and cov.end_on and e.at::date<=cov.end_on and not exists(select 1 from pulse_priv.fair_credit x where x.supersedes=c.id) and not exists(select 1 from pulse_priv.fair_baseline x where x.supersedes=b.id);
 select coalesce(sum(c.weight*c.share),0) into unc from pulse_priv.fair_credit c join pulse_priv.delivery_event e on e.id=c.acceptance_id where c.org_id=current_org() and c.person_id=pe and e.at::date between cov.start_on and cov.end_on and not exists(select 1 from pulse_priv.fair_credit x where x.supersedes=c.id) and not exists(select 1 from pulse_priv.fair_baseline b where b.org_id=c.org_id and b.task_id=c.task_id and b.person_id=c.person_id and b.family=c.family);
 return jsonb_build_object('numerator',num,'denominator',den,'original',orig,'sample',units,'uncommitted',unc,'coverage',case when cov.id is not null then cov.detected::numeric/cov.expected end,'window',case when cov.id is not null then cov.start_on::text||' – '||cov.end_on::text else 'No covered window' end,
 'start',cov.start_on,'end',cov.end_on,'weeks',coalesce(cov.weeks,0),'sourceState',coalesce(cov.source_state,'unknown'),'gate',cov.source_state='covered' and cov.weeks>=3 and cov.detected::numeric/cov.expected>=.9 and units>=4 and den>0);
end $$;
create function pulse.fair_publish(pe uuid,action text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d jsonb;sc uuid;nid uuid;pr pulse_priv.fair_projection%rowtype;dt timestamptz;days int:=0;begin
 perform fair_review(pe);perform pg_advisory_xact_lock(hashtextextended('fair:'||current_org()::text,0));
 if action='prepare' then
 d:=fair_delivery(pe);if d->>'start' is null then raise exception 'Establish coverage before preparing a measure' using errcode='22023';end if;
 update pulse_priv.fair_projection set state='superseded' where org_id=current_org() and person_id=pe and dimension='delivery';
 insert into score(org_id,subject_type,subject_id,metric,period_start,period_end,value,n_effective,sufficiency,explanation,model_name,model_version,visibility)
 values(current_org(),'person',pe,'fair_delivery',(d->>'start')::date,(d->>'end')::date,case when (d->>'denominator')::numeric>0 then (d->>'numerator')::numeric/(d->>'denominator')::numeric end,(d->>'sample')::int,case when coalesce((d->>'gate')::boolean,false) then 'enough' else 'thin' end,d,'fair-work','v1','person') returning id into sc;
 dt:=now();while days<2 loop dt:=dt+interval '1 day';if extract(isodow from dt)<6 then days:=days+1;end if;end loop;
 insert into pulse_priv.fair_projection(org_id,person_id,score_id,dimension,state,review_after,reviewer,body) values(current_org(),pe,sc,'delivery','self_visible',dt,current_viewer(),d) returning id into nid;return nid;
 elsif action='publish' then
 select * into pr from pulse_priv.fair_projection where org_id=current_org() and person_id=pe and dimension='delivery' and state='self_visible' order by at desc limit 1 for update;
 d:=fair_delivery(pe);
 if pr.id is null or now()<pr.review_after or not coalesce((d->>'gate')::boolean,false) or d<>pr.body or exists(select 1 from pulse_priv.fair_dispute where org_id=current_org() and person_id=pe and dimension='delivery' and state='open') then raise exception 'Self review window evidence and dispute gate must pass' using errcode='42501';end if;
 update pulse_priv.fair_projection set state='manager_visible' where id=pr.id;return pr.id;
 else raise exception 'Choose prepare or publish' using errcode='22023';end if;
end $$;
create function pulse.fair_dispute_save(dim text,reason text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pe uuid:=fair_self();nid uuid;begin
 if dim not in('delivery','quality','learning','market','flow') or length(trim(reason)) not between 3 and 1000 then raise exception 'Dimension and correction reason required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('fair:'||current_org()::text,0));
 insert into pulse_priv.fair_dispute(org_id,person_id,dimension,reason) values(current_org(),pe,dim,reason) returning id into nid;
 update pulse_priv.fair_projection set state='superseded' where org_id=current_org() and person_id=pe and dimension=dim;
 -- No pending brief may outlive the employee's hold. Existing briefs are invalidated by read-time gates below.
 return nid;end $$;
create function pulse.fair_resolve(i uuid,reason text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d pulse_priv.fair_dispute%rowtype;begin select * into d from pulse_priv.fair_dispute where org_id=current_org() and id=i for update;perform fair_review(d.person_id);
 if d.state<>'open' or length(trim(reason))<3 then raise exception 'Open correction and resolution reason required' using errcode='22023';end if;
 update pulse_priv.fair_dispute set state='resolved',resolution=fair_resolve.reason,resolver=current_viewer() where id=i;
 update pulse_priv.fair_projection set state='superseded' where org_id=current_org() and person_id=d.person_id and dimension=d.dimension;
 end $$;
create function pulse.fair_access_set(manager uuid,grant_access boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pe uuid:=fair_self();begin
 if manager=pe or not exists(select 1 from person where org_id=current_org() and id=manager and status='active' and side='staff') then raise exception 'Choose an active manager' using errcode='22023';end if;
 insert into pulse_priv.fair_access(org_id,person_id,manager_id,purpose,revoked_at) values(current_org(),pe,manager,'supportive_coaching',case when not grant_access then now() end)
 on conflict(org_id,person_id,manager_id) do update set revoked_at=excluded.revoked_at,granted_at=now();end $$;
create function pulse.fair_note_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pe uuid:=(p->>'personId')::uuid;t pulse_priv.delivery_task%rowtype;nid uuid;begin perform fair_review(pe);
 select * into t from pulse_priv.delivery_task where org_id=current_org() and id=(p->>'taskId')::uuid;perform delivery_access(t.project_id);
 if current_viewer()<>t.reviewer_id then raise exception 'Current independent artifact reviewer required' using errcode='42501';end if;
 if not exists(select 1 from pulse_priv.fair_credit where org_id=current_org() and task_id=t.id and person_id=pe and version=p->>'version') or p->>'purpose' is distinct from 'permitted_artifact_review' or length(trim(coalesce(p->>'consentReceipt','')))<3 or length(trim(coalesce(p->>'approvedContext','')))<3 or length(trim(coalesce(p->>'observation','')))<3 or length(trim(coalesce(p->>'reason','')))<3 or length(trim(coalesce(p->>'anchor','')))<3 or length(trim(coalesce(p->>'skill','')))<3 or jsonb_typeof(p->'experiments') is distinct from 'array' or jsonb_array_length(p->'experiments')<>2 or exists(select 1 from jsonb_array_elements_text(p->'experiments') a where length(a) not between 3 and 1000) then raise exception 'Exact version permitted artifact context stable anchor and two experiments required' using errcode='22023';end if;
 if p->>'reworkReason' is not null and p->>'reworkReason' not in('scope_change','client_preference','missing_input','technical_correction','confirmed_craft_defect') then raise exception 'Separate reviewed rework reason required' using errcode='22023';end if;
 insert into pulse_priv.fair_note(org_id,person_id,task_id,version,author,body) values(current_org(),pe,t.id,p->>'version',current_viewer(),jsonb_build_object('observation',left(p->>'observation',1000),'reason',left(p->>'reason',1000),'experiments',p->'experiments','skill',p->>'skill','anchor',p->>'anchor','timecode',p->>'timecode','purpose',p->>'purpose','consentReceipt',p->>'consentReceipt','approvedContext',p->>'approvedContext','reworkReason',p->>'reworkReason','state','helpful_note')) returning id into nid;return nid;end $$;
create function pulse.fair_note_feedback(i uuid,feedback text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin perform fair_self();if feedback not in('useful','incorrect') then raise exception 'Choose useful or incorrect' using errcode='22023';end if;
 update pulse_priv.fair_note n set feedback=fair_note_feedback.feedback where org_id=current_org() and id=i and person_id=current_viewer();if not found then raise exception 'Private note unavailable' using errcode='42501';end if;end $$;
create function pulse.fair_experiment_choose(i uuid,choice int) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n pulse_priv.fair_note%rowtype;nid uuid;begin perform fair_self();select * into n from pulse_priv.fair_note where org_id=current_org() and id=i and person_id=current_viewer();
 if n.id is null or choice not in(0,1) then raise exception 'Choose one experiment from your private note' using errcode='42501';end if;
 insert into pulse_priv.fair_experiment(org_id,person_id,note_id,hypothesis,skill,anchor,state) values(current_org(),current_viewer(),n.id,n.body->'experiments'->>choice,n.body->>'skill',n.body->>'anchor','chosen') on conflict(org_id,person_id,note_id) do nothing returning id into nid;
 return coalesce(nid,(select id from pulse_priv.fair_experiment where org_id=current_org() and person_id=current_viewer() and note_id=i));end $$;
create function pulse.fair_experiment_review(p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare x pulse_priv.fair_experiment%rowtype;e pulse_priv.delivery_event%rowtype;begin
 select * into x from pulse_priv.fair_experiment where org_id=current_org() and id=(p->>'id')::uuid for update;perform fair_review(x.person_id);
 select * into e from pulse_priv.delivery_event where org_id=current_org() and id=(p->>'sample')::uuid and kind='accepted';
 if x.state<>'chosen' or e.id is null or e.actor<>current_viewer() or e.at<x.at or p->>'anchor' is distinct from x.anchor or not exists(select 1 from pulse_priv.fair_credit where org_id=current_org() and acceptance_id=e.id and person_id=x.person_id) or length(trim(coalesce(p->>'result','')))<3 or (p->>'before')::numeric not between 1 and 5 or (p->>'after')::numeric not between 1 and 5 or p->>'before' is null or p->>'after' is null then raise exception 'New accepted sample independent reviewer and same stable anchor required' using errcode='22023';end if;
 update pulse_priv.fair_experiment set sample=e.id,result=p->>'result',before_value=(p->>'before')::numeric,after_value=(p->>'after')::numeric,reviewer=current_viewer(),state='reviewed' where id=x.id;end $$;
create function pulse.fair_preference_set(p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin perform fair_self();insert into pulse_priv.fair_preference(org_id,person_id,extras,reduced_motion,sound) values(current_org(),current_viewer(),(p->>'extras')::boolean,(p->>'reducedMotion')::boolean,(p->>'sound')::boolean)
 on conflict(person_id) do update set extras=excluded.extras,reduced_motion=excluded.reduced_motion,sound=excluded.sound;end $$;
create function pulse.fair_kudos_send(recipient uuid,message text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare nid uuid;begin perform fair_self();if recipient=current_viewer() or not exists(select 1 from person where org_id=current_org() and id=recipient and side='staff' and status='active') or length(trim(message)) not between 3 and 240 then raise exception 'Real colleague and short private kudos required' using errcode='22023';end if;
 insert into pulse_priv.fair_kudos(org_id,sender,recipient,message) values(current_org(),current_viewer(),recipient,message) returning id into nid;return nid;end $$;
create function pulse.fair_state(pe uuid default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare own boolean;target uuid:=coalesce(pe,fair_self());begin perform fair_self();own:=target=current_viewer();
 if not own and not((manages(target) or viewer_is('admin','leadership')) and exists(select 1 from pulse_priv.fair_access where org_id=current_org() and person_id=target and manager_id=current_viewer() and purpose='supportive_coaching' and revoked_at is null)) then raise exception 'Current purpose and employee access required' using errcode='42501';end if;
 return jsonb_build_object('self',own,'viewer',current_viewer(),'person',(select display_name from person where id=target and org_id=current_org()),
 'delivery',case when own then fair_delivery(target) end,
 'projections',coalesce((select jsonb_agg(jsonb_build_object('id',id,'dimension',dimension,'state',state,'reviewAfter',review_after,'body',body)) from pulse_priv.fair_projection p where org_id=current_org() and person_id=target and state<>'superseded' and (own or state='manager_visible' and not exists(select 1 from pulse_priv.fair_dispute where org_id=current_org() and person_id=target and dimension=p.dimension and state='open'))),'[]'),
 'receipts',case when own then coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'taskId',b.task_id,'title',t.body->>'title','project',(select coalesce(title,name) from project where id=t.project_id),'family',b.family,'weight',b.weight,'share',b.share,'due',b.due,'personId',b.person_id,'original',b.weight*b.share,'eligible',b.eligible,'reason',case when b.supersedes is not null then b.reason end,'version',c.version,'acceptedAt',e.at,'source','Native exact-version acceptance','basis',coalesce(c.reason,'Reviewed planned commitment'),'reviewer',(select display_name from person where id=c.authority),'blocked',exists(select 1 from pulse_priv.delivery_blocker where org_id=current_org() and task_id=t.id and ended_at is null))) from pulse_priv.fair_baseline b join pulse_priv.delivery_task t on t.id=b.task_id
 left join pulse_priv.fair_credit c on c.org_id=b.org_id and c.task_id=b.task_id and c.person_id=b.person_id and c.family=b.family and not exists(select 1 from pulse_priv.fair_credit x where x.supersedes=c.id) left join pulse_priv.delivery_event e on e.id=c.acceptance_id
 where b.org_id=current_org() and b.person_id=target and not exists(select 1 from pulse_priv.fair_baseline x where x.supersedes=b.id)),'[]') else '[]'::jsonb end,
 'flowRecords',case when own then coalesce((select jsonb_agg(jsonb_build_object('taskId',t.id,'end',e.at,'start',(select min(at) from pulse_priv.delivery_event s where s.org_id=current_org() and s.task_id=t.id and s.kind='in_progress' and s.at<=e.at),'calendar',coalesce(pl.calendar->'intervals','[]'),'blockers',coalesce((select jsonb_agg(jsonb_build_object('start',started_at,'end',coalesce(ended_at,e.at),'approved',approved,'actionable',false)) from pulse_priv.delivery_blocker bl where bl.org_id=current_org() and bl.task_id=t.id and approved and not contested and kind in('input','approval','client_approval','source_outage')),'[]'))) from pulse_priv.delivery_task t join pulse_priv.delivery_event e on e.task_id=t.id and e.kind='accepted' left join pulse_priv.delivery_plan pl on pl.org_id=t.org_id and pl.project_id=t.project_id where t.org_id=current_org() and exists(select 1 from pulse_priv.fair_credit c where c.org_id=current_org() and c.acceptance_id=e.id and c.person_id=target and not exists(select 1 from pulse_priv.fair_credit x where x.supersedes=c.id))),'[]') else '[]'::jsonb end,
 'reviewRecords',case when own then coalesce((select jsonb_agg(jsonb_build_object('taskId',t.id,'policy',p.body,'reply',(select min(at) from pulse_priv.delivery_event e where e.org_id=current_org() and e.task_id=t.id and e.actor=target and e.kind in('accepted','in_progress') and e.at>=(p.body->>'startAt')::timestamptz))) from pulse_priv.delivery_task t join pulse_priv.delivery_review_policy p on p.org_id=t.org_id and p.task_id=t.id where t.org_id=current_org() and t.reviewer_id=target),'[]') else '[]'::jsonb end,
 'notes',case when own then coalesce((select jsonb_agg(body||jsonb_build_object('id',id,'version',version,'feedback',feedback)) from pulse_priv.fair_note where org_id=current_org() and person_id=target),'[]') else '[]'::jsonb end,
 'experiments',case when own then coalesce((select jsonb_agg(jsonb_build_object('id',id,'skill',skill,'hypothesis',hypothesis,'anchor',anchor,'state',state,'sample',sample,'result',result,'before',before_value,'after',after_value)) from pulse_priv.fair_experiment where org_id=current_org() and person_id=target),'[]') else '[]'::jsonb end,
 'disputes',case when own then coalesce((select jsonb_agg(jsonb_build_object('id',id,'dimension',dimension,'reason',reason,'state',state,'resolution',resolution)) from pulse_priv.fair_dispute where org_id=current_org() and person_id=target),'[]') else '[]'::jsonb end,
 'kudos',case when own then coalesce((select jsonb_agg(jsonb_build_object('id',k.id,'sender',p.display_name,'text',message)) from pulse_priv.fair_kudos k join person p on p.id=k.sender where k.org_id=current_org() and k.recipient=target),'[]') else '[]'::jsonb end,
 'preferences',coalesce((select jsonb_build_object('extras',extras,'reducedMotion',reduced_motion,'sound',sound) from pulse_priv.fair_preference where org_id=current_org() and person_id=current_viewer()),'{"extras":true,"reducedMotion":true,"sound":false}'),
 'permissions',jsonb_build_object('review',viewer_is('admin','leadership') or exists(select 1 from person where org_id=current_org() and id<>current_viewer() and manages(id))));end $$;
create function pulse.fair_review_options() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin perform fair_self();return jsonb_build_object(
 'people',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',display_name)) from person where org_id=current_org() and side='staff' and status='active'),'[]'),
 'tasks',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'title',t.body->>'title','assigneeId',assignee_id,'reviewerId',reviewer_id,'state',state,'due',t.body->>'due')) from pulse_priv.delivery_task t where org_id=current_org() and (reviewer_id=current_viewer() or owner_id=current_viewer() or viewer_is('admin','leadership'))),'[]'),
 'acceptances',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'taskId',e.task_id,'version',e.body->>'version','at',e.at,'family',(select a.project_id::text||':'||coalesce(a.family,a.id::text) from version v join asset a on a.id=v.asset_id where v.id::text=e.body->>'version'))) from pulse_priv.delivery_event e where org_id=current_org() and kind='accepted' and actor=current_viewer()),'[]'),
 'corrections',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'personId',d.person_id,'dimension',dimension,'reason',reason,'state',state)) from pulse_priv.fair_dispute d where org_id=current_org() and state='open' and (viewer_is('admin','leadership') or manages(d.person_id))),'[]'));
end $$;
create function pulse.fair_version_immutable() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin if to_jsonb(new) is distinct from to_jsonb(old) and exists(select 1 from pulse_priv.delivery_event where org_id=old.org_id and kind='accepted' and body->>'version'=old.id::text) then raise exception 'Accepted version is immutable create a new version' using errcode='40001';end if;return new;end $$;
create trigger fair_version_immutable before update on pulse.version for each row execute function pulse.fair_version_immutable();
-- The callable contract is intentionally narrow; no direct private-table grant exists.
do $$declare f regprocedure;begin for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='pulse' and p.proname like 'fair_%' loop
 execute format('revoke all on function %s from public',f);end loop;end $$;
grant execute on function pulse.fair_baseline_save(jsonb),pulse.fair_credit_save(jsonb),pulse.fair_coverage_save(jsonb),pulse.fair_publish(uuid,text),pulse.fair_dispute_save(text,text),pulse.fair_resolve(uuid,text),pulse.fair_access_set(uuid,boolean),pulse.fair_note_save(jsonb),pulse.fair_note_feedback(uuid,text),pulse.fair_experiment_choose(uuid,int),pulse.fair_experiment_review(jsonb),pulse.fair_preference_set(jsonb),pulse.fair_kudos_send(uuid,text),pulse.fair_state(uuid),pulse.fair_review_options() to pulse_api;
insert into pulse.model_registry(name,version,kind,status,eval_report) values
 ('fair-work','v1','rules','shadow','{"intendedUse":"transparent task-derived supportive coaching","excludedUse":["pay","discipline","promotion","attendance productivity","chat analysis"],"weights":"provisional frozen EWU convention v1","minimumDeliveryPilot":{"weeks":3,"acceptedUnits":4,"coverage":0.9},"calibration":"Human creator labels and role-specific opportunity review required","rollback":"supersede projection; retain receipt"}'),
 ('craft-critique','v1','rules','shadow','{"intendedUse":"permitted exact-version helpful notes","scored":false,"minimumAssetsProposed":50,"reviewersProposed":2,"heldOutProposed":{"precision":0.9,"recall":0.8,"rankCorrelation":0.6},"promotion":"Independent per-dimension expert review with uncertainty required"}');
-- migrate:down

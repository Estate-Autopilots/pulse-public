-- migrate:up
-- Incomplete person requests abstain before any mutation; invalid values never become missing/zero evidence.
create or replace function pulse.fair_preference_set(p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin perform fair_self();if jsonb_typeof(p->'extras') is distinct from 'boolean' or jsonb_typeof(p->'reducedMotion') is distinct from 'boolean' or jsonb_typeof(p->'sound') is distinct from 'boolean' then raise exception 'Engagement reduced motion and sound choices required' using errcode='22023';end if;insert into pulse_priv.fair_preference(org_id,person_id,extras,reduced_motion,sound) values(current_org(),current_viewer(),(p->>'extras')::boolean,(p->>'reducedMotion')::boolean,(p->>'sound')::boolean)
 on conflict(person_id) do update set extras=excluded.extras,reduced_motion=excluded.reduced_motion,sound=excluded.sound;end $$;
create or replace function pulse.fair_note_feedback(i uuid,feedback text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin perform fair_self();if feedback is null or feedback not in('useful','incorrect') then raise exception 'Choose useful or incorrect' using errcode='22023';end if;
 update pulse_priv.fair_note n set feedback=fair_note_feedback.feedback where org_id=current_org() and id=i and person_id=current_viewer();if not found then raise exception 'Private note unavailable' using errcode='42501';end if;end $$;
create or replace function pulse.fair_experiment_choose(i uuid,choice int) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n pulse_priv.fair_note%rowtype;nid uuid;begin perform fair_self();select * into n from pulse_priv.fair_note where org_id=current_org() and id=i and person_id=current_viewer();
 if n.id is null or choice is null or choice not in(0,1) then raise exception 'Choose one experiment from your private note' using errcode='42501';end if;
 insert into pulse_priv.fair_experiment(org_id,person_id,note_id,hypothesis,skill,anchor,state) values(current_org(),current_viewer(),n.id,n.body->'experiments'->>choice,n.body->>'skill',n.body->>'anchor','chosen') on conflict(org_id,person_id,note_id) do nothing returning id into nid;
 return coalesce(nid,(select id from pulse_priv.fair_experiment where org_id=current_org() and person_id=current_viewer() and note_id=i));end $$;
create or replace function pulse.fair_coverage_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pe uuid:=(p->>'personId')::uuid;nid uuid;begin perform fair_review(pe);
 if p->>'start' is null or p->>'end' is null or p->>'expected' is null or p->>'detected' is null or p->>'weeks' is null or p->>'state' is null or length(trim(coalesce(p->>'reason','')))<3 or (p->>'end')::date>current_date or ((p->>'end')::date-(p->>'start')::date+1)<(p->>'weeks')::int*7 then raise exception 'Completed coverage window and independent source control required' using errcode='22023';end if;
 insert into pulse_priv.fair_coverage(org_id,person_id,start_on,end_on,expected,detected,weeks,source_state,reason,authority)
 values(current_org(),pe,(p->>'start')::date,(p->>'end')::date,(p->>'expected')::int,(p->>'detected')::int,(p->>'weeks')::int,p->>'state',p->>'reason',current_viewer()) returning id into nid;
 update pulse_priv.fair_projection set state='superseded' where org_id=current_org() and person_id=pe and dimension='delivery';return nid;end $$;
create or replace function pulse.fair_dispute_save(dim text,reason text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pe uuid:=fair_self();nid uuid;begin
 if dim is null or reason is null or dim not in('delivery','quality','learning','market','flow') or length(trim(reason)) not between 3 and 1000 then raise exception 'Dimension and correction reason required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('fair:'||current_org()::text,0));
 insert into pulse_priv.fair_dispute(org_id,person_id,dimension,reason) values(current_org(),pe,dim,reason) returning id into nid;
 update pulse_priv.fair_projection set state='superseded' where org_id=current_org() and person_id=pe and dimension=dim;
 -- No pending brief may outlive the employee's hold. Existing briefs are invalidated by read-time gates below.
 return nid;end $$;
create or replace function pulse.fair_credit_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
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
 if not exists(select 1 from version v join asset a on a.id=v.asset_id where v.org_id=current_org() and a.org_id=current_org() and v.id::text=e.body->>'version' and fam=a.project_id::text||':'||coalesce(a.family,a.parent_asset_id::text,a.id::text)) then raise exception 'Credit family must match canonical accepted asset family' using errcode='22023';end if;
 if coalesce((select sum(share) from pulse_priv.fair_credit c where org_id=current_org() and family=fam and c.id is distinct from old.id and not exists(select 1 from pulse_priv.fair_credit x where x.supersedes=c.id)),0)+sh>1 then raise exception 'Accepted family shares exceed one' using errcode='22023';end if;
 if exists(select 1 from pulse_priv.fair_credit c where org_id=current_org() and family=fam and c.weight<>coalesce(old.weight,b.weight,(p->>'weight')::numeric)) then raise exception 'Family weight convention must remain frozen' using errcode='22023';end if;
 if b.id is not null and sh<>b.share then raise exception 'Credit must use frozen collaborator share' using errcode='22023';end if;
 insert into pulse_priv.fair_credit(org_id,task_id,acceptance_id,person_id,family,weight,share,version,model,reason,authority,supersedes)
 values(current_org(),e.task_id,e.id,pe,fam,coalesce(old.weight,b.weight,(p->>'weight')::numeric),sh,e.body->>'version',coalesce(old.model,b.model,'ewu-convention-v1'),p->>'reason',current_viewer(),old.id) returning id into nid;
 update pulse_priv.fair_projection set state='superseded' where org_id=current_org() and dimension='delivery' and person_id in(pe,old.person_id);
 return nid;
end $$;
create function pulse.fair_family_immutable() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin if (new.family,new.parent_asset_id,new.project_id) is distinct from (old.family,old.parent_asset_id,old.project_id) and exists(select 1 from version v join pulse_priv.delivery_event e on e.body->>'version'=v.id::text and e.org_id=old.org_id and e.kind='accepted' where v.asset_id=old.id and v.org_id=old.org_id) then raise exception 'Accepted asset family identity is immutable' using errcode='40001';end if;return new;end $$;
create trigger fair_family_immutable before update on pulse.asset for each row execute function pulse.fair_family_immutable();
revoke all on function pulse.fair_family_immutable() from public;
create or replace function pulse.fair_review_options() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin perform fair_self();return jsonb_build_object(
 'people',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',display_name)) from person where org_id=current_org() and side='staff' and status='active'),'[]'),
 'baselines',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'taskId',b.task_id,'personId',b.person_id,'family',b.family,'unitKind',b.unit_kind,'weight',b.weight,'share',b.share,'due',b.due,'eligible',b.eligible)) from pulse_priv.fair_baseline b where org_id=current_org() and (authority=current_viewer() or viewer_is('admin','leadership') or manages(b.person_id)) and not exists(select 1 from pulse_priv.fair_baseline x where x.supersedes=b.id)),'[]'),
 'credits',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'personId',c.person_id,'acceptanceId',c.acceptance_id,'family',c.family,'weight',c.weight,'share',c.share)) from pulse_priv.fair_credit c where org_id=current_org() and authority=current_viewer() and not exists(select 1 from pulse_priv.fair_credit x where x.supersedes=c.id)),'[]'),
 'experiments',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'personId',x.person_id,'skill',x.skill,'anchor',x.anchor,'hypothesis',x.hypothesis,'state',x.state)) from pulse_priv.fair_experiment x join pulse_priv.fair_note n on n.id=x.note_id where x.org_id=current_org() and n.author=current_viewer()),'[]'),
 'tasks',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'title',t.body->>'title','assigneeId',assignee_id,'reviewerId',reviewer_id,'state',state,'due',t.body->>'due','family',(select a.project_id::text||':'||coalesce(a.family,a.parent_asset_id::text,a.id::text) from version v join asset a on a.id=v.asset_id where v.id::text=t.body->>'version'))) from pulse_priv.delivery_task t where org_id=current_org() and (reviewer_id=current_viewer() or owner_id=current_viewer() or viewer_is('admin','leadership'))),'[]'),
 'acceptances',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'taskId',e.task_id,'version',e.body->>'version','at',e.at,'family',(select a.project_id::text||':'||coalesce(a.family,a.parent_asset_id::text,a.id::text) from version v join asset a on a.id=v.asset_id where v.id::text=e.body->>'version'))) from pulse_priv.delivery_event e where org_id=current_org() and kind='accepted' and actor=current_viewer()),'[]'),
 'corrections',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'personId',d.person_id,'dimension',dimension,'reason',reason,'state',state)) from pulse_priv.fair_dispute d where org_id=current_org() and state='open' and (viewer_is('admin','leadership') or manages(d.person_id))),'[]'));
end $$;
-- migrate:down

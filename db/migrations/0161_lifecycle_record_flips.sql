-- migrate:up
-- LIFECYCLE: someone marked not current on their record form, with no other evidence, is still listed for HR to record
-- how and when they left, dated by that change.
create or replace function pulse.lifecycle_detect(p_quiet_weeks int default 6) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare today date:=lifecycle_today();latest date;r record;n int:=0;sig jsonb;w int;conf text;prop_on date;prop_type text;cancelled date;attendance_on boolean;
begin
 if current_viewer() is not null and not viewer_is('admin','hr') then raise exception 'HR or an admin refreshes the review list' using errcode='42501';end if;
 -- HR sheets: someone missing from the latest salary sheet month everyone else is on.
 select max(s.last_seen) into latest from person_source s join person p on p.id=s.person_id where s.org_id=current_org() and s.source='hr_document' and s.label like 'Salary sheet%';
 update lifecycle_signal set retired_at=now() where org_id=current_org() and source in ('hr_sheet','attendance','work') and retired_at is null;
 if latest is not null then
  insert into lifecycle_signal(org_id,person_id,source,kind,observed_on,weight,summary,ref)
  select current_org(),p.id,'hr_sheet','absent',(date_trunc('month',x.last)+interval '1 month')::date,2,
   'Not on the latest salary sheet ('||to_char(latest,'Mon YYYY')||'); last on '||to_char(x.last,'Mon YYYY'),'sheet:'||p.id
  from person p join (select person_id,max(last_seen) last from person_source where org_id=current_org() and source='hr_document' and label like 'Salary sheet%' group by person_id) x on x.person_id=p.id
  where p.org_id=current_org() and p.side='staff' and x.last<latest
  on conflict(org_id,source,ref) do update set observed_on=excluded.observed_on,summary=excluded.summary,weight=excluded.weight,person_id=excluded.person_id,seen_at=now(),retired_at=null;
 end if;
 -- Someone already not current with nothing else: the last month any HR record names them is when they were last seen.
 insert into lifecycle_signal(org_id,person_id,source,kind,observed_on,weight,summary,ref)
 select current_org(),p.id,'hr_sheet','absent',(date_trunc('month',x.last)+interval '1 month')::date,1,'Last named in HR records in '||to_char(x.last,'Mon YYYY'),'lastseen:'||p.id
 from person p join (select person_id,max(last_seen) last from person_source where org_id=current_org() and source='hr_document' and last_seen is not null group by person_id) x on x.person_id=p.id
 where p.org_id=current_org() and p.side='staff' and p.status<>'active'
  and not exists(select 1 from lifecycle_signal s where s.person_id=p.id and s.retired_at is null and s.ref<>'lastseen:'||p.id)
 on conflict(org_id,source,ref) do update set observed_on=excluded.observed_on,summary=excluded.summary,seen_at=now(),retired_at=null;
 -- Attendance and work: quiet for weeks while the company records them (weak on its own).
 attendance_on:=exists(select 1 from attendance_entry where org_id=current_org() and work_date>=today-14);
 insert into lifecycle_signal(org_id,person_id,source,kind,observed_on,weight,summary,ref)
 select current_org(),p.id,'work','quiet',coalesce(a.last,today),1,
  case when a.last is null then 'No tasks, work, messages or check-ins recorded in Pulse' else 'Nothing recorded in Pulse since '||to_char(a.last,'DD Mon YYYY') end,'quiet:'||p.id
 from person p left join people_profile pp on pp.person_id=p.id
 cross join lateral (select greatest(
   (select max(coalesce(t.done_at,t.updated_at))::date from task t where t.org_id=current_org() and (t.assignee_person_id=p.id or t.owner_id=p.id) and t.status<>'unknown'),
   (select max(coalesce(l.period_to,l.period_from)) from people_work_link l where l.org_id=current_org() and l.person_id=p.id and l.retired_at is null and l.status<>'rejected'),
   (select max(m.created_at)::date from chat_message m where m.org_id=current_org() and m.author_id=p.id),
   (select max(e.work_date) from attendance_entry e where e.org_id=current_org() and e.person_id=p.id and e.voided_at is null)) last) a
 where p.org_id=current_org() and p.side='staff' and p.status='active' and coalesce(pp.joined_on,'-infinity')<today-p_quiet_weeks*7
  and (a.last is null or a.last<today-p_quiet_weeks*7)
 on conflict(org_id,source,ref) do update set observed_on=excluded.observed_on,summary=excluded.summary,weight=excluded.weight,seen_at=now(),retired_at=null;
 if attendance_on then
  insert into lifecycle_signal(org_id,person_id,source,kind,observed_on,weight,summary,ref)
  select current_org(),p.id,'attendance','quiet',today,1,'No check-in in the last two weeks while the team checks in','attendance:'||p.id
  from person p where p.org_id=current_org() and p.side='staff' and p.status='active' and not p.tracking_excluded
   and not exists(select 1 from attendance_entry e where e.org_id=current_org() and e.person_id=p.id and e.work_date>=today-14 and e.voided_at is null)
   and not exists(select 1 from leave_request l where l.org_id=current_org() and l.person_id=p.id and l.status='approved' and l.to_date>=today-14)
  on conflict(org_id,source,ref) do update set observed_on=excluded.observed_on,summary=excluded.summary,seen_at=now(),retired_at=null;
 end if;
 -- One proposal per person. Strong evidence (a resignation, a termination, closure documents, a suspended account)
 -- is enough on its own; a missing salary sheet needs a second sign; quiet alone proposes nothing.
 for r in select p.id,p.status,l.stage,l.left_type,coalesce((select joined_on from people_profile where person_id=p.id),p.active_from) joined from person p left join person_lifecycle l on l.person_id=p.id
  where p.org_id=current_org() and p.side='staff' and not exists(select 1 from record_merge m where m.entity_type='person' and m.gone_id=p.id and m.undone_at is null) loop
  if r.stage in ('candidate','offer','joining','notice') or r.left_type is not null then
   update lifecycle_review set status='cleared',refreshed_at=now() where person_id=r.id and status='open';continue;
  end if;
  select max(observed_on) into cancelled from lifecycle_signal where person_id=r.id and kind='cancelled' and retired_at is null;
  -- Evidence from before they joined is about someone else (or an earlier stint) and is not counted.
  select coalesce(jsonb_agg(jsonb_build_object('source',s.source,'kind',s.kind,'summary',s.summary,'on',s.observed_on,'lastDay',s.last_day,'weight',
    case when s.kind='resigned' and s.observed_on<=cancelled then 0 when s.observed_on<r.joined then 0 else s.weight end) order by s.weight desc,s.observed_on desc),'[]') into sig
  from lifecycle_signal s where s.person_id=r.id and s.retired_at is null and s.kind<>'cancelled';
  -- Marked not current on their record (not through People moves): how and when they left is still to record.
  if r.status<>'active' and not exists(select 1 from jsonb_array_elements(sig) x where (x->>'weight')::int>0) then
   sig:=sig||coalesce((select jsonb_agg(jsonb_build_object('source','work','kind','quiet','summary','Marked not current on their record, '||to_char(e.effective_on,'DD Mon YYYY'),'on',e.effective_on,'weight',1))
    from (select effective_on from person_lifecycle_event where person_id=r.id and kind='stage' and to_stage='left' and detail->>'via'='record' order by at desc limit 1) e),'[]');
  end if;
  if cancelled is not null then
   sig:=sig||jsonb_build_array(jsonb_build_object('source','mail','kind','cancelled','summary',(select summary from lifecycle_signal where person_id=r.id and kind='cancelled' and retired_at is null order by observed_on desc limit 1),'on',cancelled,'weight',0));
  end if;
  select coalesce(max((x->>'weight')::int),0) into w from jsonb_array_elements(sig) x;
  conf:=case when w=3 then 'high' when w=2 and exists(select 1 from jsonb_array_elements(sig) x where (x->>'weight')::int=1) then 'medium' when w=2 then 'low'
   when r.status<>'active' and w=1 then 'low' end;
  if conf is null then
   update lifecycle_review set status='cleared',refreshed_at=now() where person_id=r.id and status='open';continue;
  end if;
  select coalesce((x->>'lastDay')::date,case when x->>'kind'='resigned' then (x->>'on')::date+30 when x->>'kind' in ('terminated','closed','suspended') then (x->>'on')::date
    when x->>'kind'='absent' then (x->>'on')::date-1 else (x->>'on')::date end) into prop_on
  from jsonb_array_elements(sig) x where (x->>'weight')::int>0 order by (x->>'weight')::int desc,(x->>'on')::date desc limit 1;
  prop_type:=case when exists(select 1 from jsonb_array_elements(sig) x where x->>'kind'='terminated' and (x->>'weight')::int>0) then 'terminated'
   when exists(select 1 from jsonb_array_elements(sig) x where x->>'kind'='resigned' and (x->>'weight')::int>0) then 'resigned' end;
  insert into lifecycle_review(org_id,person_id,status,confidence,proposed_on,proposed_type,already_inactive,reasons)
  values(current_org(),r.id,'open',conf,case when r.status='active' then prop_on else least(prop_on,today) end,prop_type,r.status<>'active',sig)
  on conflict(person_id) do update set confidence=excluded.confidence,proposed_on=excluded.proposed_on,proposed_type=excluded.proposed_type,already_inactive=excluded.already_inactive,
   reasons=excluded.reasons,refreshed_at=now(),
   status=case when lifecycle_review.status in ('open','cleared') then 'open'
    -- A dismissed proposal comes back only after its snooze, or with strong evidence that is newer than the decision.
    when lifecycle_review.status='dismissed' and (lifecycle_review.snooze_until<=today or exists(select 1 from jsonb_array_elements(excluded.reasons) x
     where (x->>'weight')::int=3 and (x->>'on')::date>lifecycle_review.decided_at::date)) then 'open' else lifecycle_review.status end;
  n:=n+1;
 end loop;
 return n;
end $$;
-- migrate:down
-- Forward-only.

-- migrate:up
-- COMP-A fix (browser gallery, 13 Oct 2026): once the full and final is issued, People & pay no longer asks to prepare
-- it; the row shows the last day. The table now reads issued statements too (0440 read draft, checked and approved).

create or replace function pulse.comp_people() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); reader boolean:=comp_reader(); today date:=lifecycle_today(); pol comp_policy:=comp_policy_row(); out jsonb;
begin
 if me is null or not (reader or pol.managers='status' and exists(select 1 from person p where p.org_id=current_org() and hr_head(p.id)=me and p.id<>me)) then
  raise exception 'Pay is for founders and HR' using errcode='42501'; end if;
 perform comp_log(null,'comp.list',case when reader then 'pay_list' else 'pay_list_manager' end);
 perform comp_status_refresh(r.person_id) from comp_record r where r.org_id=current_org() and (r.refreshed_on is null or r.refreshed_on<today or r.status_until<today);
 select coalesce(jsonb_agg(row order by row->>'name'),'[]') into out from (
  select jsonb_strip_nulls(jsonb_build_object('id',p.id,'name',p.display_name,'role',pp.role,'pod',pp.pod,'department',pp.department,
   'photoAt',(select ph.updated_at from person_photo ph where ph.person_id=p.id),'stage',lifecycle_stage(p.id),'current',p.status='active',
   'hasRecord',r.person_id is not null,'status',r.status,'since',r.status_since,'until',r.status_until,'startOn',r.start_on,'endOn',r.end_on,'confirmedOn',r.confirmed_on,
   'payType',(comp_in_force(p.id,today)).pay_type,
   'probation',case when e.probation_to is not null and r.confirmed_on is null then jsonb_build_object('from',e.probation_from,'to',e.probation_to,
     'review',(select jsonb_build_object('id',v.id,'kind',v.kind,'dueOn',v.due_on) from comp_probation_review v where v.person_id=p.id and v.status='due' order by v.due_on limit 1),
     'outcome',(select jsonb_build_object('id',b.id,'action',b.action,'proposedBy',b.proposed_by) from comp_probation b where b.person_id=p.id and b.status='proposed')) end,
   'lastDay',e.last_working_day,
   'offer',(select jsonb_build_object('id',o.id,'status',o.status,'startOn',o.start_on,'validUntil',o.valid_until,'proposedBy',o.proposed_by,'approvedBy',o.approved_by,'hasLetter',o.letter_id is not null)
     from comp_offer o where o.person_id=p.id and (o.status in ('draft','proposed','approved','sent') or o.status='accepted' and o.started_at is null) order by o.created_at desc limit 1),
   'pause',(select jsonb_build_object('id',z.id,'status',z.status,'from',z.from_on,'to',coalesce(z.ended_on,z.to_on),'paidPercent',z.paid_percent,'proposedBy',z.proposed_by)
     from comp_pause z where z.person_id=p.id and z.status in ('proposed','approved') and coalesce(z.ended_on,z.to_on)>=today order by z.from_on limit 1),
   'change',case when reader then (select jsonb_build_object('id',c.id,'kind',c.kind,'status',c.status,'effectiveOn',c.effective_on,'proposedBy',c.proposed_by)
     from comp_change c where c.person_id=p.id and c.kind<>'offer' and (c.status in ('draft','proposed') or c.status='approved' and c.effective_on>today) order by (c.status='proposed') desc,c.effective_on limit 1) end,
   'items',case when reader then (select count(*) from comp_item i where i.person_id=p.id and i.status='proposed') end,
   'claims',(select count(*) from comp_claim k where k.person_id=p.id and (k.status='submitted' and (k.head_id=me or reader and k.head_id is null) or k.status='head_approved' and reader and k.head_by is distinct from me)),
   'settlement',case when reader then (select jsonb_build_object('id',s.id,'status',s.status,'lastDay',s.last_day,'checkedBy',s.checked_by) from comp_settlement s where s.person_id=p.id and s.status in ('draft','checked','approved','issued')) end,
   'leavingCase',(select c.id from lifecycle_case c where c.person_id=p.id and c.kind='leaving' and c.status='open' limit 1)
  )) row
  from person p join people_profile pp on pp.person_id=p.id left join comp_record r on r.person_id=p.id left join hr_employment e on e.person_id=p.id
  where p.org_id=current_org() and p.side='staff' and (p.status='active' or r.person_id is not null and r.status<>'ended' or r.end_on>=today-90
    or exists(select 1 from person_lifecycle l where l.person_id=p.id and l.stage in ('candidate','offer')))
   and not exists(select 1 from record_merge m where m.entity_type='person' and m.gone_id=p.id and m.undone_at is null)
   and (reader or hr_head(p.id)=me and p.id<>me)
 ) x;
 return jsonb_build_object('today',today,'people',out,'reader',reader,'writer',comp_writer(),'approver',comp_is_approver(me),'me',me,
  'policy',jsonb_build_object('approvers',pol.approvers,'managers',pol.managers,'currency',pol.currency,'remindDays',pol.remind_days));
end $$;

-- migrate:down
-- Forward-only.

-- migrate:up
-- COMP-A fix (browser flows, 13 Oct 2026): an accepted offer's terms are the person's first version of pay (approved,
-- in force from the start date), so the person's pay page lists it among the versions. 0440 left offers out of that
-- list, and a new joiner's page then read "no pay in force" (no Change pay, no Pause, an empty full and final).

create or replace function pulse.comp_person(p_person uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); reader boolean:=comp_reader(); self boolean:=p_person=me; mgr boolean:=comp_manager_sees(p_person); r comp_record; e hr_employment;
 pol comp_policy:=comp_policy_row(); today date:=lifecycle_today();
begin
 if me is null or not (reader or self or mgr) then raise exception 'Pay is for founders, HR and the person' using errcode='42501'; end if;
 if not exists(select 1 from person where org_id=current_org() and id=p_person and side='staff') then raise exception 'Person not found' using errcode='P0002'; end if;
 perform comp_status_refresh(p_person);
 select * into r from comp_record where person_id=p_person;
 select * into e from hr_employment where org_id=current_org() and person_id=p_person;
 perform comp_log(p_person,'comp.record',case when self then 'self' when reader then 'record_view' else 'manager_view' end);
 return jsonb_strip_nulls(jsonb_build_object(
  'person',(select jsonb_build_object('id',p.id,'name',p.display_name,'role',pp.role,'pod',pp.pod,'department',pp.department,'joinedOn',pp.joined_on,'current',p.status='active',
    'stage',lifecycle_stage(p.id),'photoAt',(select ph.updated_at from person_photo ph where ph.person_id=p.id),'head',(select display_name from person where id=hr_head(p.id)))
    from person p left join people_profile pp on pp.person_id=p.id where p.id=p_person),
  'record',case when r.person_id is not null then jsonb_build_object('status',r.status,'since',r.status_since,'until',r.status_until,'startOn',r.start_on,'endOn',r.end_on,
    'confirmedOn',r.confirmed_on,'currency',r.currency) end,
  'employment',jsonb_build_object('probationFrom',e.probation_from,'probationTo',e.probation_to,'noticeFrom',e.notice_from,'lastWorkingDay',e.last_working_day,'payrollFrom',e.payroll_from),
  'versions',case when reader or self then (select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'kind',c.kind,'status',c.status,'effectiveOn',c.effective_on,'payType',c.pay_type,'role',c.role,
     'reason',c.reason,'source',c.source,'correctsId',c.corrects_id,'beforeId',c.before_id,'proposedBy',(select display_name from person where id=c.proposed_by),'proposedById',c.proposed_by,
     'proposedAt',c.proposed_at,'decidedBy',(select display_name from person where id=c.decided_by),'decidedAt',c.decided_at,'decisionNote',c.decision_note,'letterId',c.letter_id,
     'inForce',c.id=(comp_in_force(p_person,today)).id) order by c.effective_on desc,c.created_at desc),'[]')
    from comp_change c where c.person_id=p_person and (c.kind<>'offer' or c.status='approved') and (reader or c.status='approved')) end,
  'offers',case when reader or self then (select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'status',o.status,'role',o.role,'startOn',o.start_on,'probationDays',o.probation_days,
     'noticeDays',o.notice_days,'terms',o.terms,'validUntil',o.valid_until,'changeId',o.change_id,'payType',(select pay_type from comp_change where id=o.change_id),
     'taskId',o.task_id,'task',(select title from task where id=o.task_id),'proposedBy',(select display_name from person where id=o.proposed_by),'proposedById',o.proposed_by,
     'approvedBy',(select display_name from person where id=o.approved_by),'sentBy',(select display_name from person where id=o.sent_by),'sentAt',o.sent_at,'answeredAt',o.answered_at,
     'answerName',o.answer_name,'answerVia',o.answer_via,'closedNote',o.closed_note,'letterId',o.letter_id,
     'link',(select jsonb_build_object('expiresAt',k.expires_at,'openedAt',k.opened_at) from comp_offer_link k where k.offer_id=o.id and k.revoked_at is null order by k.created_at desc limit 1))
     order by o.created_at desc),'[]') from comp_offer o where o.person_id=p_person and (reader or o.status in ('sent','accepted','declined','expired'))) end,
  'probation',jsonb_build_object('reviews',(select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'kind',v.kind,'dueOn',v.due_on,'status',v.status,'note',case when reader or mgr then v.note end,
     'doneBy',(select display_name from person where id=v.done_by),'doneAt',v.done_at) order by v.due_on),'[]') from comp_probation_review v where v.person_id=p_person),
   'outcomes',(select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'action',b.action,'until',b.until_on,'note',b.note,'status',b.status,'proposedBy',(select display_name from person where id=b.proposed_by),
     'proposedById',b.proposed_by,'decidedBy',(select display_name from person where id=b.decided_by),'decidedAt',b.decided_at,'letterId',b.letter_id) order by b.proposed_at desc),'[]')
     from comp_probation b where b.person_id=p_person and (reader or b.status='approved'))),
  'pauses',(select coalesce(jsonb_agg(jsonb_build_object('id',z.id,'from',z.from_on,'to',z.to_on,'endedOn',z.ended_on,'paidPercent',z.paid_percent,'reasonKind',z.reason_kind,'note',z.note,
     'status',z.status,'proposedBy',(select display_name from person where id=z.proposed_by),'proposedById',z.proposed_by,'decidedBy',(select display_name from person where id=z.decided_by),
     'letterId',z.letter_id) order by z.from_on desc),'[]') from comp_pause z where z.person_id=p_person and (reader or z.status='approved')),
  'items',case when reader or self then (select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'kind',i.kind,'status',i.status,'forMonth',i.for_month,'payout',i.payout,'reason',i.reason,'ref',i.ref,
     'recoverMonths',i.recover_months,'recoverFrom',i.recover_from,'proposedBy',(select display_name from person where id=i.proposed_by),'proposedById',i.proposed_by,
     'decidedBy',(select display_name from person where id=i.decided_by),'paidAt',i.paid_at) order by i.for_month desc,i.proposed_at desc),'[]')
     from comp_item i where i.person_id=p_person and (reader or i.status='approved')) end,
  'claims',case when reader or self then (select coalesce(jsonb_agg(jsonb_build_object('id',k.id,'category',k.category,'spentOn',k.spent_on,'vendor',k.vendor,'note',k.note,'status',k.status,
     'aboveThreshold',k.above_threshold,'head',(select display_name from person where id=k.head_id),'headBy',(select display_name from person where id=k.head_by),
     'decidedBy',(select display_name from person where id=k.decided_by),'decisionNote',k.decision_note,'payout',k.payout,'forMonth',k.for_month,'receiptMime',k.receipt_mime,
     'createdAt',k.created_at,'paidAt',k.paid_at) order by k.created_at desc),'[]') from comp_claim k where k.person_id=p_person) end,
  'settlement',case when reader or self then (select jsonb_build_object('id',s.id,'status',s.status,'exitKind',s.exit_kind,'lastDay',s.last_day,'noticeMode',s.notice_mode,'legal',s.legal,
     'note',s.note,'preparedBy',(select display_name from person where id=s.prepared_by),'checkedBy',(select display_name from person where id=s.checked_by),'checkedById',s.checked_by,
     'approvedBy',(select display_name from person where id=s.approved_by),'letterId',s.letter_id,'caseId',s.case_id)
     from comp_settlement s where s.person_id=p_person and s.status<>'withdrawn' and (reader or s.status='issued')) end,
  'leavingCase',(select jsonb_build_object('id',c.id,'effectiveOn',c.effective_on,'leftType',c.left_type,'settlement',(select result from lifecycle_step where case_id=c.id and key='settlement'))
     from lifecycle_case c where c.person_id=p_person and c.kind='leaving' and c.status in ('open','done') order by c.opened_at desc limit 1),
  'letters',case when reader or self then (select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'kind',l.kind,'title',l.title,'issuedAt',l.issued_at,'pages',l.pages,'sha256',l.sha256,
     'issuedBy',(select display_name from person where id=l.issued_by),'seenAt',l.seen_at) order by l.issued_at desc),'[]') from comp_letter l where l.person_id=p_person and (reader or comp_letter_visible(l))) end,
  'timeline',(select coalesce(jsonb_agg(jsonb_build_object('at',v.at,'kind',v.kind,'by',(select display_name from person where id=v.actor),'subjectType',v.subject_type,'subjectId',v.subject_id,'detail',v.detail) order by v.at desc),'[]')
     from (select * from comp_event v where v.person_id=p_person and (reader or v.kind in ('offer.sent','offer.accepted','offer.declined','offer.started','change.approved','letter.issued',
       'probation.confirm','probation.extend','probation.end','pause.approved','pause.ended','item.approved','claim.submitted','claim.approved','claim.rejected','settlement.issued','status.changed'))
       order by v.at desc limit 80) v),
  'can',jsonb_build_object('read',reader,'self',self,'manager',mgr,'propose',comp_writer() and not self,'approve',comp_is_approver(me) and not self,'claim',self),
  'policy',jsonb_build_object('approvers',pol.approvers,'probationApproval',pol.probation_approval,'probationDays',pol.probation_days,'offerDays',pol.offer_days,'currency',pol.currency,
    'noticeProbation',coalesce(pol.notice_probation,(select (config->>'probationDays')::int from hr_rule_version where org_id=current_org() and key='exit' and effective_from<=today order by effective_from desc,version desc limit 1),15),
    'noticeConfirmed',coalesce(pol.notice_confirmed,(select (config->>'confirmedDays')::int from hr_rule_version where org_id=current_org() and key='exit' and effective_from<=today order by effective_from desc,version desc limit 1),30),
    'encashBasis',pol.encash_basis,'encashDivisor',pol.encash_divisor,'dayBasis',pol.day_basis,'recoverMax',pol.recover_max,'components',pol.components),
  'today',today));
end $$;

-- migrate:down
-- Forward-only.

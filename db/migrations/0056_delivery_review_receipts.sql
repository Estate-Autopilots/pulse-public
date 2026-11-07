-- migrate:up
create function pulse.delivery_operational_state(pr uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin perform delivery_access(pr);return jsonb_build_object(
 'approvedBlockers',coalesce((select jsonb_agg(to_jsonb(b)-'org_id'-'resolver') from pulse_priv.delivery_blocker b join pulse_priv.delivery_task t on t.id=b.task_id where b.org_id=current_org() and t.project_id=pr and b.approved and not b.contested),'[]'),
 'policies',coalesce((select jsonb_agg(jsonb_build_object('taskId',p.task_id,'body',p.body)) from pulse_priv.delivery_review_policy p join pulse_priv.delivery_task t on t.id=p.task_id where p.org_id=current_org() and t.project_id=pr),'[]'),
 'clientWindows',coalesce((select jsonb_agg(jsonb_build_object('taskId',r.task_id,'start',r.at,'end',(select min(at) from pulse_priv.portal_feedback f where f.org_id=current_org() and f.release_id=r.id and f.kind in('approval','change')))) from pulse_priv.portal_release r where r.org_id=current_org() and r.project_id=pr),'[]'),
 'readiness',(select body from pulse_priv.delivery_readiness where org_id=current_org() and project_id=pr));end $$;
create function pulse.delivery_backup_reviewers(pr uuid,skills text[],day date) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin perform delivery_access(pr,true);return jsonb_build_object('recommendations',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name,'skills',pp.skills,'committedTasks',(select count(*) from pulse_priv.delivery_task t where t.org_id=current_org() and t.reviewer_id=p.id and t.state not in('accepted','cancelled')),'availability','Role and skill match; confirm assigned working intervals before reassigning')) from person p join people_profile pp on pp.person_id=p.id where p.org_id=current_org() and p.status='active' and p.side='staff' and pp.skills @> skills and array_length(skills,1)>0
 and exists(select 1 from role_assignment r where r.org_id=current_org() and r.person_id=p.id and current_date between r.valid_from and coalesce(r.valid_to,'infinity'))
 and not exists(select 1 from leave_request l where l.org_id=current_org() and l.person_id=p.id and l.status='approved' and day between l.from_date and l.to_date)),'[]'),
 'rule','Human preview only. WFH counts as available; leave omitted. No reassignment without an approved role, skill and working-calendar availability.');end $$;
revoke all on function pulse.delivery_operational_state(uuid),pulse.delivery_backup_reviewers(uuid,text[],date) from public;
grant execute on function pulse.delivery_operational_state(uuid),pulse.delivery_backup_reviewers(uuid,text[],date) to pulse_api;
-- A declaration cannot rewrite the underlying source task or commitment. A current deadline stays locked on replay.
-- migrate:down

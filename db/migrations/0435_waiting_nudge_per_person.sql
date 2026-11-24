-- migrate:up
-- RELEASE-5: UX-5B's "waiting on" nudge (0422) told whoever does a task others wait on once a day per such task. On
-- production one person does 13 of them (read-only count when this was written), so the first morning after release
-- would have brought them 13 notices, and 13 again every day. It is one notice a day per person: with one task it reads
-- as before ("Kabir waits on “Upload the bank statements” (2 days)", opening that task); with more it says how many of
-- theirs hold up how many others and names the oldest ("13 of your tasks hold up 15 others, the oldest “…” for 6 days"),
-- opening My tasks, where Waiting for you lists them.
create or replace function pulse.task_waiting_tick() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r record; n int:=0; hrs int:=coalesce((select review_nudge_hours from work_settings where org_id=current_org()),24); days text;
begin
 for r in select x.who,count(*)::int blockers,sum(x.tasks)::int tasks,(array_agg(x.id order by x.since))[1] id,(array_agg(x.title order by x.since))[1] title,
   (array_agg(x.first_name order by x.since))[1] first_name,min(x.since) since
  from (select b.id,b.title,coalesce(b.assignee_person_id,b.owner_id) who,count(distinct w.id)::int tasks,min(l.created_at) since,
    (array_agg(p.display_name order by l.created_at))[1] first_name
   from task_link l join task w on w.id=l.task_id join task b on b.id=l.blocker_id left join person p on p.id=coalesce(w.assignee_person_id,w.owner_id)
   where l.org_id=current_org() and l.cleared_at is null and w.deleted_at is null and b.deleted_at is null
    and w.status in ('open','in_progress','blocked') and b.status in ('open','in_progress','blocked','unknown')
    and coalesce(b.assignee_person_id,b.owner_id) is not null and coalesce(b.assignee_person_id,b.owner_id) is distinct from coalesce(w.assignee_person_id,w.owner_id)
    and l.created_at<now()-make_interval(hours=>hrs)
   group by b.id,b.title,coalesce(b.assignee_person_id,b.owner_id)) x
  group by x.who loop
  days:=case when now()-r.since<interval '2 days' then 'a day' else extract(day from now()-r.since)::int||' days' end;
  if notification_emit(r.who,'task.waiting','task',r.id,'waiting:'||r.who||':'||(now() at time zone org_time_zone())::date,
   left(case when r.blockers>1 then r.blockers||' of your tasks hold up '||r.tasks||' others, the oldest “'||r.title||'” for '||days
    when r.tasks=1 then coalesce(split_part(r.first_name,' ',1),'Someone')||' waits on “'||r.title||'” ('||days||')'
    else r.tasks||' tasks wait on “'||r.title||'” ('||days||')' end,160),
   case when r.blockers>1 then '/tasks?view=me' else '/tasks/'||r.id end,'task') is not null then n:=n+1; end if;
 end loop;
 return n;
end $$;

-- migrate:down
-- Forward-only.

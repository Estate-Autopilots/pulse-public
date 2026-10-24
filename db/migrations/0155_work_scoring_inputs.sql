-- migrate:up
-- UX-TASKS-2: what Pip's scorer reads, the same whoever creates the task. A client project's value band (which quarter
-- of the company's package values it falls in, never the amount; a linked project uses its package's) and how long
-- similar finished work took (counts and medians only, never titles or people).
create function pulse.work_package_band(p_project uuid) returns int language sql stable security definer set search_path=pulse,pg_temp as $$
 with pkg as (select coalesce((select l.client_project_id from work_project_link l where l.org_id=current_org() and l.project_id=p_project and l.status='linked' order by l.decided_at limit 1),p_project) id),
 v as (select project_id,ntile(4) over(order by amount) band from pulse_priv.client_project_value where org_id=current_org() and amount>0)
 select case when current_viewer() is null then null else (select band from v where v.project_id=(select id from pkg)) end
$$;
create function pulse.work_similar_effort(p_category text,p_title text) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 with c as (select t.id,public.similarity(lower(t.title),lower(coalesce(p_title,''))) sim,t.started_at,t.done_at,t.value_points,t.effort*t.impact pts
   from task t where current_viewer() is not null and t.org_id=current_org() and t.status in ('done','accepted','in_review')
    and coalesce(t.done_at,t.updated_at)>now()-interval '400 days' and (p_category is null or t.category=p_category)
   order by 2 desc,t.done_at desc nulls last limit 12),
 m as (select c.*,(select sum(e.minutes) from time_entry e where e.org_id=current_org() and e.task_id=c.id and e.status='confirmed' and e.retired_at is null) minutes from c)
 select jsonb_build_object('n',count(*),'minutesN',count(minutes),'close',count(*) filter(where sim>=0.3),
  'minutes',percentile_cont(0.5) within group(order by minutes),
  'cycleDays',percentile_cont(0.5) within group(order by extract(epoch from done_at-started_at)/86400) filter(where started_at is not null and done_at>started_at),
  'value',percentile_cont(0.5) within group(order by value_points),
  'points',percentile_cont(0.5) within group(order by pts)) from m
$$;
-- "Testimonial" names a kind of video, shot or edited alike: it no longer reads a task as a shoot ("Edit the testimonial").
do $$ declare o uuid;previous_org text:=current_setting('pulse.org_id',true);begin
 for o in select id from pulse.org loop
  perform set_config('pulse.org_id',o::text,true);
  update pulse.work_category set keywords=array_remove(keywords,'testimonial') where org_id=o and key='video_shoot' and updated_by is null;
 end loop;
 perform set_config('pulse.org_id',coalesce(previous_org,''),true);
end $$;
do $$
declare definition text;changed text;
begin
 definition:=pg_get_functiondef('pulse.work_category_seed()'::regprocedure);
 changed:=replace(definition,'''b-?rolls?'',''testimonial'',''site visit''','''b-?rolls?'',''site visit''');
 if changed=definition then raise exception 'work_category_seed changed shape';end if;
 execute changed;
end $$;
revoke all on function pulse.work_package_band(uuid),pulse.work_similar_effort(text,text) from public;
grant execute on function pulse.work_package_band(uuid),pulse.work_similar_effort(text,text) to pulse_api,pulse_worker;
-- migrate:down
-- Forward-only.

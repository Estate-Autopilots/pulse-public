-- migrate:up
-- AI-FIX-5 (BC-127, 20 Nov 2026): EA's Project Coordinator made a new "Daily triage: N tasks with no owner or due day
-- (DD Mon)" task for itself every day (TASK-CLEAN §9.4). Production, EA (read only, counts): 22 since 28 Oct, and the
-- 16-20 Nov ones are 5 tasks all still blocked side by side. One standing task is enough: while its last triage task is
-- still open (open, in progress, blocked or with its reviewer), the day's triage refreshes that task (today's count and
-- date in the title, due today, the same steps) and wakes its AI employee on it; a new task is made only when none is
-- open. Still once a day: a triage task made today, or one whose title carries today's date and changed in the last two
-- days, means today's has started. Patched in place (as 2232 does); each patch refuses to run if the text moved.
do $$
declare src text; was text;
begin
  src := pg_get_functiondef('pulse.agent_triage_start()'::regprocedure); was := src;
  src := replace(src, 'declare me uuid := agent_session(); m agent_member; n int; tid uuid; ap uuid;',
    'declare me uuid := agent_session(); m agent_member; n int; tid uuid; ap uuid; standing uuid;');
  src := replace(src,
    'and (created_at at time zone org_time_zone())::date = (now() at time zone org_time_zone())::date) then return null; end if;',
    'and ((created_at at time zone org_time_zone())::date = (now() at time zone org_time_zone())::date
                  or title like ''%('' || to_char(now() at time zone org_time_zone(), ''FMDD Mon'') || '')'' and coalesce(updated_at, created_at) > now() - interval ''2 days'')) then return null; end if;');
  src := replace(src, '  tid := task_save(null, jsonb_build_object(''title'', ''Daily triage: ''',
    '  select id into standing from task where org_id = current_org() and created_by = me and assignee_person_id = me and title like ''Daily triage:%''
     and deleted_at is null and status in (''open'', ''in_progress'', ''blocked'', ''in_review'') order by created_at desc limit 1;
  tid := task_save(standing, jsonb_build_object(''title'', ''Daily triage: ''');
  src := replace(src, 'Do not change the tasks yourself; then mark this task done.''));',
    'Do not change the tasks yourself; then mark this task done.''));
  if standing is not null then perform agent_task_wake(tid, ''triage'', to_char(now() at time zone org_time_zone(), ''YYYY-MM-DD''), ap); end if;');
  if src not like '%standing uuid;%' or src not like '%task_save(standing,%' or src not like '%perform agent_task_wake(tid, ''triage''%'
     or src not like '%interval ''2 days''%' then
    raise exception 'agent_triage_start changed upstream: update 2484';
  end if;
  execute src;
end $$;

-- migrate:down
-- Forward-only.

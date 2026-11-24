-- migrate:up
-- KAZUK-PREP (22 Nov 2026): a transaction that asks for no notices gets none.
-- pulse.notify_mode = 'none' is the plan import's notify:'none' (AC-PLAN-TOOLS, services/api/src/plan-import.ts) and a
-- leadership set-up of a reconstructed project. Until now only task.assigned honoured it (task_notify and the assignment
-- trigger, 2158); every notice that goes through work_notify still went out: "You own a new client project" and
-- "N steps are yours" (project_assign, project_plan_roles_set), "made you the owner" (work_project_save), "dates moved"
-- (project_clock_move), pool matches. So an import that promised "no notices" told people anyway.
-- Now work_notify returns before notification_emit when the mode is 'none'. 'digest' and the default are unchanged:
-- the mode is only ever set inside one transaction (set_config(..., true)), never by the web app.

create or replace function pulse.work_notify(p_person uuid, p_type text, p_subject text, p_id uuid, p_key text, p_title text, p_href text, p_kind text default 'task')
 returns uuid language plpgsql security definer set search_path to 'pulse', 'pg_temp' as $$
begin
 if p_person is null or p_person=current_viewer() then return null;end if;
 -- KAZUK-PREP: a transaction that asked for no notices (pulse.notify_mode 'none') sends none from here either.
 if coalesce(current_setting('pulse.notify_mode',true),'')='none' then return null;end if;
 return notification_emit(p_person,p_type,p_subject,p_id,left(p_key,200),left(p_title,160),p_href,p_kind);
end $$;

-- migrate:down
create or replace function pulse.work_notify(p_person uuid, p_type text, p_subject text, p_id uuid, p_key text, p_title text, p_href text, p_kind text default 'task')
 returns uuid language plpgsql security definer set search_path to 'pulse', 'pg_temp' as $$
begin
 if p_person is null or p_person=current_viewer() then return null;end if;
 return notification_emit(p_person,p_type,p_subject,p_id,left(p_key,200),left(p_title,160),p_href,p_kind);
end $$;

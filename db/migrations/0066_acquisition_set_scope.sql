-- Acquisition projections checked work_project() once per project and again per scoped row.
-- Reuse the tenant/viewer transaction cache populated by work_projects() instead.
-- migrate:up
create or replace function pulse.acq_can(p uuid,w boolean default false) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and not viewer_is('hr') and exists(select 1 from person where id=current_viewer() and org_id=current_org() and side='staff' and status='active')
 and exists(select 1 from project where id=p and org_id=current_org()) and (viewer_is('admin','leadership') or p=any(work_projects()))
 and (not w or viewer_is('admin','leadership','pgs','head_pgs','manager'))
$$;
-- migrate:down
-- Forward-only: reverting restores the repeated per-project scope query that caused the staging failure.

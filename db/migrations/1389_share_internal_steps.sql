-- migrate:up
-- KAZUK (29 Oct 2026): the client timeline leaves out steps a template marks internal ("internal": true), such as the
-- refund evaluation and the sales incentive release, which are the company's own checks, not the client's work.
create or replace function pulse.project_share_open(p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s pulse.project_share; p pulse.project; pl pulse.project_plan; def jsonb; tz text := pulse.org_time_zone();
begin
  select * into s from pulse.project_share where token_hash = p_hash and org_id = pulse.current_org();
  if s.token_hash is null or s.revoked_at is not null then return null; end if;
  select * into p from pulse.project where id = s.project_id and deleted_at is null;
  if p.id is null or p.status = 'cancelled' then return null; end if;
  select * into pl from pulse.project_plan where project_id = p.id;
  select definition into def from pulse.delivery_template where org_id = p.org_id and key = pl.template_key;
  return jsonb_build_object(
    'project', coalesce(p.title, p.name), 'company', (select name from pulse.org where id = p.org_id), 'kickoff', pl.kickoff, 'today', (now() at time zone tz)::date,
    'paused', p.status = 'paused',
    'stages', coalesce(def->'stages', '[]'::jsonb),
    'steps', coalesce((select jsonb_agg(jsonb_build_object('step', t.template_step, 'stage', t.phase_key,
        'title', coalesce((select x->>'title' from jsonb_array_elements(def->'steps') x where x->>'id' = t.template_step), t.template_step),
        'start', t.work_on, 'due', (t.due_at at time zone tz)::date, 'done', (coalesce(t.done_at, t.accepted_at) at time zone tz)::date,
        'state', case when t.status in ('done','accepted') then 'done' when t.status in ('in_progress','in_review') then 'doing' else 'planned' end)
        order by t.phase_key, t.due_at nulls last)
      from pulse.task t where t.project_id = p.id and t.deleted_at is null and t.status <> 'cancelled' and t.template_step is not null
        and not exists(select 1 from jsonb_array_elements(def->'steps') x where x->>'id' = t.template_step and (x->>'kind' = 'gate' or coalesce((x->>'internal')::boolean, false)))), '[]'::jsonb));
end $$;

select set_config('pulse.org_id', o.id::text, true) from pulse.org o where o.id = '6f1a455d-ced2-504d-b8d5-5ae0efbe7c75';
update pulse.delivery_template d set definition = jsonb_set(d.definition, '{steps}', (select jsonb_agg(case when x->>'id' in ('G3','G4') then x || '{"internal": true}'::jsonb else x end order by n)
    from jsonb_array_elements(d.definition->'steps') with ordinality as s(x, n))), updated_at = now()
  where d.org_id = '6f1a455d-ced2-504d-b8d5-5ae0efbe7c75' and d.key = 'agency-creative';
select set_config('pulse.org_id', '', true);

-- migrate:down
select 1;

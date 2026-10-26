-- migrate:up
-- UX-5A (owner, 13 Oct 2026: "accepting work must be dead simple"): the reviewer gives one quality rating and may mark
-- "above and beyond"; the points are the result, shown before they accept, with why on hover. This reads what
-- pulse.task_credit_follow() (0310) would credit on acceptance, without changing anything: the value set before the work,
-- else Pip's value, else the effort × impact Pulse derives (pulse.task_derived_scores), and the company's above-and-beyond
-- bonus. Leadership's and founders' work is acknowledged (mode) and credited the same way. Null when the viewer cannot
-- see the task.
create function pulse.task_credit_preview(p_id uuid) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare t task;sc jsonb;pip int;base int;bonus int;pol text;
begin
 select * into t from task where org_id=current_org() and id=p_id and deleted_at is null;
 if not found or not task_visible(p_id) then return null;end if;
 pip:=case when (t.ai_suggestion->>'valuePoints') ~ '^\d{1,3}$' then (t.ai_suggestion->>'valuePoints')::int end;
 sc:=task_derived_scores(p_id);
 base:=least(100,coalesce(t.value_points,pip,(sc->>'effort')::int*(sc->>'impact')::int,0));
 bonus:=coalesce((select above_bonus from work_settings where org_id=current_org()),25);
 pol:=coalesce((select review_leaders from work_settings where org_id=current_org()),'acknowledge');
 return jsonb_build_object('points',base,
  'basis',case when t.value_points is not null then 'value' when pip is not null then 'pip' else 'rating' end,
  'aboveBonus',bonus,'abovePoints',case when base>0 then least(100,base+greatest(1,round(base*bonus/100.0)::int)) else 0 end,
  'mode',case when task_is_leader(coalesce(t.assignee_person_id,t.owner_id)) and pol<>'review' then 'acknowledge' else 'rate' end,
  'effort',(sc->>'effort')::int,'impact',(sc->>'impact')::int,'minutes',(sc->>'minutes')::int,'unlocks',coalesce((sc->>'unlocks')::boolean,false));
end $$;
revoke all on function pulse.task_credit_preview(uuid) from public;
grant execute on function pulse.task_credit_preview(uuid) to pulse_api, pulse_worker;

-- migrate:down
-- Forward-only.

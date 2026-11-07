-- migrate:up
-- AI-AUTONOMY (EA's first daily triage, 28 Oct): with 281 tasks needing an owner or a due day the work view listed 25,
-- so the Project Coordinator proposed 22 changes and filed "Provide the complete daily-triage attention list". The
-- attention list now holds up to 80 (late first, then no owner, then no due day), the most one card takes.
do $$
declare src text; was text;
begin
  src := pg_get_functiondef('pulse.agent_chief_snapshot()'::regprocedure); was := src;
  src := replace(src, 'order by 1, t.due_at nulls last limit 25) x)', 'order by 1, t.due_at nulls last limit 80) x)');
  if src = was then raise exception 'agent_chief_snapshot changed upstream: update 1353'; end if;
  execute src;
end $$;

-- migrate:down
-- Forward-only.

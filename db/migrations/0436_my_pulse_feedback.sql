-- migrate:up
-- RELEASE-5: My desk's feedback list (0159 me_pulse) read "(select jsonb_agg(…) from (accepted) x union all select f from
-- (sent back) y)": the union belonged to the outer select, so once a person had work sent back in the last 90 days the
-- subquery returned more than one row and their whole My desk (UX-5A's page, the profile's "What Pulse knows") failed
-- with 21000. Sending work back is TASKS-4B's (production since 13 Oct, nobody yet); the release's browser proof found it.
-- The two lists are now one derived table, aggregated once.
do $$
declare definition text; a text:=$o$'feedback',coalesce((select jsonb_agg(f order by f->>'at' desc) from ($o$; b text:=$o$limit 4) y),'[]'),$o$;
begin
 definition:=pg_get_functiondef('pulse.me_pulse()'::regprocedure);
 -- Each piece exactly once, or the function is not the one this fixes.
 if (length(definition)-length(replace(definition,a,'')))/length(a)<>1 or (length(definition)-length(replace(definition,b,'')))/length(b)<>1 then
  raise exception 'me_pulse changed shape';
 end if;
 execute replace(replace(definition,a,a||'select f from ('),b,replace(b,') y)',') y) z)'));
end $$;

-- migrate:down
-- Forward-only.

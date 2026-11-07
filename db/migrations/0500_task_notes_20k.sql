-- migrate:up
-- EST-1072 (AC's Pulse list #13, approved by the Pulse CEO on EST-997): a task's notes hold up to 20,000 characters,
-- not 4,000. A task with frequent status lines filled 4,000 within a day. Widening only: every note already saved
-- passes the new check and nothing is rewritten, so the previous release runs on this schema as it is.
alter table pulse.task drop constraint task_notes_check;
alter table pulse.task add constraint task_notes_check check(length(notes)<=20000);

-- task_save: the same 20,000, and "why it matters" (1,000) gets its own message instead of the notes'.
do $$
declare d text;c text;
begin
 d:=pg_get_functiondef('pulse.task_save(uuid,jsonb)'::regprocedure);
 c:=replace(d,$x$ if length(v_notes)>4000 or length(v_value)>1000 then raise exception 'Keep notes under 4,000 characters' using errcode='22023';end if;$x$,
 $x$ if length(v_notes)>20000 then raise exception 'Keep notes under 20,000 characters' using errcode='22023';end if;
 if length(v_value)>1000 then raise exception 'Keep why it matters under 1,000 characters' using errcode='22023';end if;$x$);
 if c=d then raise exception 'task_save changed shape (notes)';end if;
 execute c;
end $$;

-- migrate:down
-- Forward-only: narrowing back to 4,000 would refuse notes people have saved since.

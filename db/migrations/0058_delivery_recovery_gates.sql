-- migrate:up
-- Keep accepted evidence gates closed when the current version, roles or checklist changes.
-- Existing immutable event receipts retain their original assignment/version snapshots.
do $$ declare src text;needle text;begin
 src:=pg_get_functiondef('pulse.delivery_save(jsonb)'::regprocedure);needle:='and st=''ready_for_review'' then st:=''in_progress''';
 if position(needle in src)=0 then raise exception 'Expected delivery review guard is unavailable';end if;
 execute replace(src,needle,'and st in(''ready_for_review'',''accepted'') then st:=''in_progress''');
 src:=pg_get_functiondef('pulse.delivery_transition(uuid,integer,text,text,text)'::regprocedure);
 needle:='elsif current_viewer() not in(t.owner_id,t.assignee_id) and not viewer_is(''admin'',''leadership'') then';
 if position(needle in src)=0 then raise exception 'Expected delivery role guard is unavailable';end if;
 execute replace(src,needle,'elsif current_viewer() not in(t.owner_id,t.assignee_id) and not(t.state=''ready_for_review'' and p_state=''in_progress'' and current_viewer()=t.reviewer_id) and not viewer_is(''admin'',''leadership'') then');
 src:=pg_get_functiondef('pulse.delivery_block(uuid,jsonb)'::regprocedure);needle:='set ended_at=excluded.ended_at,contested=excluded.contested;';
 if position(needle in src)=0 then raise exception 'Expected blocker update guard is unavailable';end if;
 execute replace(src,needle,'set approved=case when pulse_priv.delivery_blocker.ended_at is distinct from excluded.ended_at or pulse_priv.delivery_blocker.contested is distinct from excluded.contested then false else pulse_priv.delivery_blocker.approved end,ended_at=excluded.ended_at,contested=excluded.contested;');
end $$;
-- migrate:down

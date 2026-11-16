-- migrate:up
-- Compatibility first: old API must accept the later R19 view/index while the normal train migrates before deploy.
-- No attendance or correction behavior is activated by this preparation.
alter table pulse.attendance_entry add column reconciled_open boolean not null default false;
do $$ declare s text;begin
 s:=pg_get_functiondef('pulse.companion_presence_tick(uuid)'::regprocedure);
 s:=replace(s,'where checked_out_at is null do nothing','where checked_out_at is null and not reconciled_open do nothing');
 execute s;
end $$;
-- migrate:down
-- Forward-only protocol preparation; the later reconciliation migration depends on this column.

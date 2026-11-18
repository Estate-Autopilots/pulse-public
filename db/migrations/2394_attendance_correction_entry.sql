-- migrate:up
-- SPEED-5 (owner, 18 Nov 2026: hr/self, the day's reads): every read of pulse.attendance_effective looks up each entry's
-- latest approved time correction (the view's lateral on attendance_correction_time). On production the planner walked
-- the company's approved regularisations for every entry and ran their row policies (manages, hr_forwarded_request,
-- viewer_is, ai_reads) on each: ~1.7 ms per entry, 13-30 ms for one person's month on My desk, 177 ms for a manager's
-- team, with EA holding 13 requests and 4 corrections. Cause: those tables had never been analyzed (pg_class.reltuples
-- -1; autovacuum analyzes a table only after 50 changes), so the planner assumed hundreds of rows. Read-only check of
-- production, 18 Nov: 154 tables in pulse hold rows and were never analyzed, attendance_regularisation,
-- attendance_correction_time and attendance_provisional_close among them.
-- 1. The HR and attendance tables get statistics now (they are small: a few ms). Later changes are analyzed by
--    autovacuum as usual once they pass its threshold; the planner scales the row counts with the tables' size.
-- 2. attendance_correction_time gets an index by entry, so the lookup stays by entry as corrections accumulate.
-- The same rows; nothing else changes.
create index if not exists attendance_correction_entry on pulse.attendance_correction_time(entry_id, created_at desc, regularisation_id desc);
do $$ declare t text;
begin
  for t in select c.relname from pg_class c where c.relnamespace = 'pulse'::regnamespace and c.relkind in ('r', 'p')
      and (c.relname ~ '^(attendance_|leave_|hr_)' or c.relname in ('holiday', 'shift', 'person_shift', 'person_work_terms'))
    order by c.relname
  loop
    execute format('analyze pulse.%I', t);
  end loop;
end $$;

-- migrate:down
-- Forward-only.

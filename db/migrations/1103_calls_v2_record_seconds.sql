-- migrate:up
-- CALLS-V2: a recording closed without its browser's count (the call ended first, someone else stopped it, or its browser
-- went quiet) kept 0 seconds: greatest(null,0) is 0 in Postgres, so the fallback to the time since it started never ran
-- ("Call recording · 0:00" until the transcript put the audio's length in). The time since it started is used again.
create or replace function pulse.chat_call_record_close(p_rec uuid,p_seconds int) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r chat_call_recording; pol chat_call_policy; staff_only boolean;
begin
 select * into r from chat_call_recording where org_id=current_org() and id=p_rec for update;
 if not found or r.state<>'recording' then return; end if;
 select * into pol from chat_call_policy where org_id=current_org();
 select not exists(select 1 from chat_call_party pa join person pe on pe.id=pa.person_id where pa.call_id=r.call_id and pa.joined_at is not null and pe.side<>'staff') into staff_only;
 update chat_call_recording set state=case when parts>0 then 'saved' else 'failed' end,stopped_at=clock_timestamp(),
  seconds=case when p_seconds is null then least(86400,greatest(0,extract(epoch from clock_timestamp()-started_at))::int) else least(greatest(p_seconds,0),86400) end,
  transcript_state=case when parts>0 and coalesce(pol.transcripts,true) then 'queued' else 'off' end,
  summary_state=case when parts>0 and coalesce(pol.transcripts,true) and (coalesce(pol.ai_summary,'staff')='all' or (coalesce(pol.ai_summary,'staff')='staff' and staff_only)) then 'queued' else 'off' end
 where id=p_rec;
 perform chat_call_record_line(p_rec); perform chat_call_touch(r.call_id);
end $$;

-- migrate:down
-- Forward-only.

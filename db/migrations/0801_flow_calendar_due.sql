-- migrate:up
-- FLOW-A: a due date counted in calendar days ("Day 30", "weeks 3–4") lands on the next working day, not on a Sunday or
-- a holiday (the company's week and holidays, as Day N in working days).
create or replace function pulse.flow_step_due(p_run uuid,p_key text) returns date language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare r flow_run;v_due jsonb;v_from text;v_base date;v_days int;v_work boolean;
begin
 select * into r from flow_run where id=p_run;
 v_due:=flow_def_step(r.definition,p_key)->'due';
 if v_due is null or jsonb_typeof(v_due)<>'object' then return null;end if;
 v_from:=coalesce(v_due->>'from','start');
 v_days:=flow_days(v_due->'days',v_due->>'field',r.fields);
 if v_days is null then return null;end if;
 v_work:=coalesce((v_due->>'workdays')::boolean,true);
 if v_from='day1' then
  if r.day1 is null then return null;end if;
  return case when v_work then flow_workday_add(r.day1,greatest(v_days-1,0)) else flow_workday_add(r.day1+greatest(v_days-1,0),0) end;
 elsif v_from='start' then v_base:=(r.started_at at time zone org_time_zone())::date;
 elsif v_from like 'step:%' then select (s.done_at at time zone org_time_zone())::date into v_base from flow_run_step s where s.run_id=p_run and s.step_key=substr(v_from,6);
 elsif v_from like 'field:%' then begin v_base:=nullif(r.fields->>substr(v_from,7),'')::date;exception when others then v_base:=null;end;
 end if;
 if v_base is null then return null;end if;
 return case when v_work then flow_workday_add(v_base,v_days) else flow_workday_add(v_base+v_days,0) end;
end $$;
-- Dates already set follow on the next settle of each run.

-- migrate:down
-- Forward-only.

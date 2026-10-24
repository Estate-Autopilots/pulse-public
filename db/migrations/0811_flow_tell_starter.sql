-- migrate:up
-- FLOW-D: "Who should know when it's done?" may name whoever started the run (the wire's notify holds 'starter'),
-- beside the run's roles.
create or replace function pulse.flow_value_put(p_run uuid,p_step text,p_port text,p_side text,p_kind text,p_value jsonb,p_by uuid) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r flow_run;v_w jsonb;v_role text;v_to text;v_tport text;v_many boolean;v_title text;v_from_title text;
begin
 select * into r from flow_run where id=p_run;
 insert into flow_value(org_id,run_id,step_key,port,side,kind,value,set_by) values(current_org(),p_run,p_step,p_port,p_side,coalesce(p_kind,'any'),coalesce(p_value,'{}'),p_by)
  on conflict(org_id,run_id,step_key,port,side) do update set value=excluded.value,kind=excluded.kind,set_by=excluded.set_by,set_at=now();
 perform flow_event(p_run,p_step,case when p_side='makes' then 'value' else 'input' end,null,null,p_by,jsonb_build_object('port',p_port));
 if p_side<>'makes' then return;end if;
 select title into v_from_title from flow_run_step where run_id=p_run and step_key=p_step;
 for v_w in select x from jsonb_array_elements(coalesce(r.definition->'wires','[]')) x where x->'from'->>'step'=p_step and x->'from'->>'port'=p_port loop
  v_to:=v_w->'to'->>'step';v_tport:=v_w->'to'->>'port';
  v_many:=coalesce((select (n->>'many')::boolean from jsonb_array_elements(coalesce(r.compiled->'steps'->v_to->'needs','[]')) n where n->>'key'=v_tport limit 1),false);
  insert into flow_value(org_id,run_id,step_key,port,side,kind,value,set_by)
  values(current_org(),p_run,v_to,v_tport,'needs',coalesce(p_kind,'any'),case when v_many then jsonb_build_array(coalesce(p_value,'{}')) else coalesce(p_value,'{}') end,p_by)
  on conflict(org_id,run_id,step_key,port,side) do update set value=case when v_many then
    (case when jsonb_typeof(flow_value.value)='array' then flow_value.value else jsonb_build_array(flow_value.value) end)||jsonb_build_array(excluded.value->0)
    else excluded.value end,kind=excluded.kind,set_by=excluded.set_by,set_at=now();
  select title into v_title from flow_run_step where run_id=p_run and step_key=v_to;
  for v_role in select jsonb_array_elements_text(coalesce(v_w->'notify','[]')) loop
   perform flow_notice(r,v_role,case when v_role='starter' then r.started_by else flow_role_person(r,v_role) end,v_to||':'||p_step||'>'||v_to||':'||v_role,
    coalesce(v_from_title,p_step)||' is done: '||coalesce(v_title,v_to)||' can start'||coalesce(' · '||r.name,''));
  end loop;
 end loop;
end $$;

-- migrate:down
-- Forward-only.

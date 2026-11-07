-- migrate:up
-- Metadata-only access must not expose figures embedded in notes, evidence or future source columns.
create or replace function pulse.money_read(p_dataset text,p_offset int default 0) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result jsonb; show_amount boolean;
begin
 if not money_can('money.read') then raise exception 'money access denied' using errcode='42501'; end if;
 show_amount:=money_can('money.amount.read');
 perform audit_write('restricted_read','money',p_dataset,array[case when show_amount then 'metadata,amount' else 'metadata' end]);
 select jsonb_build_object('total',(select count(*) from pulse_priv.money_observation where dataset=p_dataset),
 'rows',coalesce(jsonb_agg(jsonb_build_object('id',source_key,'dataset',dataset,'approved',approved,'data',
 case when show_amount then payload else
  (select coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb) from jsonb_each(payload) e
   where e.key=any(array['date','last_charge_date','last_observed_date','period','vendor','tool','category','currency','project_key','record_kind','kind','status','active_now','cycle','direction','confidence','owner_account']))
 end,'evidence',case when show_amount then evidence else jsonb_build_object('restricted','Source evidence requires amount permission') end)),'[]'),
 'showAmounts',show_amount) into result from (select * from pulse_priv.money_observation where dataset=p_dataset order by coalesce(payload->>'date',payload->>'last_charge_date',payload->>'last_observed_date') desc nulls last,source_key limit 50 offset greatest(0,p_offset)) r;
 return result;
end $$;
-- migrate:down

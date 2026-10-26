-- migrate:up
-- EST-2189: private operator policy. NULL keeps normal endpoints unrestricted; {} denies all.
-- Endpoint activation and its restriction must be one transaction; no service/API grants change.
alter table pulse_priv.webhook_endpoint add column quotation_subject_ids uuid[],
 add constraint webhook_endpoint_quotation_subjects check(case
  when quotation_subject_ids is null or cardinality(quotation_subject_ids)=0 then true
  when array_ndims(quotation_subject_ids)=1 then array_position(quotation_subject_ids,null) is null
  else false end);

create or replace function pulse.install_event_due(p_limit int default 10) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare e pulse_priv.install_event; ep pulse_priv.webhook_endpoint; jobs jsonb:='[]';
begin
 if install_org() is null then return jobs;end if;
 perform set_config('pulse.org_id',install_org()::text,true);
 -- Lock mutable endpoint policy before any event row; policy writers conflict with SHARE.
 select * into ep from pulse_priv.webhook_endpoint where org_id=install_org() and disabled_at is null for share;
 if ep.id is null then return jobs;end if;
 update pulse_priv.install_event set status='dead_letter',dead_at=now(),next_at=null,lease_token=null,lease_until=null
  where org_id=install_org() and status='pending' and attempts=5 and lease_until<=now()
   and (ep.quotation_subject_ids is null or (subject_kind='quotation' and subject_id=any(ep.quotation_subject_ids)));
 for e in select * from pulse_priv.install_event where org_id=install_org() and status='pending' and attempts<5
  and next_at<=now() and (lease_until is null or lease_until<=now()) and type=any(ep.events)
  and (ep.quotation_subject_ids is null or (subject_kind='quotation' and subject_id=any(ep.quotation_subject_ids)))
  and (endpoint_id is null or endpoint_id=ep.id) order by next_at,sequence limit least(greatest(p_limit,0),10) for update skip locked loop
  update pulse_priv.install_event set endpoint_id=ep.id,lease_token=gen_random_uuid(),lease_until=now()+interval '35 seconds',
   attempts=attempts+1,last_attempt_at=now(),last_status=null,raw_body=coalesce(raw_body,install_event_envelope(e)::text),
   next_at=now()+(array[interval '1 minute',interval '5 minutes',interval '30 minutes',interval '2 hours',interval '35 seconds'])[attempts+1]
   where id=e.id returning * into e;
  insert into pulse_priv.webhook_delivery(id,org_id,endpoint_id,event_id,attempt,error_class,host)
   values(e.lease_token,e.org_id,ep.id,e.id,e.attempts,'interrupted',substring(ep.url from '^https://(\[[^]]+\]|[^/:?#]+)'));
  jobs:=jobs||jsonb_build_array(jsonb_build_object('id',e.id,'lease',e.lease_token));
 end loop;
 return jobs;
end $$;
create or replace function pulse.install_event_dispatch(p_id uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare ep pulse_priv.webhook_endpoint;
begin
 perform set_config('pulse.org_id',install_org()::text,true);
 -- Read the binding without an event lock, then authorize against the locked current endpoint.
 select * into ep from pulse_priv.webhook_endpoint where org_id=install_org() and disabled_at is null
  and id=(select endpoint_id from pulse_priv.install_event where org_id=install_org() and id=p_id) for share;
 if ep.id is null then return null;end if;
 return (select jsonb_build_object('body',e.raw_body,'attempt',e.attempts,'url',ep.url,'keyId',ep.key_id,'secret',ep.signing_secret)
  from pulse_priv.install_event e
  where e.org_id=install_org() and e.endpoint_id=ep.id and e.id=p_id and e.lease_token=p_lease and e.lease_until>now() and e.status='pending'
   and e.type=any(ep.events)
   and (ep.quotation_subject_ids is null or (e.subject_kind='quotation' and e.subject_id=any(ep.quotation_subject_ids))));
end $$;
-- migrate:down
-- Forward only: retain endpoint policy and immutable delivery evidence.

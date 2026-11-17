-- migrate:up
create function pulse.finance_task(p_kind text,p_source text,p_owner uuid,p_due date) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result uuid;k text;owner_id uuid;
begin
 perform finance_authorize(true);
 if p_kind not in ('collection','funding','contract_review','billing_failure') or length(p_source) not between 1 and 1000 then raise exception 'Explicit finance review action required' using errcode='22023';end if;
 owner_id:=coalesce(p_owner,current_viewer());
 if not exists(select 1 from person where id=owner_id and side='staff' and status='active') then raise exception 'Active finance task owner required' using errcode='22023';end if;
 k:='finance:'||p_kind||':'||md5(p_source);
 insert into task(org_id,title,status,owner_id,assignee_person_id,due_at,source_key,source,evidence)
 values(current_org(),case p_kind when 'collection' then 'Review a scheduled collection' when 'funding' then 'Review the media funding plan' when 'billing_failure' then 'Review subscription billing failure' else 'Review subscription contract' end,
 'open',owner_id,owner_id,p_due::timestamptz,k,'pulse',jsonb_build_object('restrictedFinance',true,'href','/finance?tab='||case when p_kind in ('billing_failure','contract_review') then 'subscriptions' else 'forecast' end,'sourceKeyDigest',md5(p_source)))
 on conflict(org_id,source_key) do update set source_key=excluded.source_key returning id into result;
 perform audit_write('finance_task','task',result::text,array['metadata_only']);return result;
end $$;
revoke all on function pulse.finance_task(text,text,uuid,date) from public;
grant execute on function pulse.finance_task(text,text,uuid,date) to pulse_api;
create or replace function pulse.finance_source_add(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result uuid;previous jsonb;
begin
 perform finance_authorize(true);
 if length(coalesce(p->>'externalKey','')) not between 1 and 160 or length(coalesce(p->>'vintage','')) not between 1 and 160
 or jsonb_typeof(p->'issues')<>'array' then raise exception 'Source identity and validation required' using errcode='22023';end if;
 -- Source details are whitelisted by the API; the SQL boundary also rejects raw payroll or unknown fields.
 if exists(select 1 from jsonb_object_keys(p) k where k not in ('externalKey','vintage','kind','account','party','partyConfirmed','currency','scale','minor','direction','cashDate','invoiceDate','dueDate','serviceFrom','serviceTo','dateBasis','reference','label','documentBasis','dataset','observationId','category','projectId','clientId','validation','issues','sourceProvider','originalId')) then raise exception 'Unsupported source fields' using errcode='22023';end if;
 if p->>'kind'='payroll' and p->>'label'<>'Approved aggregate payroll' then raise exception 'Payroll must be a protected aggregate' using errcode='22023';end if;
 if coalesce(p->>'originalId','')<>'' and not exists(select 1 from pulse_priv.finance_source where id=(p->>'originalId')::uuid and body->>'kind' in ('bill','invoice','payroll','topup')) then raise exception 'Original obligation unavailable' using errcode='22023';end if;
 insert into pulse_priv.finance_source(org_id,external_key,vintage,body) values(current_org(),p->>'externalKey',p->>'vintage',p)
 on conflict(org_id,external_key,vintage) do nothing returning id into result;
 if result is null then select id,body into result,previous from pulse_priv.finance_source where external_key=p->>'externalKey' and vintage=p->>'vintage';
 if previous<>p then raise exception 'Immutable source changed; import a new vintage' using errcode='40001';end if;end if;
 return result;
end $$;
-- migrate:down

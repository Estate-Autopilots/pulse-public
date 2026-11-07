-- migrate:up
alter table pulse_priv.acq_envelope add column finance_source_id uuid;
alter table pulse_priv.acq_envelope add foreign key(org_id,finance_source_id) references pulse_priv.finance_source(org_id,id);
create function pulse.acq_document_resolve(e uuid,reason text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare env pulse_priv.acq_envelope%rowtype;src pulse_priv.acq_source%rowtype;b jsonb;f jsonb;sid uuid;proposal jsonb;
begin
 perform finance_authorize(true);
 select * into env from pulse_priv.acq_envelope where org_id=current_org() and id=e for update;select * into src from pulse_priv.acq_source where org_id=current_org() and id=env.source_id;
 if not acq_can(src.project_id,true) or src.purpose<>'finance' or src.state='revoked' or env.state='withdrawn' then raise exception 'Designated authorized finance review required' using errcode='42501';end if;
 if env.state='resolved' then return env.finance_source_id;end if;
 b:=env.body;f:=b->'fields';
 if b->>'malware' is distinct from 'clean' or b->>'parserVersion' is distinct from 'finance-v1' or b->>'ambiguous' is distinct from 'false' or coalesce((b->'confidence'->>'currency')::numeric,0)<0.99 or coalesce((b->'confidence'->>'minor')::numeric,0)<0.99 or coalesce(b->>'contentHash','') !~ '^[a-f0-9]{64}$' or f->>'currency' !~ '^[A-Z]{3}$' or(f->>'minor')::numeric<0 or(f->>'minor')::numeric>9e12 or(f->>'minor')::numeric<>trunc((f->>'minor')::numeric) or(f->>'scale')::int not between 0 and 4 or length(coalesce(reason,''))<3 then raise exception 'Isolated clean scan and certified unambiguous amount required' using errcode='22023';end if;
 perform(f->>'date')::date;
 -- A bill is an obligation, never bank cash. A duplicate in another mailbox supports this same document.
 proposal:=jsonb_build_object('externalKey','bill:'||src.controller::text||':'||(b->>'contentHash'),'vintage','scan-finance-v1','kind','bill','account','','party','vendor:'||(f->>'vendor'),'partyConfirmed',false,'currency',f->>'currency','scale',f->'scale','minor',f->'minor','direction','outflow','cashDate','','invoiceDate',f->>'date','dueDate','','serviceFrom','','serviceTo','','dateBasis','Reviewed bill source date','reference',b->>'contentHash','label',b->>'label','documentBasis',reason,'dataset','acquisition-finance-lane','observationId',b->>'contentHash','category','unassigned','projectId','','clientId','','validation','validated','issues','[]'::jsonb);
 -- First certified amount authority survives replay and additional mailbox evidence.
 select id into sid from pulse_priv.finance_source where org_id=current_org() and external_key=proposal->>'externalKey' and vintage='scan-finance-v1';
 if sid is null then sid:=finance_source_add(proposal);else
 if exists(select 1 from pulse_priv.finance_source where id=sid and(body->>'currency'<>f->>'currency' or body->'minor'<>f->'minor' or body->'scale'<>f->'scale')) then raise exception 'Duplicate bill amounts conflict; review existing authority' using errcode='40001';end if;end if;
 update pulse_priv.acq_envelope set state='resolved',finance_source_id=sid,reason='Certified supporting bill; no extra cash' where id=e;
 perform audit_write('acquisition.finance_review',e::text);return sid;
end $$;
revoke all on function pulse.acq_document_resolve(uuid,text) from public;
grant execute on function pulse.acq_document_resolve(uuid,text) to pulse_api;
-- Client acquisition projection contains aggregate authorized project outcomes, never the buyer pool.
create function pulse.portal_acquisition(pr uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform portal_access(pr);
 return jsonb_build_object('projectId',pr,'path','buyer','enquiries',(select count(*) from pulse_priv.acq_enquiry where org_id=current_org() and project_id=pr and path='buyer' and not withdrawn and not coalesce((body->>'test')::boolean,false)),
 'verifiedBookings',(select count(distinct l.id) from pulse_priv.acq_enquiry l join pulse_priv.acq_stage s on s.enquiry_id=l.id where l.org_id=current_org() and l.project_id=pr and l.path='buyer' and not l.withdrawn and not coalesce((l.body->>'test')::boolean,false) and s.stage='booking' and s.verification='verified' and not exists(select 1 from pulse_priv.acq_stage r where r.org_id=current_org() and r.reverses=s.id)),
 'coverage','Only recorded authorized project outcomes; no cross-client buyer details','eaRevenue','Property outcomes are separate from EA invoice and bank collection','buyerPoolIncluded',false);
end $$;
revoke all on function pulse.portal_acquisition(uuid) from public;
grant execute on function pulse.portal_acquisition(uuid) to pulse_api;

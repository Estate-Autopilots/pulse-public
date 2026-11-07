-- migrate:up
-- One durable media ID for lead attachments; future explicit opt-in location references this ID.
-- Only normalized, envelope-encrypted bytes reach this private table. No service-key grants.
create table pulse_priv.acq_lead_media (
 org_id uuid not null references pulse.org(id),id uuid primary key,lead_id uuid not null,
 uploader uuid not null references pulse.person(id),uploaded_at timestamptz not null default now(),taken_at timestamptz,
 source text not null check(source in('upload','camera')),mime text not null default 'image/webp' check(mime='image/webp'),
 size int not null check(size between 1 and 5000000),width int not null check(width>0),height int not null check(height>0),
 request_key uuid not null,request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 key_id text not null,data_key bytea not null,bytes bytea not null check(octet_length(bytes)=size+29),
 unique(org_id,lead_id,request_key),foreign key(org_id,lead_id) references pulse_priv.acq_enquiry(org_id,id)
);
alter table pulse_priv.acq_lead_media enable row level security;
alter table pulse_priv.acq_lead_media force row level security;
create policy tenant on pulse_priv.acq_lead_media using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());

create function pulse.acq_media_require(l uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if exists(select 1 from tenant_config where org_id=current_org() and doc_kind='tenant' and doc_key='modules' and is_active and body->'off' ? 'acquisition')
 or not exists(select 1 from pulse_priv.acq_enquiry e where e.org_id=current_org() and e.id=l and not e.withdrawn
 and acq_can(e.project_id) and (e.owner_id=current_viewer() or acq_can(e.project_id,true))) then
 raise exception 'Lead photo unavailable' using errcode='P0002';end if;
end $$;
create function pulse.acq_media_list(l uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform acq_media_require(l);
 return coalesce((select jsonb_agg(jsonb_build_object('id',id,'leadId',lead_id,'uploader',uploader,'uploadedAt',uploaded_at,
 'takenAt',taken_at,'source',source,'mime',mime,'size',size,'width',width,'height',height) order by uploaded_at,id)
 from pulse_priv.acq_lead_media where org_id=current_org() and lead_id=l),'[]');
end $$;
create function pulse.acq_media_retry(l uuid,k uuid,h text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare m pulse_priv.acq_lead_media;
begin
 perform acq_media_require(l);
 select * into m from pulse_priv.acq_lead_media where org_id=current_org() and lead_id=l and request_key=k;
 if not found then return null;end if;
 if m.request_hash<>h then raise exception 'Upload retry changed' using errcode='40001';end if;
 return (select x from jsonb_array_elements(acq_media_list(l)) x where x->>'id'=m.id::text);
end $$;
create function pulse.acq_media_add(l uuid,p jsonb,dk bytea,b bytea,k uuid,h text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare old jsonb;
begin
 perform 1 from pulse_priv.acq_enquiry where org_id=current_org() and id=l for update;
 perform acq_media_require(l);
 old:=acq_media_retry(l,k,h);if old is not null then return old;end if;
 if jsonb_typeof(p)<>'object' or p-array['id','requestKey','requestHash','source','takenAt','width','height','size','keyId']<>'{}'::jsonb
 or p->>'requestKey' is distinct from k::text or p->>'requestHash' is distinct from h then raise exception 'Invalid photo metadata' using errcode='22023';end if;
 if (select count(*) from pulse_priv.acq_lead_media where org_id=current_org() and lead_id=l)>=10 then raise exception 'A lead takes at most ten photos' using errcode='54000';end if;
 insert into pulse_priv.acq_lead_media(org_id,id,lead_id,uploader,taken_at,source,size,width,height,request_key,request_hash,key_id,data_key,bytes)
 values(current_org(),(p->>'id')::uuid,l,current_viewer(),(p->>'takenAt')::timestamptz,p->>'source',(p->>'size')::int,
 (p->>'width')::int,(p->>'height')::int,k,h,p->>'keyId',dk,b);
 perform audit_write('acquisition.photo.upload',p->>'id');
 return acq_media_retry(l,k,h);
end $$;
create function pulse.acq_media_read(l uuid,m uuid) returns table(key_id text,data_key bytea,bytes bytea) language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform acq_media_require(l);
 return query select f.key_id,f.data_key,f.bytes from pulse_priv.acq_lead_media f where f.org_id=current_org() and f.lead_id=l and f.id=m;
 if not found then raise exception 'Lead photo unavailable' using errcode='P0002';end if;
 perform audit_write('restricted_read','acquisition.photo:'||m::text);
end $$;
revoke all on function pulse.acq_media_require(uuid),pulse.acq_media_list(uuid),pulse.acq_media_retry(uuid,uuid,text),pulse.acq_media_add(uuid,jsonb,bytea,bytea,uuid,text),pulse.acq_media_read(uuid,uuid) from public;
grant execute on function pulse.acq_media_require(uuid),pulse.acq_media_list(uuid),pulse.acq_media_retry(uuid,uuid,text),pulse.acq_media_add(uuid,jsonb,bytea,bytea,uuid,text),pulse.acq_media_read(uuid,uuid) to pulse_api;
-- migrate:down
-- Forward-only: preserve private attachments and their provenance.

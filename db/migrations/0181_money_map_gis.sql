-- migrate:up
-- R55 parts 2–3 (owner, 11 Oct 2026): "Money is not connected to maps. I need that connected." and "GIS 10x better than
-- now. Currently it's very basic, wrong."
--  * money_party: which client (and so which projects and places) each invoice party is. Zoho invoices name the legal
--    entity ("Basil Promoters LLP") while Pulse names clients after people and projects after folders, so a party
--    links itself only when its name is a client's, or when every distinctive word of it is in one client's project
--    folders. Several clients fit, or none: leadership links it on the map's Money tab. Decisions are kept.
--  * money_map(): invoices with their place, collection status (from FIN-LIVE's bank matching), the active clients on
--    the pod trackers (pipeline) and the parties not yet placed. Leadership with finance grants only; every read audited.
--  * geo_review_scan(): pins that their own evidence contradicts become suggestions in Review data (kind 'geocode'):
--    the project folder names a known locality far from the pin, a shoot for the project happened elsewhere, the pin
--    is far from its city, or the import found conflicting sources. Accepting moves the pin through the audited pin
--    history; "keep" dismisses it. Nothing is geocoded outside Pulse.
--  * market_price: prices per sq ft written in a project's own documents (research notes, brochures), with the file.

create function pulse.geo_km(lat1 double precision,lng1 double precision,lat2 double precision,lng2 double precision) returns double precision
 language sql immutable as $$
 select 2*6371*asin(least(1,sqrt(power(sin(radians(lat2-lat1)/2),2)+cos(radians(lat1))*cos(radians(lat2))*power(sin(radians(lng2-lng1)/2),2))))
$$;
-- A written place to one known locality with a point: its own name, or an alias only one locality has that is not a city.
create function pulse.locality_named(p text) returns uuid language sql stable security definer set search_path=pulse,pg_temp as $$
 with k as (select lower(btrim(regexp_replace(coalesce(p,''),'\s+',' ','g'))) k),
 named as (select l.id from locality l,k where l.lat is not null and l.name<>'' and lower(l.name)=k.k),
 aliased as (select distinct l.id from locality l,k,unnest(l.aliases) a where l.lat is not null and l.name<>'' and lower(btrim(regexp_replace(a,'\s+',' ','g')))=k.k)
 select case when (select count(*) from named)=1 then (select id from named)
  when (select count(*) from named)=0 and (select count(*) from aliased)=1 and not exists(select 1 from locality c,k where lower(c.city)=k.k) then (select id from aliased) end
$$;

-- 1. Money on the map ------------------------------------------------------------------------------------------------
create table pulse_priv.money_party (
 org_id uuid not null references pulse.org(id),
 party_key text not null check(length(party_key) between 1 and 200),
 party text not null check(length(party) between 1 and 300),
 client_id uuid references pulse.client(id),
 project_id uuid references pulse.project(id),        -- only when a person chose one project for every invoice of the party
 basis text not null check(basis in ('exact','words','manual','none')),
 confidence numeric check(confidence between 0 and 1),
 candidates jsonb not null default '[]' check(jsonb_typeof(candidates)='array'),
 status text not null default 'auto' check(status in ('auto','confirmed','rejected','review','none')),
 decided_by uuid references pulse.person(id),decided_at timestamptz,
 updated_at timestamptz not null default now(),
 primary key(org_id,party_key)
);
alter table pulse_priv.money_party enable row level security;
alter table pulse_priv.money_party force row level security;
create policy tenant_isolation on pulse_priv.money_party using (org_id=pulse.current_org()) with check (org_id=pulse.current_org());
grant select,insert,update,delete on pulse_priv.money_party to pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse_priv.money_party for each row execute function pulse.audit_mutation();

-- Projects whose own documents name an invoice party (written by pulse_workers.place_index from the read-only EA index).
create table pulse_priv.money_party_evidence (
 org_id uuid not null references pulse.org(id),
 party_key text not null check(length(party_key) between 1 and 200),
 party text not null,
 project_id uuid not null references pulse.project(id),
 files int not null check(files>0),
 sample text check(length(sample)<=300),
 primary key(org_id,party_key,project_id)
);
alter table pulse_priv.money_party_evidence enable row level security;
alter table pulse_priv.money_party_evidence force row level security;
create policy tenant_isolation on pulse_priv.money_party_evidence using (org_id=pulse.current_org()) with check (org_id=pulse.current_org());
grant select,insert,update,delete on pulse_priv.money_party_evidence to pulse_worker;

-- The distinctive words of a name: legal and filler words gone (value_key), months, years, cities and trade words too.
create function pulse.money_words(p text) returns text[] language sql immutable as $$
 select coalesce(array_agg(distinct w order by w),'{}') from unnest(string_to_array(pulse.value_key(p),' ')) w
 where length(w)>=3 and w !~ '^[0-9]+$' and w not in ('mr','mrs','miss','sir','madam','jan','feb','mar','apr','may','jun','jul','aug','sep','sept','oct','nov','dec',
  'january','february','march','april','june','july','august','september','october','november','december','pune','mumbai','india','maharashtra','pvt','ltd',
  'video','videos','shoot','shooting','package','marketing','fees','fee','agency','ads','meta','month','months','management','production','only','new','phase',
  'lux','luxury','residential','commercial','plots','plot','project','projects','cross','selling','videoshoot','reshoot',
  'promoters','promoter','landmark','landmarks','lifespace','lifespaces','space','spaces','buildcon','buildtech','development','developments','housing',
  'corporation','corp','consultancy','consultants','solutions','services','property','estate','realtor','reality','realities','constructions','construction')
$$;

create function pulse.money_party_refresh() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n int;
begin
 if current_viewer() is not null then perform finance_live_authorize(); end if;
 with parties as (
  select distinct on (value_key(body->>'client')) value_key(body->>'client') k,body->>'client' party
  from pulse_priv.finance_live_record where org_id=current_org() and kind='invoice' and not coalesce((body->>'test')::boolean,false)
   and coalesce(btrim(body->>'client'),'')<>'' and value_key(body->>'client')<>'' order by value_key(body->>'client'),body->>'date' desc),
 proj as (   -- a project's words: its folder name and title, its client's names, the developer written beside it in the shoot sheet,
             -- and the parties its documents name (money_party_evidence, from the place index)
  select pr.id,pr.client_id,coalesce(pr.title,pr.name) title,money_words(coalesce(pr.name,'')||' '||coalesce(pr.title,'')||' '||coalesce(c.display_name,'')||' '||coalesce(c.company_name,'')
   ||' '||coalesce((select string_agg(distinct s.client_label,' ') from talent_shoot s where s.project_id=pr.id and s.project_basis in ('client_name','review')),'')
   ||' '||coalesce((select string_agg(distinct e.party,' ') from pulse_priv.money_party_evidence e where e.org_id=current_org() and e.project_id=pr.id),'')) w
  from project pr left join client c on c.id=pr.client_id where pr.kind='client_work'),
 fit as (
  select p.k,count(distinct coalesce(pj.client_id::text,'project:'||pj.id))::int groups,
   (array_agg(distinct pj.client_id) filter (where pj.client_id is not null))[1:6] clients,
   (array_agg(pj.id order by pj.id) filter (where pj.client_id is null))[1:6] loose,
   cardinality(money_words(p.party)) words
  from parties p join proj pj on cardinality(money_words(p.party))>0 and (money_words(p.party) <@ pj.w
   or not exists(select 1 from unnest(money_words(p.party)) a where length(a)<5 or not exists(select 1 from unnest(pj.w) b where public.similarity(a,b)>=0.6)))
  group by p.k,p.party),
 decided as (
  select p.k,p.party,value_client_of(p.party) exact,f.groups,f.clients,f.loose,coalesce(f.words,0) words from parties p left join fit f on f.k=p.k),
 rows as (
  select k,party,
   case when exact is not null then exact when groups=1 and cardinality(clients)=1 then clients[1] end client_id,
   case when exact is null and groups=1 and coalesce(cardinality(clients),0)=0 and cardinality(loose)=1 then loose[1] end project_id,
   case when exact is not null then 'exact' when groups=1 then 'words' else 'none' end basis,
   case when exact is not null then 0.95 when groups=1 and words>=2 then 0.85 when groups=1 then 0.7 end confidence,
   case when exact is not null or groups=1 then 'auto' when groups between 2 and 6 then 'review' else 'none' end status,
   coalesce((select jsonb_agg(jsonb_build_object('clientId',c.id,'name',c.display_name,'projects',(select count(*) from project x where x.client_id=c.id)))
     from client c where c.id=any(coalesce(clients,'{}')) and (groups between 2 and 6)),'[]') candidates
  from decided),
 up as (
  insert into pulse_priv.money_party(org_id,party_key,party,client_id,project_id,basis,confidence,candidates,status)
  select current_org(),k,party,client_id,project_id,basis,confidence,candidates,status from rows
  on conflict(org_id,party_key) do update set party=excluded.party,client_id=excluded.client_id,project_id=excluded.project_id,basis=excluded.basis,
   confidence=excluded.confidence,candidates=excluded.candidates,status=excluded.status,updated_at=now()
   where money_party.status not in ('confirmed','rejected')
  returning 1)
 select count(*) into n from up;
 return n;
end $$;

-- A person decides: this party is this client (and optionally always this project), or no client in Pulse.
create function pulse.money_party_decide(p_party_key text,p_client uuid,p_project uuid default null) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform finance_live_authorize();
 if current_viewer() is null then raise exception 'Use your own sign-in' using errcode='42501'; end if;
 if p_client is not null and not exists(select 1 from client where id=p_client) then raise exception 'Choose a client' using errcode='22023'; end if;
 if p_project is not null and not exists(select 1 from project where id=p_project and (p_client is null or client_id=p_client)) then raise exception 'Choose one of the client''s projects' using errcode='22023'; end if;
 update pulse_priv.money_party set client_id=coalesce(p_client,(select client_id from project where id=p_project)),project_id=p_project,
  basis=case when p_client is null and p_project is null then basis else 'manual' end,
  status=case when p_client is null and p_project is null then 'rejected' else 'confirmed' end,confidence=case when p_client is null and p_project is null then null else 1 end,
  decided_by=current_viewer(),decided_at=now(),updated_at=now()
 where party_key=p_party_key;
 if not found then raise exception 'Invoice party not found' using errcode='P0002'; end if;
end $$;

-- Every invoice with its client, project and place. The project is the client's engagement that had started by the
-- invoice month (else the first one after it); collection status is FIN-LIVE's reading of the bank lines.
create function pulse.money_invoice_places() returns table(key text,number text,party text,day date,due date,taxable numeric,total numeric,status text,
 overdue_days int,paid_basis text,client_id uuid,project_id uuid,location_id uuid,basis text,confidence numeric,party_status text)
 language sql stable security definer set search_path=pulse,pg_temp as $$
 with inv as (
  select x->>'number' as number,x->>'client' as party,(x->>'date')::date as day,nullif(x->>'due','')::date as due,(x->>'taxable')::numeric as taxable,
   (x->>'total')::numeric as total,x->>'status' as status,coalesce((x->>'overdueDays')::int,0) as overdue_days,x->>'paidBasis' as paid_basis
  from pulse_priv.finance_live_model f cross join lateral jsonb_array_elements(coalesce(f.body->'collections'->'invoices','[]')) x where f.org_id=current_org())
 select r.key,i.number,i.party,i.day,i.due,i.taxable,i.total,i.status,i.overdue_days,i.paid_basis,mp.client_id,pick.id,m.location_id,mp.basis,mp.confidence,mp.status
 from inv i
 left join pulse_priv.finance_live_record r on r.org_id=current_org() and r.kind='invoice' and r.body->>'number'=i.number
 left join pulse_priv.money_party mp on mp.org_id=current_org() and mp.party_key=value_key(i.party) and mp.status in ('auto','confirmed')
 left join lateral (select coalesce(mp.project_id,(select pr.id from project pr where pr.client_id=mp.client_id and pr.kind='client_work'
   order by (pr.start_month is not null and pr.start_month<=date_trunc('month',i.day)+interval '1 month') desc,
    case when pr.start_month<=date_trunc('month',i.day)+interval '1 month' then -extract(epoch from pr.start_month) else extract(epoch from pr.start_month) end nulls last,pr.registry_no limit 1)) id) pick on true
 left join project_location_member m on m.project_id=pick.id
$$;

create function pulse.money_map() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform finance_live_authorize();perform audit_write('restricted_read','finance.map');
 return (with inv as materialized (select i.*,value_key(i.party) pk from money_invoice_places() i)
 select jsonb_build_object(
  'invoices',coalesce((select jsonb_agg(jsonb_build_object('number',number,'party',party,'day',day,'due',due,'taxable',taxable,'total',total,'status',status,
    'overdueDays',overdue_days,'paidBasis',paid_basis,'clientId',client_id,'projectId',project_id,'locationId',location_id,'basis',basis,'confidence',confidence) order by day desc) from inv),'[]'),
  'parties',coalesce((select jsonb_agg(jsonb_build_object('key',mp.party_key,'party',mp.party,'status',mp.status,'basis',mp.basis,'clientId',mp.client_id,
    'clientName',(select display_name from client where id=mp.client_id),'projectId',mp.project_id,'candidates',mp.candidates,
    'invoices',(select count(*) from inv where inv.pk=mp.party_key),'taxable',(select coalesce(sum(inv.taxable),0) from inv where inv.pk=mp.party_key)) order by mp.party)
   from pulse_priv.money_party mp where mp.org_id=current_org()),'[]'),
  'active',coalesce((select jsonb_agg(distinct jsonb_build_object('name',a.name,'projectId',pr.id,'locationId',m.location_id))
   from pulse_priv.finance_live_model f cross join lateral jsonb_array_elements_text(coalesce(f.body->'activeClients'->'names','[]')) a(name)
   left join lateral (select p.id from project p where p.kind='client_work' and value_key(coalesce(p.title,p.name))=value_key(a.name) order by p.start_month desc nulls last limit 1) pr on true
   left join project_location_member m on m.project_id=pr.id where f.org_id=current_org()),'[]'),
  'evidenceEnd',(select body->'collections'->>'evidenceEnd' from pulse_priv.finance_live_model where org_id=current_org()),
  'asOf',(select body->>'asOf' from pulse_priv.finance_live_model where org_id=current_org()),
  'computedAt',(select computed_at from pulse_priv.finance_live_model where org_id=current_org())));
end $$;

revoke all on function pulse.locality_named(text),pulse.money_party_refresh(),pulse.money_party_decide(text,uuid,uuid),pulse.money_invoice_places(),pulse.money_map() from public;
grant execute on function pulse.locality_named(text) to pulse_api,pulse_worker;
grant execute on function pulse.value_key(text) to pulse_worker;   -- the place index reads invoice parties the way the map does
grant execute on function pulse.money_party_refresh() to pulse_api,pulse_worker;
grant execute on function pulse.money_party_decide(text,uuid,uuid),pulse.money_map() to pulse_api;

-- 2. Geocode review -----------------------------------------------------------------------------------------------------
alter table pulse.review_item drop constraint review_item_kind_check;
alter table pulse.review_item add constraint review_item_kind_check check (kind in ('identity','duplicate','project_pod','contact_type','data_gap',
 'correction','manager','holiday','opening_balance','onboard_project_new','talent','geocode'));

-- Places their own evidence contradicts, the most projects affected first. A pin a person placed is never questioned.
--  * locality_centre: a micro-market's centre more than 25 km from its city's centre. The 5 Oct import geocoded some
--    names to a village or a boundary of the same name elsewhere ("Ambegaon, Pune" became the Ambegaon taluka), and
--    every project of that micro-market sits there. A person pastes the right point once and every one of them moves;
--    a town that really is that far is kept with one click.
--  * folder_place: the project folder names a locality Pulse knows, far from the pin.
--  * far_from_city: a project pinned more than 60 km from its city (only pins more precise than a micro-market).
--  * source_conflict: the import found the folder and the documents naming different places.
-- (A shoot's place says nothing about a project's site: model ads for projects elsewhere are shot around Pune.)
create function pulse.geo_suspects() returns table(entity_type text,entity_id uuid,rule text,locality_id uuid,place text,written text,km double precision,
 confidence numeric,projects int) language sql stable security definer set search_path=pulse,pg_temp as $$
 with folder as (
  select m.location_id,p.location written,locality_named(p.location) lid from project_location_member m join project p on p.id=m.project_id
  where coalesce(btrim(p.location),'')<>'' and not exists(select 1 from locality c where lower(c.city)=lower(btrim(p.location)))),
 folder_one as (select f.location_id,count(distinct f.lid) n,(array_agg(f.lid) filter (where f.lid is not null))[1] lid,(array_agg(f.written) filter (where f.lid is not null))[1] written
  from folder f group by 1),
 users as (select x.id,count(l.id)::int n from locality x join project_location l on l.city=x.city and lower(l.locality)=lower(x.name) and l.precision='locality' and l.pinned_at is null
  group by 1),
 cand as (
  select 'locality' et,x.id eid,'locality_centre' rule,null::uuid lid,x.name||', '||x.city place,x.name written,geo_km(x.lat,x.lng,c.lat,c.lng) km,
   (case when x.source like '%/relation/%' then 0.7 else 0.5 end)::numeric conf,coalesce(u.n,0) projects,0 pri
  from locality x join locality c on c.name='' and c.city=x.city and c.lat is not null left join users u on u.id=x.id
  where x.name<>'' and x.lat is not null and geo_km(x.lat,x.lng,c.lat,c.lng)>25 and coalesce(x.source,'') not like 'pulse_review:%'
  union all
  select 'location',l.id,'folder_place',x.id,x.name||', '||x.city,f.written,geo_km(l.lat,l.lng,x.lat,x.lng),case when f.n=1 then 0.85 else 0.6 end::numeric,1,1
  from project_location l join folder_one f on f.location_id=l.id join locality x on x.id=f.lid
  where l.lat is not null and l.pinned_at is null and geo_km(l.lat,l.lng,x.lat,x.lng)>case when l.precision in ('exact','building') then 10 else 4 end
  union all
  select 'location',l.id,'far_from_city',null,null,l.city,geo_km(l.lat,l.lng,c.lat,c.lng),0.5,1,3
  from project_location l join locality c on c.name='' and c.city=l.city and c.lat is not null
  where l.lat is not null and l.pinned_at is null and l.precision in ('exact','building','street') and geo_km(l.lat,l.lng,c.lat,c.lng)>60
  union all
  select 'location',l.id,'source_conflict',null,null,null,null,0.4,1,4 from project_location l
  where l.pinned_at is null and l.review_flags && array['folder_and_document_locality_conflict','document_coordinate_conflicts_with_expected_city','conflicting_document_coordinates',
   'document_pin_conflicts_with_locality_reference','nominatim_project_candidate_too_far_from_locality'])
 select distinct on (eid) et,eid,rule,lid,place,written,km,conf,projects from cand order by eid,pri,km desc nulls last
$$;

create function pulse.geo_review_scan() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n int;
begin
 if current_viewer() is not null and not viewer_is('admin') then raise exception 'An organisation admin checks the map' using errcode='42501'; end if;
 with s as (select * from geo_suspects()),
 named as (select s.*,coalesce(nullif(btrim(l.name),''),l.client_label,x0.name,'Unnamed project') label,coalesce(l.city,x0.city) city,l.locality,l.lat flat,l.lng flng,l.precision fprec,
   coalesce(l.source,x0.source) fsource,coalesce(l.lat,x0.lat) olat,coalesce(l.lng,x0.lng) olng
  from s left join project_location l on s.entity_type='location' and l.id=s.entity_id left join locality x0 on s.entity_type='locality' and x0.id=s.entity_id),
 up as (
  insert into review_item(org_id,source_key,kind,entity_type,entity_id,title,proposed,confidence,evidence)
  select current_org(),'geocode:'||n.entity_id,'geocode',n.entity_type,n.entity_id,
   left(case n.rule
    when 'locality_centre' then n.written||' ('||n.city||'): its centre is '||round(n.km::numeric)||' km from '||n.city||'; '||n.projects||case when n.projects=1 then ' project sits' else ' projects sit' end||' there'
    when 'folder_place' then n.label||': the folder says '||n.written||', '||round(n.km::numeric)||' km from the pin'
    when 'far_from_city' then n.label||': '||round(n.km::numeric)||' km from '||coalesce(n.city,'its city')
    else n.label||': its sources disagree on the place' end,300),
   jsonb_build_object('rule',n.rule,'lat',x.lat,'lng',x.lng,'precision',case when x.id is not null then 'locality' end,'place',n.place,'km',round(n.km::numeric,1),
    'name',n.label,'projects',n.projects,'search',case when n.rule='locality_centre' then n.written||', '||n.city else n.label||', '||coalesce(n.locality||', ','')||coalesce(n.city,'') end),
   n.confidence,
   jsonb_build_object('why',case n.rule
     when 'locality_centre' then n.written||' is placed '||round(n.km::numeric)||' km from the centre of '||n.city||(case when n.fsource like '%/relation/%' then ', on an OpenStreetMap boundary of that name' else '' end)
      ||'. Micro-markets of '||n.city||' are usually within 25 km. If this is the '||n.written||' in '||n.city||', paste its location and every project placed at its centre moves with it; if the place really is that far, keep it.'
     when 'folder_place' then 'The project folder names '||n.written||', a locality Pulse knows, but the pin is '||round(n.km::numeric)||' km away'||coalesce(' in '||nullif(n.locality,'')||', '||n.city,' in '||n.city,'')||'. Accepting moves the pin to the centre of '||n.place||' until someone pins the site itself.'
     when 'far_from_city' then 'The pin is '||round(n.km::numeric)||' km from the centre of '||coalesce(n.city,'its city')||', the city its sources name. Paste the right location, or keep it.'
     else 'The import found the folder and the documents naming different places for this project. Paste the right location, or keep it.' end,
    'from',jsonb_build_object('lat',n.olat,'lng',n.olng,'precision',n.fprec,'city',n.city,'locality',n.locality,'source',n.fsource),'checkedAt',now())
  from named n left join locality x on x.id=n.locality_id
  on conflict(org_id,source_key) do update set title=excluded.title,proposed=excluded.proposed,confidence=excluded.confidence,evidence=excluded.evidence
   where review_item.status='pending'
  returning 1)
 select count(*) into n from up;
 -- A place fixed since, or no longer contradicted, closes its suggestion (as data gaps close themselves).
 update review_item r set status='accepted',decided_at=now(),evidence=r.evidence||'{"closedBy":"check"}'
  where r.kind='geocode' and r.status='pending' and not exists(select 1 from geo_suspects() g where 'geocode:'||g.entity_id=r.source_key);
 return n;
end $$;

-- Accept moves the pin (to the proposal, or to a point the admin gives) with the same history as a pin moved on the map.
-- A micro-market's centre moves with every project placed at it (each move in that project's pin history).
create function pulse.geo_review_decide(p_item uuid,p_accept boolean,p_lat double precision default null,p_lng double precision default null) returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r record;o record;x record;v_lat double precision;v_lng double precision;prec text;src text;moved int:=0;
begin
 if not viewer_is('admin') or current_viewer() is null then raise exception 'An individual organisation admin moves pins' using errcode='42501'; end if;
 select * into r from review_item where id=p_item and kind='geocode' and status='pending' for update;
 if not found then raise exception 'A suggestion has already been decided' using errcode='P0002'; end if;
 if p_accept then
  v_lat:=coalesce(p_lat,(r.proposed->>'lat')::double precision);v_lng:=coalesce(p_lng,(r.proposed->>'lng')::double precision);
  if v_lat is null or v_lng is null or abs(v_lat)>90 or abs(v_lng)>180 or (p_lat is null)<>(p_lng is null) then raise exception 'Choose a point for the pin' using errcode='22023'; end if;
  v_lat:=round(v_lat::numeric,7);v_lng:=round(v_lng::numeric,7);
  if r.entity_type='locality' then
   select * into x from locality where id=r.entity_id for update;
   if not found then raise exception 'Locality not found' using errcode='P0002'; end if;
   src:='pulse_review:centre of '||x.name||' placed by a person';
   update locality set lat=v_lat,lng=v_lng,source=src where id=x.id;
   perform audit_write('update','pulse.locality',x.id::text,array['lat','lng','source']);
   for o in select * from project_location where city=x.city and lower(locality)=lower(x.name) and precision='locality' and pinned_at is null for update loop
    update project_location set lat=v_lat,lng=v_lng,source=src,updated_at=now() where id=o.id;
    insert into project_location_change(org_id,location_id,action,old_lat,old_lng,old_precision,old_source,new_lat,new_lng,new_precision,new_source,note,changed_by)
    values(current_org(),o.id,'pin',o.lat,o.lng,o.precision,o.source,v_lat,v_lng,'locality',src,left('Review data: the centre of '||x.name||' moved',300),current_viewer());
    moved:=moved+1;
   end loop;
  else
   prec:=case when p_lat is not null then 'exact' else coalesce(r.proposed->>'precision','locality') end;
   src:='pulse_review:'||coalesce(r.proposed->>'place','placed by a person');
   select * into o from project_location where id=r.entity_id for update;
   if not found then raise exception 'Location not found' using errcode='P0002'; end if;
   update project_location set lat=v_lat,lng=v_lng,precision=prec,source=src,pinned_by=current_viewer(),pinned_at=now(),updated_at=now() where id=r.entity_id;
   insert into project_location_change(org_id,location_id,action,old_lat,old_lng,old_precision,old_source,new_lat,new_lng,new_precision,new_source,note,changed_by)
   values(current_org(),r.entity_id,'pin',o.lat,o.lng,o.precision,o.source,v_lat,v_lng,prec,src,left('Review data: '||coalesce(r.evidence->>'why',r.title),300),current_viewer());
   moved:=1;
  end if;
 end if;
 update review_item set status=case when p_accept then 'accepted' else 'dismissed' end,decided_by=current_viewer(),decided_at=now(),
  proposed=proposed||case when p_accept then jsonb_build_object('chosenLat',v_lat,'chosenLng',v_lng,'moved',moved) else '{}' end where id=p_item;
 return moved;
end $$;
revoke all on function pulse.geo_suspects(),pulse.geo_review_scan(),pulse.geo_review_decide(uuid,boolean,double precision,double precision) from public;
grant execute on function pulse.geo_review_scan() to pulse_api,pulse_worker;
grant execute on function pulse.geo_review_decide(uuid,boolean,double precision,double precision) to pulse_api;

-- 3. Market prices from project documents --------------------------------------------------------------------------
create table pulse.market_price (
 org_id uuid not null references pulse.org(id),
 file_id text not null check(length(file_id) between 3 and 200),
 price numeric(10,0) not null check(price between 300 and 100000),
 project_id uuid not null references pulse.project(id),
 kind text not null check(kind in ('apartment','plot','commercial','unknown')),
 quote text check(length(quote)<=200),
 file_name text,observed_on date,
 primary key(org_id,file_id,price)
);
create index market_price_project on pulse.market_price(org_id,project_id);
alter table pulse.market_price enable row level security;
alter table pulse.market_price force row level security;
create policy tenant_isolation on pulse.market_price using (org_id=pulse.current_org()) with check (org_id=pulse.current_org());
grant select,insert,update,delete on pulse.market_price to pulse_worker;
grant select on pulse.market_price to pulse_api;
-- migrate:down

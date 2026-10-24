-- migrate:up
alter table pulse_priv.service_key drop constraint service_key_scopes_check;
alter table pulse_priv.service_key add constraint service_key_scopes_check check(cardinality(scopes)>0
 and array_position(scopes,null) is null and scopes <@ (array['catalog.read','clients.read','leads.read','quotes.draft.create','notify.quote_ready','chats.post','updates.post']||pulse.v1_scopes()));
create table pulse.update_post(
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org,
 slot text not null check(slot ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}-(am|pm)$' and left(slot,10)::date::text=left(slot,10)),
 period text generated always as (case right(slot,2) when 'am' then 'morning' else 'night' end) stored,
 headline text not null check(length(trim(headline)) between 1 and 160),
 sections jsonb not null check(jsonb_typeof(sections)='object' and octet_length(sections::text)<=32768),
 service_key_id uuid not null references pulse_priv.service_key, poster_label text not null,
 on_behalf_id uuid not null references pulse.person, audience uuid[] not null
 check(cardinality(audience) between 1 and 50 and array_position(audience,null) is null),
 created_at timestamptz not null default now(), unique(org_id,on_behalf_id,slot));
create index update_post_newest on pulse.update_post(org_id,created_at desc,id desc);
create table pulse.update_receipt(
 update_id uuid not null references pulse.update_post, person_id uuid not null references pulse.person,
 org_id uuid not null references pulse.org, opened_at timestamptz not null default date_trunc('minute',now())
 check(opened_at=date_trunc('minute',opened_at)), primary key(update_id,person_id));
alter table pulse.update_post enable row level security;
alter table pulse.update_post force row level security;
alter table pulse.update_receipt enable row level security;
alter table pulse.update_receipt force row level security;
create policy tenant on pulse.update_post using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy tenant on pulse.update_receipt using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy audience on pulse.update_post as restrictive for select to pulse_api using(pulse.current_viewer()=on_behalf_id or pulse.current_viewer()=any(audience));
create policy receipt_viewer on pulse.update_receipt as restrictive for select to pulse_api using(person_id=pulse.current_viewer() or exists(
 select 1 from pulse.update_post u where u.id=update_id and u.on_behalf_id=pulse.current_viewer()));
revoke all on pulse.update_post,pulse.update_receipt from public,pulse_api,pulse_worker;
grant select on pulse.update_post,pulse.update_receipt to pulse_api;

create function pulse.service_update_post(p_key uuid,p_slot text,p_headline text,p_sections jsonb,p_audience uuid[],p_on_behalf uuid) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare label text; prior update_post; uid uuid; recipients uuid[];
begin
 if current_setting('pulse.actor_account',true) is distinct from 'service:'||p_key::text then
  raise exception 'Service scope required' using errcode='42501'; end if;
 select k.label into label from pulse_priv.service_key k where k.id=p_key and k.org_id=install_org() and k.org_id=current_org()
  and k.revoked_at is null and 'updates.post'=any(k.scopes) for share;
 if label is null then raise exception 'Updates scope required' using errcode='42501'; end if;
 if p_audience is null or cardinality(p_audience) not between 1 and 50 or array_position(p_audience,null) is not null then
  raise exception 'Choose one to fifty recipients' using errcode='22023'; end if;
 select array_agg(distinct id order by id) into recipients from unnest(p_audience) id;
 -- Lock memberships through commit, including on replay. Human staff use side=staff in this schema.
 perform 1 from person where id=any(recipients||p_on_behalf) and org_id=install_org() and side='staff' and status='active' for share;
 if p_on_behalf is null or exists(select 1 from unnest(recipients||p_on_behalf) candidate(id) where not exists(
  select 1 from person p where p.id=candidate.id and p.org_id=install_org() and p.side='staff' and p.status='active')) then
  raise exception 'Audience and sender must be active install staff' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('updates.post:'||p_on_behalf||':'||p_slot,0));
 select * into prior from update_post where org_id=current_org() and on_behalf_id=p_on_behalf and slot=p_slot;
 if found then
  if prior.headline is distinct from p_headline or prior.sections is distinct from p_sections or prior.audience<>recipients then
   raise exception 'Slot already used for another update' using errcode='23505'; end if;
  uid:=prior.id;
 else
  insert into update_post(org_id,slot,headline,sections,service_key_id,poster_label,on_behalf_id,audience)
   values(current_org(),p_slot,p_headline,p_sections,p_key,label,p_on_behalf,recipients) returning id into uid;
 end if;
 return jsonb_build_object('updateId',uid,'replayed',prior.id is not null);
end $$;

create function pulse.update_view(p_id uuid,p_full boolean) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('id',u.id,'slot',u.slot,'period',u.period,'headline',u.headline,'createdAt',u.created_at,
  'poster',u.poster_label||' (AI)','onBehalf',jsonb_build_object('id',p.id,'name',p.display_name),
  'openedAt',(select r.opened_at from update_receipt r where r.update_id=u.id and r.person_id=current_viewer()),'isSender',u.on_behalf_id=current_viewer())
  || case when p_full then jsonb_build_object('sections',u.sections) else jsonb_build_object('counts',jsonb_build_object(
   'live',coalesce(jsonb_array_length(u.sections->'live'),0),'readyToTry',coalesce(jsonb_array_length(u.sections->'readyToTry'),0),
   'requests',coalesce(jsonb_array_length(u.sections->'requests'),0),'ideas',coalesce(jsonb_array_length(u.sections->'ideas'),0),
   'needsYou',coalesce(jsonb_array_length(u.sections->'needsYou'),0))) end
  || case when p_full and u.on_behalf_id=current_viewer() then jsonb_build_object('openedBy',coalesce((select jsonb_agg(
   jsonb_build_object('personId',rp.id,'name',rp.display_name,'openedAt',r.opened_at) order by r.opened_at nulls last,rp.id)
   from unnest(u.audience) a(person_id) join person rp on rp.id=a.person_id and rp.org_id=u.org_id
   left join update_receipt r on r.update_id=u.id and r.person_id=rp.id and r.org_id=u.org_id
   where rp.id<>u.on_behalf_id),'[]'::jsonb)) else '{}'::jsonb end
 from update_post u join person p on p.id=u.on_behalf_id where u.id=p_id and u.org_id=current_org()
  and (current_viewer()=u.on_behalf_id or current_viewer()=any(u.audience))
$$;
create function pulse.update_open(p_id uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare u update_post;
begin
 select * into u from update_post where id=p_id and org_id=current_org()
  and (current_viewer()=on_behalf_id or current_viewer()=any(audience));
 if not found then raise exception 'Update unavailable' using errcode='P0002'; end if;
 if current_viewer()=any(u.audience) then
  insert into update_receipt(update_id,person_id,org_id) values(u.id,current_viewer(),u.org_id) on conflict do nothing;
 end if;
 return update_view(p_id,true);
end $$;
revoke all on function pulse.service_update_post(uuid,text,text,jsonb,uuid[],uuid),pulse.update_view(uuid,boolean),pulse.update_open(uuid) from public;
grant execute on function pulse.service_update_post(uuid,text,text,jsonb,uuid[],uuid),pulse.update_view(uuid,boolean),pulse.update_open(uuid) to pulse_api;
-- migrate:down
-- Forward-only; revoke credentials to disable posting. Preserve updates and receipts.

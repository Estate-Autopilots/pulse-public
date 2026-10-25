-- migrate:up
alter table pulse_priv.service_key drop constraint service_key_scopes_check;
alter table pulse_priv.service_key add constraint service_key_scopes_check check(cardinality(scopes)>0
 and array_position(scopes,null) is null and scopes <@ (array['catalog.read','clients.read','leads.read','quotes.draft.create','notify.quote_ready','chats.post','updates.post','updates.requests.manage']||pulse.v1_scopes()));
create table pulse.update_request(
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org,
 asked_by uuid not null references pulse.person, on_behalf_id uuid not null references pulse.person,
 text text not null check(text=trim(text) and length(text) between 1 and 1000),
 asked_at timestamptz not null default now() check(asked_at<=now()),
 source text not null check(source in ('update_reply','task','chat','manual')),
 update_id uuid references pulse.update_post, client_ref text check(client_ref ~ '^[A-Za-z0-9._:-]{1,120}$'),
 service_key_id uuid references pulse_priv.service_key, unique(org_id,client_ref),
 check((source='update_reply')=(update_id is not null)),
 check(case when source='update_reply' then client_ref is null and service_key_id is null else client_ref is not null and service_key_id is not null end),
 status text not null default 'new' check(status in ('new','planned','started','in_progress','test_site','waiting','live','done')),
 progress int not null default 0 check(progress between 0 and 100), note text not null default '' check(length(note)<=1000),
 updated_at timestamptz not null default now());
create index update_request_register on pulse.update_request(org_id,on_behalf_id,asked_at desc,id desc);
alter table pulse.update_request enable row level security;
alter table pulse.update_request force row level security;
create policy tenant on pulse.update_request using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy participants on pulse.update_request as restrictive for select to pulse_api using(pulse.current_viewer() in (asked_by,on_behalf_id));
revoke all on pulse.update_request from public,pulse_api,pulse_worker;
grant select on pulse.update_request to pulse_api;

-- Invoker security preserves participant RLS for direct staff calls; service definers authenticate below.
create function pulse.update_request_view(p_id uuid) returns jsonb language sql stable set search_path=pulse,pg_temp as $$
 select jsonb_build_object('id',r.id,'text',r.text,'askedAt',r.asked_at,'source',r.source,'updateId',r.update_id,
  'status',r.status,'progress',r.progress,'note',r.note,'updatedAt',r.updated_at,
  'askedBy',jsonb_build_object('id',a.id,'name',a.display_name),'onBehalf',jsonb_build_object('id',b.id,'name',b.display_name))
 from update_request r join person a on a.id=r.asked_by and a.org_id=r.org_id
 join person b on b.id=r.on_behalf_id and b.org_id=r.org_id where r.id=p_id and r.org_id=current_org()
$$;
create function pulse.update_reply(p_update uuid,p_text text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare u update_post; rid uuid;
begin
 select * into u from update_post where id=p_update and org_id=current_org()
  and (current_viewer()=on_behalf_id or current_viewer()=any(audience));
 if not found then raise exception 'Update unavailable' using errcode='P0002'; end if;
 insert into update_request(org_id,asked_by,on_behalf_id,text,source,update_id)
  values(current_org(),current_viewer(),u.on_behalf_id,trim(p_text),'update_reply',u.id) returning id into rid;
 return update_request_view(rid);
end $$;
create function pulse.service_update_request_list(p_key uuid,p_status text,p_on_behalf uuid,p_cursor uuid,p_limit int) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare items jsonb; cursor_id uuid; has_more boolean;
begin
 if current_setting('pulse.actor_account',true) is distinct from 'service:'||p_key::text then
  raise exception 'Service scope required' using errcode='42501'; end if;
 perform 1 from pulse_priv.service_key k where k.id=p_key and k.org_id=install_org() and k.org_id=current_org()
  and k.revoked_at is null and 'updates.requests.manage'=any(k.scopes) for share;
 if not found then raise exception 'Requests scope required' using errcode='42501'; end if;
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'Invalid limit' using errcode='22023'; end if;
 with page as (select r.id,r.asked_at from update_request r where r.org_id=current_org()
  and (p_status is null or r.status=p_status) and (p_on_behalf is null or r.on_behalf_id=p_on_behalf)
  and (p_cursor is null or (r.asked_at,r.id)<(select asked_at,id from update_request where id=p_cursor and org_id=current_org()))
  order by r.asked_at desc,r.id desc limit p_limit+1), numbered as (
  select *,row_number() over(order by asked_at desc,id desc) n from page)
 select coalesce(jsonb_agg(update_request_view(id) order by asked_at desc,id desc) filter(where n<=p_limit),'[]'::jsonb),
  (array_agg(id order by asked_at desc,id desc))[p_limit],count(*)>p_limit into items,cursor_id,has_more from numbered;
 return jsonb_build_object('items',items,'nextCursor',case when has_more then cursor_id else null end);
end $$;
create function pulse.service_update_request_create(p_key uuid,p_ref text,p_asked_by uuid,p_on_behalf uuid,p_source text,p_text text,p_asked_at timestamptz) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare prior update_request; rid uuid;
begin
 if current_setting('pulse.actor_account',true) is distinct from 'service:'||p_key::text then
  raise exception 'Service scope required' using errcode='42501'; end if;
 perform 1 from pulse_priv.service_key k where k.id=p_key and k.org_id=install_org() and k.org_id=current_org()
  and k.revoked_at is null and 'updates.requests.manage'=any(k.scopes) for share;
 if not found then raise exception 'Requests scope required' using errcode='42501'; end if;
 perform 1 from person where id in (p_asked_by,p_on_behalf) and org_id=install_org() and side='staff' and status='active' for share;
 if p_asked_by is null or p_on_behalf is null or exists(select 1 from unnest(array[p_asked_by,p_on_behalf]) candidate(id) where not exists(
  select 1 from person p where p.id=candidate.id and p.org_id=install_org() and p.side='staff' and p.status='active')) then
  raise exception 'Participants must be active install staff' using errcode='42501'; end if;
 if p_source is null or p_source not in ('task','chat','manual') then raise exception 'Invalid source' using errcode='22023'; end if;
 -- Validate timestamps before replay comparison, so invalid input is always 400.
 if p_asked_at>now() then raise exception 'askedAt cannot be in the future' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('update_requests:'||p_ref,0));
 select * into prior from update_request where org_id=current_org() and client_ref=p_ref;
 if found then
  if prior.asked_by is distinct from p_asked_by or prior.on_behalf_id is distinct from p_on_behalf or prior.source is distinct from p_source
   or prior.text is distinct from trim(p_text) or prior.asked_at is distinct from coalesce(p_asked_at,prior.asked_at) then
   raise exception 'Reference already used for another request' using errcode='23505'; end if;
  rid:=prior.id;
 else
  insert into update_request(org_id,asked_by,on_behalf_id,text,asked_at,source,client_ref,service_key_id)
   values(current_org(),p_asked_by,p_on_behalf,trim(p_text),coalesce(p_asked_at,now()),p_source,p_ref,p_key) returning id into rid;
 end if;
 return jsonb_build_object('request',update_request_view(rid))||case when prior.id is not null then jsonb_build_object('replayed',true) else '{}'::jsonb end;
end $$;
create function pulse.service_update_request_set(p_key uuid,p_id uuid,p_status text,p_progress int,p_note text) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_setting('pulse.actor_account',true) is distinct from 'service:'||p_key::text then
  raise exception 'Service scope required' using errcode='42501'; end if;
 perform 1 from pulse_priv.service_key k where k.id=p_key and k.org_id=install_org() and k.org_id=current_org()
  and k.revoked_at is null and 'updates.requests.manage'=any(k.scopes) for share;
 if not found then raise exception 'Requests scope required' using errcode='42501'; end if;
 if p_status is null and p_progress is null and p_note is null then raise exception 'Choose a change' using errcode='22023'; end if;
 update update_request set status=coalesce(p_status,status),progress=coalesce(p_progress,progress),note=coalesce(p_note,note),updated_at=now()
  where id=p_id and org_id=current_org();
 if not found then raise exception 'Request unavailable' using errcode='P0002'; end if;
 return update_request_view(p_id);
end $$;
revoke all on function pulse.update_request_view(uuid),pulse.update_reply(uuid,text),pulse.service_update_request_list(uuid,text,uuid,uuid,int),
 pulse.service_update_request_create(uuid,text,uuid,uuid,text,text,timestamptz),pulse.service_update_request_set(uuid,uuid,text,int,text) from public;
grant execute on function pulse.update_request_view(uuid),pulse.update_reply(uuid,text),pulse.service_update_request_list(uuid,text,uuid,uuid,int),
 pulse.service_update_request_create(uuid,text,uuid,uuid,text,text,timestamptz),pulse.service_update_request_set(uuid,uuid,text,int,text) to pulse_api;
-- migrate:down
-- Forward-only: preserve the register; revoke keys to disable service management.

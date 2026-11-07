-- migrate:up
-- ONBOARD (owner, 26 Oct 2026): a public, self-serve team setup page (/team-setup). A colleague types the team code the
-- admin shares in the team's WhatsApp group, their name, and either their company Google address or (no account yet)
-- a personal e-mail and WhatsApp number. It lands in HR → Onboard team → Team setup for an admin or HR to act on;
-- nothing is sent to anyone automatically, and the page never lists names. The admin creates missing Google accounts
-- with a GAM command the page prints (Pulse never holds the Google admin password).

-- The organisation's team code (admins and HR see and rotate it) and its company Google domain.
create table pulse_priv.team_setup(
 org_id uuid primary key references pulse.org(id),
 code text not null check(code~'^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
 enabled boolean not null default true,
 domain text check(domain~'^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
 changed_at timestamptz not null default now(),
 changed_by uuid references pulse.person(id));
-- What a colleague sent. One open request per name (sending again updates it).
create table pulse_priv.team_setup_request(
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references pulse.org(id),
 name text not null check(length(name) between 2 and 120),
 name_key text not null check(length(name_key) between 1 and 120),
 has_google boolean not null,
 company_email text check(company_email~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' and length(company_email)<=254),
 personal_email text check(personal_email~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' and length(personal_email)<=254),
 whatsapp text check(whatsapp~'^\+?[0-9]{8,15}$'),
 status text not null default 'new' check(status in('new','done','dismissed')),
 person_id uuid references pulse.person(id),
 decided_by uuid references pulse.person(id),
 decided_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check(has_google=(company_email is not null)),
 check(has_google or (personal_email is not null and whatsapp is not null)));
create unique index team_setup_request_open on pulse_priv.team_setup_request(org_id,name_key) where status='new';
-- The company's Google Workspace directory as the admin last pasted it (GAM's "print users"): only to suggest a
-- colleague's address when the name they type matches one account, and to mark which addresses exist.
create table pulse_priv.workspace_account(
 org_id uuid not null references pulse.org(id),
 email text not null check(email~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' and length(email)<=254),
 given_name text check(length(given_name)<=120),
 family_name text check(length(family_name)<=120),
 suspended boolean not null default false,
 loaded_at timestamptz not null default now(),
 loaded_by uuid references pulse.person(id),
 primary key(org_id,email));
do $$ declare t text; begin
 foreach t in array array['team_setup','team_setup_request','workspace_account'] loop
  execute format('alter table pulse_priv.%I enable row level security',t);
  execute format('alter table pulse_priv.%I force row level security',t);
  execute format('create policy tenant on pulse_priv.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 end loop;
end $$;

-- "Tara  Kapoor", "tara kapoor." and "TARA KAPOOR" are the same name.
create function pulse.team_setup_key(t text) returns text language sql immutable set search_path=pulse,pg_temp as $$
 select btrim(regexp_replace(lower(coalesce(t,'')),'[^[:alnum:]]+',' ','g'))
$$;
create function pulse.team_setup_norm_code(t text) returns text language sql immutable set search_path=pulse,pg_temp as $$
 select case when length(x)=8 then left(x,4)||'-'||right(x,4) else x end from (select upper(regexp_replace(coalesce(t,''),'[^A-Za-z0-9]','','g')) x) s
$$;
-- A fresh code: 8 characters without look-alikes (no 0/O, 1/I/L), shown as XXXX-XXXX.
create function pulse.team_setup_new_code() returns text language sql volatile set search_path=pulse,public,pg_temp as $$
 select left(c,4)||'-'||right(c,4) from (select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789',1+(get_byte(b,i)%31),1),'' order by i) c
  from (select gen_random_bytes(8) b) r,generate_series(0,7) i) s
$$;

-- The one directory account whose name is the name typed (full name, or a single first name that only one account has).
create function pulse.team_setup_suggest(p_name text) returns text language sql stable security definer set search_path=pulse,pg_temp as $$
 with k as (select team_setup_key(p_name) k),
 full_name as (select email from pulse_priv.workspace_account w,k where w.org_id=current_org() and not w.suspended and team_setup_key(coalesce(w.given_name,'')||' '||coalesce(w.family_name,''))=k.k),
 first_name as (select email from pulse_priv.workspace_account w,k where w.org_id=current_org() and not w.suspended and position(' ' in k.k)=0 and team_setup_key(w.given_name)=k.k)
 select case when (select count(*) from full_name)=1 then (select email from full_name)
  when (select count(*) from full_name)=0 and (select count(*) from first_name)=1 then (select email from first_name) end
$$;

-- Public (no sign-in; the API limits attempts per address and per code): is the code right, and is there one
-- Workspace account for this name? Only that one address comes back, never a list.
create function pulse.team_setup_check(p_code text,p_name text) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare s pulse_priv.team_setup%rowtype;
begin
 select * into s from pulse_priv.team_setup where org_id=current_org();
 if not found or s.code is distinct from team_setup_norm_code(p_code) then return jsonb_build_object('error','code');end if;
 if not s.enabled then return jsonb_build_object('error','closed');end if;
 return jsonb_build_object('ok',true,'domain',s.domain,'suggestion',case when length(team_setup_key(p_name))>=2 then team_setup_suggest(p_name) end);
end $$;

create function pulse.team_setup_submit(b jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s pulse_priv.team_setup%rowtype;n text:=btrim(regexp_replace(coalesce(b->>'name',''),'\s+',' ','g'));k text:=team_setup_key(b->>'name');
 g boolean:=(b->>'hasGoogle')::boolean;ce text:=nullif(lower(btrim(coalesce(b->>'email',''))),'');pe text:=nullif(lower(btrim(coalesce(b->>'personalEmail',''))),'');
 wa text:=nullif(regexp_replace(coalesce(b->>'whatsapp',''),'[^0-9+]','','g'),'');r uuid;
begin
 select * into s from pulse_priv.team_setup where org_id=current_org();
 if not found or s.code is distinct from team_setup_norm_code(b->>'code') then return jsonb_build_object('error','code');end if;
 if not s.enabled then return jsonb_build_object('error','closed');end if;
 if length(n) not between 2 and 120 or length(k)<2 or g is null then return jsonb_build_object('error','name');end if;
 if g then
  pe:=null;wa:=null;
  if ce is null or ce!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(ce)>254 then return jsonb_build_object('error','email');end if;
  if s.domain is not null and split_part(ce,'@',2)<>s.domain then return jsonb_build_object('error','domain','domain',s.domain);end if;
 else
  ce:=null;
  if pe is null or pe!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(pe)>254 then return jsonb_build_object('error','personal');end if;
  if s.domain is not null and split_part(pe,'@',2)=s.domain then return jsonb_build_object('error','personal_is_company','domain',s.domain);end if;
  if left(wa,1)<>'+' and length(wa)=10 then wa:='+91'||wa;end if;
  if wa is null or wa!~'^\+?[0-9]{8,15}$' then return jsonb_build_object('error','whatsapp');end if;
 end if;
 update pulse_priv.team_setup_request set name=n,has_google=g,company_email=ce,personal_email=pe,whatsapp=wa,updated_at=now()
  where org_id=current_org() and name_key=k and status='new' returning id into r;
 if r is null then
  if (select count(*) from pulse_priv.team_setup_request where org_id=current_org() and status='new')>=300 then return jsonb_build_object('error','full');end if;
  insert into pulse_priv.team_setup_request(org_id,name,name_key,has_google,company_email,personal_email,whatsapp) values(current_org(),n,k,g,ce,pe,wa) returning id into r;
 end if;
 perform audit_write('team_setup_request','team_setup_request',r::text);
 return jsonb_build_object('ok',true);
end $$;

-- HR → Onboard team → Team setup: the code, the requests with what Pulse knows about each, and the directory.
create function pulse.team_setup_state() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s pulse_priv.team_setup%rowtype;loaded boolean;
begin
 if current_viewer() is null or not viewer_is('admin','hr') then raise exception 'HR or admin required' using errcode='42501';end if;
 perform audit_write('restricted_read','team_setup');
 select * into s from pulse_priv.team_setup where org_id=current_org();
 loaded:=exists(select 1 from pulse_priv.workspace_account where org_id=current_org());
 return jsonb_build_object(
  'setup',case when s.org_id is null then null else jsonb_build_object('code',s.code,'enabled',s.enabled,'domain',s.domain,'changedAt',s.changed_at,
   'changedBy',(select display_name from person where id=s.changed_by)) end,
  'suggestedDomain',coalesce(s.domain,(select allowed_domains[1] from pulse_priv.google_settings where org_id=current_org()),
   (select nullif(split_part(lower(email),'@',2),'') from people_profile where person_id=current_viewer())),
  'directory',jsonb_build_object('count',(select count(*) from pulse_priv.workspace_account where org_id=current_org()),
   'loadedAt',(select max(loaded_at) from pulse_priv.workspace_account where org_id=current_org()),
   'emails',coalesce((select jsonb_agg(email order by email) from pulse_priv.workspace_account where org_id=current_org()),'[]')),
  'requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'hasGoogle',r.has_google,'email',r.company_email,'personalEmail',r.personal_email,
    'whatsapp',r.whatsapp,'status',r.status,'createdAt',r.created_at,'updatedAt',r.updated_at,'decidedAt',r.decided_at,
    'decidedBy',(select display_name from person where id=r.decided_by),'personId',r.person_id,
    'workspace',case when not loaded or r.company_email is null then null else exists(select 1 from pulse_priv.workspace_account w where w.org_id=current_org() and w.email=r.company_email) end,
    'matches',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name,'email',pp.email,'signedIn',exists(select 1 from login_credential c where c.person_id=p.id and c.last_login_at is not null),
       'google',exists(select 1 from pulse_priv.google_identity gi where gi.org_id=current_org() and gi.person_id=p.id)) order by p.display_name)
      from person p join people_profile pp on pp.person_id=p.id
      where p.org_id=current_org() and p.side='staff' and p.status='active'
       and (team_setup_key(p.display_name)=r.name_key or (r.company_email is not null and lower(pp.email)=r.company_email) or p.id=r.person_id)),'[]'))
   order by r.status='new' desc,r.updated_at desc) from pulse_priv.team_setup_request r where r.org_id=current_org() and (r.status='new' or r.updated_at>now()-interval '60 days')),'[]'));
end $$;

-- Every admin action: rotate / enable / disable the code, set the domain, load the directory, decide a request.
create function pulse.team_setup_admin(op text,b jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s pulse_priv.team_setup%rowtype;d text;r pulse_priv.team_setup_request%rowtype;e text;n int:=0;acc jsonb;
begin
 if current_viewer() is null or not viewer_is('admin','hr') then raise exception 'HR or admin required' using errcode='42501';end if;
 select * into s from pulse_priv.team_setup where org_id=current_org() for update;
 if op in('rotate','enable','disable','domain') then
  d:=case when op='domain' then nullif(lower(btrim(coalesce(b->>'domain',''))),'') else coalesce(s.domain,(team_setup_state()->>'suggestedDomain')) end;
  if d is not null and d!~'^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' then raise exception 'Type a domain such as company.com' using errcode='22023';end if;
  insert into pulse_priv.team_setup(org_id,code,enabled,domain,changed_by) values(current_org(),team_setup_new_code(),op<>'disable',d,current_viewer())
  on conflict(org_id) do update set code=case when op='rotate' then excluded.code else team_setup.code end,
   enabled=case when op='enable' then true when op='disable' then false else team_setup.enabled end,
   domain=case when op='domain' then excluded.domain else team_setup.domain end,changed_at=now(),changed_by=current_viewer();
  perform audit_write('team_setup_'||op,'team_setup');
 elsif op='directory' then
  if jsonb_typeof(b->'accounts') is distinct from 'array' or jsonb_array_length(b->'accounts')>5000 then raise exception 'Paste the directory list' using errcode='22023';end if;
  delete from pulse_priv.workspace_account where org_id=current_org();
  for acc in select value from jsonb_array_elements(b->'accounts') loop
   e:=lower(btrim(coalesce(acc->>'email','')));
   continue when e!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(e)>254 or (s.domain is not null and split_part(e,'@',2)<>s.domain);
   insert into pulse_priv.workspace_account(org_id,email,given_name,family_name,suspended,loaded_by)
   values(current_org(),e,left(nullif(btrim(acc->>'givenName'),''),120),left(nullif(btrim(acc->>'familyName'),''),120),coalesce((acc->>'suspended')::boolean,false),current_viewer())
   on conflict do nothing;
   if found then n:=n+1;end if;
  end loop;
  perform audit_write('team_setup_directory','workspace_account',n::text);
 elsif op='decide' then
  select * into r from pulse_priv.team_setup_request where org_id=current_org() and id=(b->>'id')::uuid for update;
  if not found then raise exception 'Request not found' using errcode='P0002';end if;
  if b->>'action'='use-email' then
   e:=lower(btrim(coalesce(b->>'email',r.company_email,'')));
   if e!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Type the company address' using errcode='22023';end if;
   if not exists(select 1 from person where org_id=current_org() and id=(b->>'personId')::uuid and side='staff' and status='active') then raise exception 'Pick the person in Pulse' using errcode='22023';end if;
   -- The same audited write as a person's Account access → Work e-mail (record_change, auth event).
   perform auth_admin_email((b->>'personId')::uuid,'email-work-save',jsonb_build_object('email',e));
   update pulse_priv.team_setup_request set status='done',person_id=(b->>'personId')::uuid,company_email=coalesce(company_email,case when has_google then e end),
    decided_by=current_viewer(),decided_at=now(),updated_at=now() where id=r.id;
  elsif b->>'action' in('done','dismiss','reopen') then
   update pulse_priv.team_setup_request set status=case b->>'action' when 'done' then 'done' when 'dismiss' then 'dismissed' else 'new' end,
    decided_by=case when b->>'action'='reopen' then null else current_viewer() end,decided_at=case when b->>'action'='reopen' then null else now() end,updated_at=now() where id=r.id;
  else raise exception 'Choose what to do with the request' using errcode='22023';end if;
  perform audit_write('team_setup_'||(b->>'action'),'team_setup_request',r.id::text);
 else raise exception 'Choose a team setup action' using errcode='22023';end if;
 return team_setup_state();
end $$;

revoke all on function pulse.team_setup_key(text),pulse.team_setup_norm_code(text),pulse.team_setup_new_code(),pulse.team_setup_suggest(text),pulse.team_setup_check(text,text),pulse.team_setup_submit(jsonb),pulse.team_setup_state(),pulse.team_setup_admin(text,jsonb) from public;
grant execute on function pulse.team_setup_check(text,text),pulse.team_setup_submit(jsonb),pulse.team_setup_state(),pulse.team_setup_admin(text,jsonb) to pulse_api;

-- migrate:down
drop function pulse.team_setup_admin(text,jsonb);
drop function pulse.team_setup_state();
drop function pulse.team_setup_submit(jsonb);
drop function pulse.team_setup_check(text,text);
drop function pulse.team_setup_suggest(text);
drop function pulse.team_setup_new_code();
drop function pulse.team_setup_norm_code(text);
drop function pulse.team_setup_key(text);
drop table pulse_priv.workspace_account;
drop table pulse_priv.team_setup_request;
drop table pulse_priv.team_setup;

-- migrate:up
-- EST-1363 (owner, 20 Oct 2026): Sales X-Ray as an app inside Pulse. Each person connects their own Sales X-Ray account
-- (OAuth 2.0 code + PKCE S256 at Sales X-Ray's Connect); Pulse keeps only what it needs to read for them, sealed by the
-- API with the document keyring (document-keys.ts), so neither the tokens nor the client secret reach PostgreSQL in
-- the clear. No Sales X-Ray data is stored: calls and leads are read live for the person on screen.
--  * sales_xray_client: the OAuth client Pulse registered for itself at one Sales X-Ray address (RFC 7591), per company
--    and return address. Its secret is sealed ({k,w,d}: master key id, wrapped data key, sealed bytes).
--  * sales_xray_attempt: one Connect in flight, 10 minutes, bound to the person who started it; the state is stored as
--    its SHA-256 and the attempt is used once.
--  * sales_xray_link: one person's connection: sealed access and refresh tokens, scopes and what Sales X-Ray said about
--    the account (person name, workspace name and kind, role). A refresh holds the row's lock, so two reads at once
--    never spend one refresh token twice (Sales X-Ray ends a connection whose old refresh token comes back).
create table pulse_priv.sales_xray_client(org_id uuid not null references pulse.org(id),base text not null check(base~'^https?://[a-z0-9.:-]+$'),
 redirect_uri text not null check(length(redirect_uri) between 10 and 512),client_id text not null check(client_id~'^sxc_[A-Za-z0-9]{24}$'),
 secret_sealed jsonb not null check(secret_sealed ?& array['k','w','d']),created_by uuid references pulse.person(id),created_at timestamptz not null default now(),
 primary key(org_id,base,redirect_uri));
create table pulse_priv.sales_xray_attempt(org_id uuid not null references pulse.org(id),person_id uuid not null references pulse.person(id),
 state_hash text primary key check(state_hash~'^[a-f0-9]{64}$'),verifier text not null check(verifier~'^[A-Za-z0-9._~-]{43,128}$'),
 base text not null,redirect_uri text not null,expires_at timestamptz not null default now()+interval '10 minutes');
create table pulse_priv.sales_xray_link(org_id uuid not null references pulse.org(id),person_id uuid not null references pulse.person(id),base text not null,redirect_uri text not null,
 access_sealed jsonb not null check(access_sealed ?& array['k','w','d']),access_expires_at timestamptz not null,
 refresh_sealed jsonb not null check(refresh_sealed ?& array['k','w','d']),scopes text[] not null default '{}',account jsonb not null default '{}',
 connected_at timestamptz not null default now(),refreshed_at timestamptz,last_used_at timestamptz,primary key(org_id,person_id));
do $$ declare t text;begin
 foreach t in array array['sales_xray_client','sales_xray_attempt','sales_xray_link'] loop
  execute format('alter table pulse_priv.%I enable row level security',t);
  execute format('alter table pulse_priv.%I force row level security',t);
  execute format('create policy tenant on pulse_priv.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 end loop;
end $$;
-- The API's one entry: every operation is the signed-in staff person's own (current_viewer()); nobody reads another
-- person's link, not even an admin. Sealed values go in and out as {k,w,d}; plaintext never does.
create function pulse.sales_xray(op text,b jsonb default '{}') returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();l pulse_priv.sales_xray_link%rowtype;a pulse_priv.sales_xray_attempt%rowtype;c pulse_priv.sales_xray_client%rowtype;fresh boolean;
begin
 if me is null or not exists(select 1 from person where org_id=current_org() and id=me and side='staff' and status='active') then raise exception 'A staff account is required' using errcode='42501';end if;
 if op='client' then
  select * into c from pulse_priv.sales_xray_client where org_id=current_org() and base=b->>'base' and redirect_uri=b->>'redirectUri';
  return case when found then jsonb_build_object('clientId',c.client_id,'secret',c.secret_sealed) end;
 elsif op='client_save' then
  insert into pulse_priv.sales_xray_client(org_id,base,redirect_uri,client_id,secret_sealed,created_by) values(current_org(),b->>'base',b->>'redirectUri',b->>'clientId',b->'secret',me) on conflict do nothing;
  select * into c from pulse_priv.sales_xray_client where org_id=current_org() and base=b->>'base' and redirect_uri=b->>'redirectUri';
  return jsonb_build_object('clientId',c.client_id,'secret',c.secret_sealed);
 elsif op='begin' then
  delete from pulse_priv.sales_xray_attempt where org_id=current_org() and (expires_at<=now() or person_id=me);
  insert into pulse_priv.sales_xray_attempt(org_id,person_id,state_hash,verifier,base,redirect_uri) values(current_org(),me,b->>'stateHash',b->>'verifier',b->>'base',b->>'redirectUri');
  return jsonb_build_object('ok',true);
 elsif op='take' then
  -- Used once, and only by the person who started it: a code and state carried to someone else's session find nothing.
  delete from pulse_priv.sales_xray_attempt where org_id=current_org() and state_hash=b->>'stateHash' and person_id=me and expires_at>clock_timestamp() returning * into a;
  if not found then return jsonb_build_object('error','state_invalid');end if;
  return jsonb_build_object('verifier',a.verifier,'base',a.base,'redirectUri',a.redirect_uri);
 elsif op in('link','lock') then
  if op='lock' then select * into l from pulse_priv.sales_xray_link where org_id=current_org() and person_id=me for update;
  else select * into l from pulse_priv.sales_xray_link where org_id=current_org() and person_id=me;end if;
  if not found then return null;end if;
  return jsonb_build_object('base',l.base,'redirectUri',l.redirect_uri,'access',l.access_sealed,'accessExpiresAt',l.access_expires_at,'refresh',l.refresh_sealed,'scopes',to_jsonb(l.scopes),'account',l.account,'connectedAt',l.connected_at);
 elsif op='save' then
  fresh:=not exists(select 1 from pulse_priv.sales_xray_link where org_id=current_org() and person_id=me);
  insert into pulse_priv.sales_xray_link(org_id,person_id,base,redirect_uri,access_sealed,access_expires_at,refresh_sealed,scopes,account)
   values(current_org(),me,b->>'base',b->>'redirectUri',b->'access',(b->>'accessExpiresAt')::timestamptz,b->'refresh',array(select jsonb_array_elements_text(b->'scopes')),coalesce(b->'account','{}'))
   on conflict(org_id,person_id) do update set base=excluded.base,redirect_uri=excluded.redirect_uri,access_sealed=excluded.access_sealed,access_expires_at=excluded.access_expires_at,refresh_sealed=excluded.refresh_sealed,
    scopes=excluded.scopes,account=excluded.account,connected_at=now(),refreshed_at=null;
  perform audit_write('sales_xray_connected','sales_xray_link',me::text);
  return jsonb_build_object('ok',true,'fresh',fresh);
 elsif op='refreshed' then
  update pulse_priv.sales_xray_link set access_sealed=b->'access',access_expires_at=(b->>'accessExpiresAt')::timestamptz,refresh_sealed=b->'refresh',refreshed_at=now()
   where org_id=current_org() and person_id=me;
  return jsonb_build_object('ok',found);
 elsif op='used' then
  update pulse_priv.sales_xray_link set last_used_at=now() where org_id=current_org() and person_id=me and (last_used_at is null or last_used_at<now()-interval '1 minute');
  return jsonb_build_object('ok',true);
 elsif op='drop' then
  delete from pulse_priv.sales_xray_link where org_id=current_org() and person_id=me;
  if found then perform audit_write('sales_xray_disconnected','sales_xray_link',me::text);end if;
  delete from pulse_priv.sales_xray_attempt where org_id=current_org() and person_id=me;
  return jsonb_build_object('ok',true);
 elsif op='status' then
  select * into l from pulse_priv.sales_xray_link where org_id=current_org() and person_id=me;
  if not found then return jsonb_build_object('connected',false);end if;
  return jsonb_build_object('connected',true,'base',l.base,'scopes',to_jsonb(l.scopes),'account',l.account,'connectedAt',l.connected_at,'lastUsedAt',l.last_used_at);
 end if;
 raise exception 'Unknown Sales X-Ray action' using errcode='22023';
end $$;
revoke all on function pulse.sales_xray(text,jsonb) from public;
grant execute on function pulse.sales_xray(text,jsonb) to pulse_api;
-- migrate:down
drop function pulse.sales_xray(text,jsonb);
drop table pulse_priv.sales_xray_link,pulse_priv.sales_xray_attempt,pulse_priv.sales_xray_client;

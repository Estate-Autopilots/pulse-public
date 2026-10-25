-- migrate:up
-- Provider messages reuse native member-scoped chat storage. Business ingestion never reads this lane.
create table pulse_priv.chat_provider_binding(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),account_ref text not null,
 channel_id uuid not null,person_id uuid not null references pulse.person(id),aliases jsonb not null,authority text not null,
 active boolean not null default true,capabilities jsonb not null default '{}',last_at timestamptz,
 unique(org_id,id),foreign key(org_id,channel_id) references pulse.chat_channel(org_id,id));
create table pulse_priv.chat_provider_receipt(
 org_id uuid not null,binding_id uuid not null,external_id text not null,message_id uuid,occurred timestamptz not null,received timestamptz not null default now(),
 state text not null check(state in('accepted','unsupported')),primary key(org_id,binding_id,external_id),
 foreign key(org_id,binding_id) references pulse_priv.chat_provider_binding(org_id,id),foreign key(org_id,message_id) references pulse.chat_message(org_id,id));
do $$declare t text;begin foreach t in array array['chat_provider_binding','chat_provider_receipt'] loop
 execute format('alter table pulse_priv.%I enable row level security',t);execute format('alter table pulse_priv.%I force row level security',t);
 execute format('create policy tenant on pulse_priv.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);end loop;end $$;
create function pulse.chat_provider_bind(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare bid uuid:=coalesce(nullif(p->>'id','')::uuid,gen_random_uuid());ch uuid:=(p->>'channelId')::uuid;pe uuid:=(p->>'personId')::uuid;old pulse_priv.chat_provider_binding%rowtype;
begin
 if not viewer_is('admin') or not chat_has(ch) or not exists(select 1 from chat_member where org_id=current_org() and channel_id=ch and person_id=pe) or length(coalesce(p->>'authority',''))<3 or length(coalesce(p->>'accountRef',''))<1 or jsonb_typeof(p->'aliases') is distinct from 'array' or jsonb_array_length(p->'aliases')=0 then raise exception 'Reviewed provider mapping requires current conversation membership' using errcode='42501';end if;
 select * into old from pulse_priv.chat_provider_binding where org_id=current_org() and id=bid;
 if old.id is not null and(old.channel_id<>ch or old.person_id<>pe or old.account_ref<>p->>'accountRef') then raise exception 'Provider participant scope is immutable' using errcode='40001';end if;
 insert into pulse_priv.chat_provider_binding(id,org_id,account_ref,channel_id,person_id,aliases,authority,active,capabilities) values(bid,current_org(),p->>'accountRef',ch,pe,p->'aliases',p->>'authority',coalesce((p->>'active')::boolean,true),coalesce(p->'capabilities','{}')) on conflict(id) do update set aliases=excluded.aliases,active=excluded.active,authority=excluded.authority,capabilities=excluded.capabilities;
 perform audit_write('chat.provider_mapping',bid::text);return bid;
end $$;
create function pulse.chat_provider_receive(b uuid,p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare binding pulse_priv.chat_provider_binding%rowtype;mid uuid;old pulse_priv.chat_provider_receipt%rowtype;st text;
begin
 select * into binding from pulse_priv.chat_provider_binding where org_id=current_org() and id=b for update;
 if binding.id is null or not binding.active or p->>'accountRef' is distinct from binding.account_ref or not exists(select 1 from jsonb_array_elements(binding.aliases) a join jsonb_array_elements(p->'aliases') r on a->>'version'=r->>'version' and a->>'key'=r->>'key') or not exists(select 1 from chat_member m join person pe on pe.id=m.person_id where m.org_id=current_org() and m.channel_id=binding.channel_id and m.person_id=binding.person_id and pe.status='active') then raise exception 'Verified current account and participant mapping required' using errcode='42501';end if;
 if length(coalesce(p->>'externalId','')) not between 1 and 200 or p->>'at' is null or p->>'kind' is null or p->>'kind' not in('text','unsupported') then raise exception 'Provider message identity and timestamp required' using errcode='22023';end if;
 select * into old from pulse_priv.chat_provider_receipt where org_id=current_org() and binding_id=b and external_id=p->>'externalId';if old.external_id is not null then return jsonb_build_object('id',old.message_id,'duplicate',true,'state',old.state);end if;
 st:=case when p->>'kind'='text' then 'accepted' else 'unsupported' end;
 if st='accepted' then
 if length(coalesce(p->>'text','')) not between 1 and 12000 then raise exception 'Bounded chat text required' using errcode='22023';end if;
 insert into chat_message(org_id,channel_id,author_id,body,client_id,created_at) values(current_org(),binding.channel_id,binding.person_id,p->>'text',gen_random_uuid(),(p->>'at')::timestamptz) returning id into mid;
 insert into chat_event(org_id,channel_id) values(current_org(),binding.channel_id);end if;
 insert into pulse_priv.chat_provider_receipt(org_id,binding_id,external_id,message_id,occurred,state) values(current_org(),b,p->>'externalId',mid,(p->>'at')::timestamptz,st);
 update pulse_priv.chat_provider_binding set last_at=now() where id=b;return jsonb_build_object('id',mid,'duplicate',false,'state',st,'durable',true);
end $$;
create function pulse.chat_provider_states() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not chat_active() then raise exception 'Individual staff account required' using errcode='42501';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',id,'channelId',channel_id,'state',case when not active then 'revoked' when last_at is null then 'setup' else 'current' end,'lastAt',last_at,'capabilities',capabilities)) from pulse_priv.chat_provider_binding where org_id=current_org() and chat_has(channel_id)),'[]');
end $$;
revoke all on function pulse.chat_provider_bind(jsonb),pulse.chat_provider_receive(uuid,jsonb),pulse.chat_provider_states() from public;
grant execute on function pulse.chat_provider_bind(jsonb),pulse.chat_provider_receive(uuid,jsonb),pulse.chat_provider_states() to pulse_api;

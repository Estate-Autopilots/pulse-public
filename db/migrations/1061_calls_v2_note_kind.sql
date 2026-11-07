-- migrate:up
-- CALLS-V2 (25 Oct 2026): a note about a call with no kind is refused as invalid (22023, a 400) instead of reaching the
-- insert and its not-null rule (a 500). `k not in (...)` is null when the kind is missing, so 1032's check let it through;
-- SHIP-3 found it with the page matrix and refused it in the API first (ef1a9e66). Same function otherwise.
create or replace function pulse.chat_call_note(p_call uuid,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k text:=p->>'kind'; n int; c chat_call;
 int_of constant text:='^[0-9]{1,9}$';
begin
 if current_viewer() is null or jsonb_typeof(p) is distinct from 'object' or k is null or k not in ('setup','end','failure','reconnect') then raise exception 'invalid note' using errcode='22023'; end if;
 if p_call is not null then
  select * into c from chat_call where org_id=current_org() and id=p_call;
  if not found or not exists(select 1 from chat_call_party where call_id=p_call and person_id=current_viewer()) then raise exception 'call unavailable' using errcode='42501'; end if;
  select count(*) into n from chat_call_quality where org_id=current_org() and call_id=p_call and person_id=current_viewer();
 else
  if k<>'failure' then raise exception 'invalid note' using errcode='22023'; end if;
  select count(*) into n from chat_call_quality where org_id=current_org() and call_id is null and person_id=current_viewer() and at>clock_timestamp()-interval '1 hour';
 end if;
 if n>=40 then return; end if;
 insert into chat_call_quality(org_id,call_id,person_id,kind,role,video,setup_ms,media_ms,path,rtt_ms,jitter_ms,loss_pct,reconnects,restarts,seconds,peers,reason,network,platform,device,relay_offered,relay_gathered)
 values(current_org(),p_call,current_viewer(),k,
  case when p->>'role' in ('caller','callee','joiner') then p->>'role' end,
  case when jsonb_typeof(p->'video')='boolean' then (p->>'video')::boolean end,
  case when p->>'setupMs' ~ int_of then least((p->>'setupMs')::int,600000) end,
  case when p->>'mediaMs' ~ int_of then least((p->>'mediaMs')::int,600000) end,
  case when p->>'path' in ('host','srflx','prflx','relay-udp','relay-tcp','relay-tls','unknown') then p->>'path' end,
  case when p->>'rttMs' ~ int_of then least((p->>'rttMs')::int,60000) end,
  case when p->>'jitterMs' ~ int_of then least((p->>'jitterMs')::int,60000) end,
  case when jsonb_typeof(p->'lossPct')='number' then least(100,greatest(0,round((p->>'lossPct')::numeric,2))) end,
  case when p->>'reconnects' ~ int_of then least((p->>'reconnects')::int,1000) end,
  case when p->>'restarts' ~ int_of then least((p->>'restarts')::int,1000) end,
  case when p->>'seconds' ~ int_of then least((p->>'seconds')::int,86400) end,
  case when p->>'peers' ~ '^[0-8]$' then (p->>'peers')::smallint end,
  case when p->>'reason' ~ '^[a-z][a-z-]{1,30}$' then p->>'reason' end,
  case when p->>'network' ~ '^[a-z0-9-]{1,20}$' then p->>'network' end,
  case when p->>'platform' in ('web','android','ios','desktop') then p->>'platform' end,
  case when p->>'device' in ('phone','tablet','desktop') then p->>'device' end,
  case when jsonb_typeof(p->'relayOffered')='boolean' then (p->>'relayOffered')::boolean end,
  case when jsonb_typeof(p->'relayGathered')='boolean' then (p->>'relayGathered')::boolean end);
 -- A one-to-one call whose media never connected says so in the chat (the note may come before or after the hang-up).
 if k='failure' and p->>'reason'='no-connect' and c.id is not null and c.state='ended' and c.end_reason='completed' then
  perform chat_call_line(c.id); perform chat_call_touch(c.id);
 end if;
 -- Notes are kept 180 days.
 if random()<0.01 then delete from chat_call_quality where org_id=current_org() and at<clock_timestamp()-interval '180 days'; end if;
end $$;

-- migrate:down
-- Forward-only.

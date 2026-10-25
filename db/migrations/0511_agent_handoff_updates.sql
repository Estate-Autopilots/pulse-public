-- migrate:up
-- EST-1473: board work returns to its original conversation; only the filing co-worker writes it.
alter table pulse.agent_handoff
  add column relay_state text check (relay_state in ('started','progress','in_review','blocked','cancelled')),
  add column relay_after timestamptz not null default now(),
  add column relay_reads int not null default 0;
create index agent_handoff_relay on pulse.agent_handoff(org_id,agent_id,filed_at,id)
  where state='filed' and coalesce(relay_state,'') not in ('in_review','cancelled');
create table pulse.agent_handoff_update (
  org_id uuid not null references pulse.org(id),
  client_id uuid not null,
  handoff_id uuid not null references pulse.agent_handoff(id),
  message_id uuid not null unique references pulse.chat_message(id),
  state text not null check (state in ('started','progress','in_review','blocked','cancelled')),
  board_comment_id uuid,
  unique (org_id, handoff_id, board_comment_id),
  primary key (org_id, client_id)
);
alter table pulse.agent_handoff_update enable row level security;
alter table pulse.agent_handoff_update force row level security;
create policy tenant on pulse.agent_handoff_update using (org_id=pulse.current_org()) with check (org_id=pulse.current_org());
grant select on pulse.agent_handoff_update to pulse_api;

create function pulse.agent_handoff_update(p_handoff uuid,p_client uuid,p_state text,p_text text,p_comment uuid default null) returns jsonb
  language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); h agent_handoff; prior agent_handoff_update; mid uuid;
begin
  select * into h from agent_handoff where id=p_handoff and org_id=current_org() and agent_id=me for update;
  if me is null or not found or h.state<>'filed' or not chat_has(h.channel_id)
    or not agent_leader(h.decided_by) or not exists(select 1 from chat_member where channel_id=h.channel_id and person_id=h.decided_by) then
    raise exception 'Choose your own currently authorized filed hand-off' using errcode='42501'; end if;
  p_text := left(trim(p_text),600);
  if p_client is null or p_state is null or p_state not in ('started','progress','in_review','blocked','cancelled') or coalesce(p_text,'')='' then
    raise exception 'Give the update state and text' using errcode='22023'; end if;
  select * into prior from agent_handoff_update where org_id=current_org() and client_id=p_client;
  if found then
    if prior.handoff_id<>h.id or prior.state<>p_state or prior.board_comment_id is distinct from p_comment or not exists(select 1 from chat_message where id=prior.message_id and body=p_text) then
      raise exception 'Update key already used' using errcode='22023'; end if;
    return jsonb_build_object('id',prior.message_id,'state',prior.state,'boardRef',h.board_ref);
  end if;
  -- Status is part of the client UUID, so comment identity must be independently durable across restarts.
  if p_comment is not null then
    select * into prior from agent_handoff_update where org_id=current_org() and handoff_id=h.id and board_comment_id=p_comment;
    if found then return jsonb_build_object('id',prior.message_id,'state',prior.state,'boardRef',h.board_ref); end if;
  end if;
  if h.relay_state in ('in_review','cancelled') then raise exception 'This hand-off has stopped reporting' using errcode='42501'; end if;
  -- chat_send retains membership, quote and notification checks; AI messages never trigger another co-worker.
  if exists(select 1 from chat_message where author_id=me and client_id=p_client) then
    raise exception 'Message key already used' using errcode='22023'; end if;
  mid := chat_send(h.channel_id,p_text,null,'[]',p_client,h.message_id);
  insert into agent_handoff_update(org_id,client_id,handoff_id,message_id,state,board_comment_id)
    values(current_org(),p_client,h.id,mid,p_state,p_comment);
  update agent_handoff set relay_state=p_state,relay_reads=0,relay_after=clock_timestamp()+interval '5 minutes' where id=h.id;
  return jsonb_build_object('id',mid,'state',p_state,'boardRef',h.board_ref);
end $$;

-- Durable admission: at most the oldest 50 open filed hand-offs per co-worker. Claim before reading the board,
-- including after restart/failure. Three unchanged reads back off to 30 minutes; a new update resets to five.
create function pulse.agent_handoffs_poll() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); result jsonb;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  with active as (select id from agent_handoff where org_id=current_org() and agent_id=me and state='filed'
    and coalesce(relay_state,'') not in ('in_review','cancelled') order by filed_at,id limit 50),
  pick as (select h.id from agent_handoff h join active a on a.id=h.id where h.relay_after<=clock_timestamp()
    and chat_has(h.channel_id) and agent_leader(h.decided_by)
    and exists(select 1 from chat_member where channel_id=h.channel_id and person_id=h.decided_by) for update of h skip locked),
  leased as (update agent_handoff h set relay_reads=relay_reads+1,
    relay_after=clock_timestamp()+case when relay_reads+1>=3 then interval '30 minutes' else interval '5 minutes' end
    from pick p where h.id=p.id returning h.*)
  select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'boardRef',h.board_ref,'commentIds',
    (select coalesce(jsonb_agg(u.board_comment_id),'[]') from agent_handoff_update u where u.handoff_id=h.id and u.org_id=current_org() and u.board_comment_id is not null),'names',
    (select coalesce(jsonb_agg(distinct p.display_name),'[]') from person p where p.id in
      (select person_id from chat_member where channel_id=h.channel_id union select author_id from chat_message where channel_id=h.channel_id)))),'[]')
    into result from leased h;
  return result;
end $$;
revoke all on function pulse.agent_handoff_update(uuid,uuid,text,text,uuid),pulse.agent_handoffs_poll() from public;
grant execute on function pulse.agent_handoff_update(uuid,uuid,text,text,uuid),pulse.agent_handoffs_poll() to pulse_api;

-- migrate:down
-- Forward-only: retain reported messages and their hand-off references.

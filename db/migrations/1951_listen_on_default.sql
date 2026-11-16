-- migrate:up
-- FIX-CHAT-AI (owner walkthrough, 10 Nov 2026, item B6: "Turn listening on for the whole company by default: AI
-- employees can follow conversations. Keep the visible notice."). Listening (AGENT-CHANNELS, 1685) was off until an
-- admin opted the company in. Now it is on unless an admin switches it off:
--  * a company with no settings row, and every new company, counts as on;
--  * a company whose row says off is switched on, unless an admin turned listening off themselves (the audit trail
--    holds an update of listen_on for it): that choice stands;
--  * nothing else changes: a person still starts each session, confirms everyone was told, and sees the "Listening"
--    banner with its timer and a one-tap Stop the whole time (the visible notice); transcripts keep the company's
--    retention.
alter table pulse.agent_channel_settings alter column listen_on set default true;

create or replace function pulse.agent_channels_settings() returns jsonb
language plpgsql security definer stable set search_path = pulse, pg_temp as $$
declare s agent_channel_settings; fresh interval := interval '10 minutes';
begin
  if current_viewer() is null then raise exception 'Use your own Vitals account' using errcode = '42501'; end if;
  select * into s from agent_channel_settings where org_id = current_org();
  return jsonb_build_object(
    'canEdit', coalesce(current_setting('pulse.agent_session', true), '') <> 'on' and viewer_is('admin'),
    'telegram', jsonb_build_object('bot', coalesce(s.telegram_bot, 'shared'), 'ownUsername', s.telegram_own_username,
      'running', coalesce(s.telegram_seen_at > clock_timestamp() - fresh, false), 'runningBot', s.telegram_seen_bot),
    'whatsapp', jsonb_build_object('on', coalesce(s.whatsapp_on, false),
      'running', coalesce(s.whatsapp_seen_at > clock_timestamp() - fresh, false), 'number', s.whatsapp_number),
    'listen', jsonb_build_object('on', coalesce(s.listen_on, true), 'retentionDays', coalesce(s.listen_retention_days, 30)));
end $$;

create or replace function pulse.listen_start(p_agent uuid, p_title text, p_purpose text, p_consent boolean) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); s agent_channel_settings; ch uuid; sid uuid;
begin
  if me is null or coalesce(current_setting('pulse.agent_session', true), '') = 'on'
     or not exists (select 1 from person where id = me and org_id = current_org() and status = 'active' and side = 'staff') then
    raise exception 'Use your own Vitals account' using errcode = '42501';
  end if;
  select * into s from agent_channel_settings where org_id = current_org();
  if not coalesce(s.listen_on, true) then raise exception 'Listening is off for this company. An admin can switch it on.' using errcode = '54000'; end if;
  if p_consent is not true then raise exception 'Tell everyone on the call that it is being recorded, then confirm' using errcode = '22023'; end if;
  if coalesce(p_purpose, 'general') not in ('general', 'quotation', 'requirements', 'meeting') then raise exception 'Choose what the call is for' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_title, ''))) not between 1 and 120 then raise exception 'Give the session a short name' using errcode = '22023'; end if;
  if p_agent is not null then
    if not exists (select 1 from agent_member m join person p on p.id = m.person_id
                   where m.org_id = current_org() and m.person_id = p_agent and m.disabled_at is null and p.status = 'active') then
      raise exception 'Choose an active AI employee' using errcode = '22023';
    end if;
    ch := chat_direct(p_agent);
  end if;
  -- One live session per person: starting another stops the earlier one.
  update listen_session set stopped_at = clock_timestamp() where org_id = current_org() and person_id = me and stopped_at is null;
  insert into listen_session (org_id, person_id, agent_id, channel_id, title, purpose, consent_at, purge_after)
  values (current_org(), me, p_agent, ch, btrim(regexp_replace(p_title, '[[:cntrl:]]', ' ', 'g')), coalesce(p_purpose, 'general'), clock_timestamp(),
          clock_timestamp() + make_interval(days => coalesce(s.listen_retention_days, 30)))
  returning id into sid;
  insert into listen_event (org_id, session_id, type, data) values (current_org(), sid, 'listen.started',
    jsonb_build_object('sessionId', sid, 'personId', me, 'agentId', p_agent, 'purpose', coalesce(p_purpose, 'general')));
  return jsonb_build_object('id', sid, 'retentionDays', coalesce(s.listen_retention_days, 30));
end $$;

-- Existing companies: on, unless an admin switched listening off themselves (an audited update of listen_on).
do $$ declare g record; back text := current_setting('pulse.org_id', true); begin
  for g in select id from pulse.org loop
    perform set_config('pulse.org_id', g.id::text, true);
    update pulse.agent_channel_settings s set listen_on = true
     where s.org_id = g.id and not s.listen_on
       and not exists (select 1 from pulse.audit_event a where a.org_id = g.id and a.resource = 'agent_channel_settings'
                         and a.action = 'update' and 'listen_on' = any(a.fields) and a.actor_id is not null);
  end loop;
  perform set_config('pulse.org_id', coalesce(back, ''), true);
end $$;

-- migrate:down
alter table pulse.agent_channel_settings alter column listen_on set default false;

-- migrate:up
-- PULSE-ADMIN (owner, 28 Oct 2026): bug triage inside the admin site. A platform admin opens one organisation's report
-- (BUG-REPORT, 1201) and sets its status and severity or adds a note, as that organisation's own triage does; every look
-- and change is in the platform audit log and the report's own history (actor: Pulse platform admin).

create function pulse.platform_bug(p_org uuid, p_bug uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o org; v jsonb;
begin
  perform platform_guard();
  select * into o from org where id = p_org;
  if not found then raise exception 'Organisation not found' using errcode = 'P0002'; end if;
  perform platform_enter(p_org);
  select jsonb_build_object('id', b.id, 'number', b.number, 'orgId', o.id, 'org', o.name, 'words', b.words, 'status', b.status, 'severity', b.severity,
      'blocksWork', b.blocks_work, 'route', b.route, 'platform', b.platform, 'appVersion', b.app_version,
      'reporter', coalesce(p.display_name, b.reporter_name), 'signedOut', b.signed_out, 'createdAt', b.created_at, 'statusAt', b.status_at,
      'assignee', (select display_name from person a where a.id = b.assignee_id), 'duplicateOf', (select number from reported_bug d where d.id = b.duplicate_of),
      'taskId', b.task_id,
      'errors', (select coalesce(jsonb_agg(left(coalesce(e ->> 'message', e::text), 300)), '[]') from (select e from jsonb_array_elements(b.errors) e limit 8) x),
      'trail', (select coalesce(jsonb_agg(left(coalesce(t ->> 'text', t ->> 'label', t ->> 'path', t::text), 160)), '[]') from (select t from jsonb_array_elements(b.trail) t limit 15) y),
      'files', (select coalesce(jsonb_agg(jsonb_build_object('kind', f.kind, 'bytes', f.bytes, 'seconds', f.seconds)), '[]') from reported_bug_file f where f.report_id = b.id),
      'events', (select coalesce(jsonb_agg(jsonb_build_object('at', ev.at, 'kind', ev.kind, 'value', ev.value, 'note', ev.note,
                   'actor', coalesce((select display_name from person pa where pa.id = ev.actor_id), 'Pulse platform admin')) order by ev.at), '[]')
                 from reported_bug_event ev where ev.report_id = b.id))
    into v from reported_bug b left join person p on p.id = b.person_id where b.id = p_bug and b.org_id = p_org;
  perform platform_leave();
  if v is null then raise exception 'Bug report not found' using errcode = 'P0002'; end if;
  perform platform_log('bug.view', p_org, 'bug', p_bug::text, o.name || ' #' || (v ->> 'number'), null, '{}');
  return v;
end $$;
revoke all on function pulse.platform_bug(uuid, uuid) from public;
grant execute on function pulse.platform_bug(uuid, uuid) to pulse_api;

-- { status?, severity?, note? }: changes what differs and records each change in the report's history.
create function pulse.platform_bug_set(p_org uuid, p_bug uuid, p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o org; b reported_bug; v_status text := nullif(p ->> 'status', ''); v_sev text := p ->> 'severity'; v_note text := nullif(btrim(coalesce(p ->> 'note', '')), '');
  v_changes jsonb := '{}';
begin
  perform platform_guard();
  select * into o from org where id = p_org;
  if not found then raise exception 'Organisation not found' using errcode = 'P0002'; end if;
  if v_status is not null and v_status not in ('new', 'triaged', 'fixing', 'fixed', 'wontfix') then raise exception 'Choose a status' using errcode = '22023'; end if;
  if p ? 'severity' and v_sev is not null and v_sev <> '' and v_sev not in ('blocker', 'high', 'medium', 'low') then raise exception 'Choose a severity' using errcode = '22023'; end if;
  if v_note is not null and length(v_note) > 2000 then raise exception 'A note is at most 2,000 characters' using errcode = '22023'; end if;
  perform platform_enter(p_org);
  select * into b from reported_bug where id = p_bug and org_id = p_org for update;
  if not found then perform platform_leave(); raise exception 'Bug report not found' using errcode = 'P0002'; end if;
  if v_status is not null and v_status <> b.status then
    update reported_bug set status = v_status, status_at = now(), updated_at = now() where id = p_bug;
    insert into reported_bug_event(org_id, report_id, kind, value, note) values (p_org, p_bug, 'status', v_status, v_note);
    v_changes := v_changes || jsonb_build_object('status', jsonb_build_array(b.status, v_status));
  end if;
  if p ? 'severity' and nullif(v_sev, '') is distinct from b.severity then
    update reported_bug set severity = nullif(v_sev, ''), updated_at = now() where id = p_bug;
    insert into reported_bug_event(org_id, report_id, kind, value) values (p_org, p_bug, 'severity', coalesce(nullif(v_sev, ''), 'none'));
    v_changes := v_changes || jsonb_build_object('severity', jsonb_build_array(b.severity, nullif(v_sev, '')));
  end if;
  if v_note is not null and not (v_changes ? 'status') then
    insert into reported_bug_event(org_id, report_id, kind, note) values (p_org, p_bug, 'note', v_note);
    v_changes := v_changes || jsonb_build_object('note', true);
  end if;
  perform platform_leave();
  if v_changes = '{}' then raise exception 'Nothing to change' using errcode = '22023'; end if;
  perform platform_log('bug.triage', p_org, 'bug', p_bug::text, o.name || ' #' || b.number, v_note, v_changes);
  return v_changes;
end $$;
revoke all on function pulse.platform_bug_set(uuid, uuid, jsonb) from public;
grant execute on function pulse.platform_bug_set(uuid, uuid, jsonb) to pulse_api;

-- migrate:down
drop function pulse.platform_bug_set(uuid, uuid, jsonb);
drop function pulse.platform_bug(uuid, uuid);

-- migrate:up
-- Employee self-service HR view: derive the subject exclusively from the authenticated viewer and
-- expose only the §5 employee-visible record, safe change history, document slots, and access log.
-- Keep the private document table inaccessible directly to pulse_api; the security-definer function below
-- can read the viewer's own rows while HR still needs its existing named permission for other people's rows.
do $$ begin
  execute format('drop policy document_reader on pulse_priv.hr_document');
  execute format($policy$create policy document_reader on pulse_priv.hr_document as restrictive for select to %I
    using (pulse.hr_can('hr.documents.read') or person_id = pulse.current_viewer())$policy$, current_user);
end $$;

create function pulse.hr_self_profile() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare
  who uuid := pulse.current_viewer();
  result jsonb;
begin
  if who is null or not exists (
    select 1 from pulse.person p where p.id = who and p.side = 'staff'
  ) then
    raise exception 'personal HR record unavailable' using errcode = '42501';
  end if;

  -- One subject-specific access receipt per section, including reads with no current history or documents.
  perform pulse.hr_log(who, 'hr.profile', 'hr_self_view');
  perform pulse.hr_log(who, 'hr.history', 'hr_self_view');
  perform pulse.hr_log(who, 'hr.documents', 'hr_self_view');
  perform pulse.hr_log(who, 'hr.access_log', 'hr_self_view');

  select jsonb_build_object(
    'employee', jsonb_build_object(
      'name', p.display_name,
      'status', p.status,
      'role', pp.role,
      'department', pp.department,
      'employmentType', pp.employment_type,
      'joinedOn', pp.joined_on
    ),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'field', h.field, 'from', h.old_value, 'to', h.new_value,
        'at', h.changed_at, 'by', actor.display_name
      ) order by h.changed_at desc)
      from pulse.record_change h
      left join pulse.person actor on actor.id = h.changed_by
      where h.org_id = pulse.current_org() and h.entity_type = 'person' and h.entity_id = who
        and h.field = any(array['department', 'employmentType', 'joinedOn', 'role']::text[])
    ), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object('type', d.doc_type, 'seenAt', d.seen_at) order by d.doc_type)
      from pulse_priv.hr_document d
      where d.org_id = pulse.current_org() and d.person_id = who
        and d.doc_type = any(array['appointment_letter', 'joining_letter', 'offer_letter', 'relieving_letter']::text[])
    ), '[]'::jsonb),
    'accessHistory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'at', item.at, 'viewer', coalesce(reader.display_name, 'Pulse system'),
        'resource', item.resource, 'purpose', item.purpose
      ) order by item.at desc)
      from (
        select l.at, l.viewer_id, l.resource, l.purpose
        from privacy.access_log l
        where l.org_id = pulse.current_org() and l.subject_person_id = who and l.resource like 'hr.%'
        order by l.at desc limit 30
      ) item
      left join pulse.person reader on reader.id = item.viewer_id
    ), '[]'::jsonb)
  ) into result
  from pulse.person p
  join pulse.people_profile pp on pp.person_id = p.id
  where p.id = who and p.side = 'staff';

  return result;
end $$;

revoke all on function pulse.hr_self_profile() from public;
grant execute on function pulse.hr_self_profile() to pulse_api;
-- migrate:down
-- Forward-only: preserve the access receipts produced by this endpoint.

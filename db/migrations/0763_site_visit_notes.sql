-- migrate:up
-- EST-2284: narrow read-only customer prefill, including quote identity without granting ERP access.
create function pulse.site_visit_prefill(p_customer uuid) returns jsonb
  language sql stable security definer set search_path=pulse,pg_temp as $$
  select jsonb_build_object('name',c.display_name,'phone',c.phone,
    'siteAddress',null,'systemSizeKw',null,
    'latestQuote',(select jsonb_build_object('id',d.id,'number',d.number) from erp_document d
      where d.org_id=current_org() and d.client_id=c.id and d.doc_type='quotation' and d.number is not null
        and d.status not in ('draft','cancelled') order by d.issued_at desc nulls last,d.created_at desc,d.id desc limit 1),
    'salesperson',(select jsonb_build_object('id',p.id,'name',p.display_name) from person p
      where p.org_id=current_org() and p.id=c.relationship_owner_id))
  from client c where c.org_id=current_org() and c.id=p_customer and site_visit_customer_read(c.id)
$$;
revoke all on function pulse.site_visit_prefill(uuid) from public;
grant execute on function pulse.site_visit_prefill(uuid) to pulse_api;

-- Contract 1.0.3: owner means leadership. HR still needs admin to enter staff work.
create function pulse.site_visit_privileged() returns boolean
  language sql stable set search_path=pulse,pg_temp as $$ select viewer_is('admin','leadership') $$;
revoke all on function pulse.site_visit_privileged() from public;
grant execute on function pulse.site_visit_privileged() to pulse_api;
drop policy editor_read on pulse.site_visit_history;
create policy editor_read on pulse.site_visit_history as restrictive for select to pulse_api
  using(exists(select 1 from pulse.site_visit v where v.org_id=site_visit_history.org_id and v.id=visit_id
    and (pulse.site_visit_privileged() or (v.status='open' and v.assigned_person_id=pulse.current_viewer()))));

-- Private implementation: wrappers fix the field/visit distinction and confer only execute access.
create function pulse.site_visit_note_save(p_visit uuid,p_field text,p_notes text) returns void
  language plpgsql set search_path=pulse,pg_temp as $$
declare v site_visit; previous text;
begin
  if not exists(select 1 from person where org_id=current_org() and id=current_viewer() and side='staff' and status='active')
     or (viewer_is('hr') and not viewer_is('admin')) then
    raise exception 'Visit edit permission required' using errcode='42501';
  end if;
  select * into v from site_visit where org_id=current_org() and id=p_visit for update;
  if not found or not (site_visit_privileged() or (v.status='open' and v.assigned_person_id=current_viewer())) then
    raise exception 'Visit edit permission required' using errcode='42501';
  end if;
  if p_notes is null or char_length(p_notes)>(case when p_field is null then 4000 else 2000 end) then
    raise exception 'Check the site-visit notes length' using errcode='22023';
  end if;
  if p_field is null then previous:=v.notes;
  else
    if not exists(select 1 from jsonb_array_elements(v.starting_fields) f where f->>'key'=p_field) then
      raise exception 'Choose a starting visit field' using errcode='22023';
    end if;
    select notes into previous from site_visit_field_note where org_id=v.org_id and visit_id=v.id and field_key=p_field;
    previous:=coalesce(previous,'');
  end if;
  if previous=p_notes then return; end if;
  if p_field is null then update site_visit set notes=p_notes where org_id=v.org_id and id=v.id;
  else
    insert into site_visit_field_note(org_id,visit_id,field_key,notes) values(v.org_id,v.id,p_field,p_notes)
      on conflict(org_id,visit_id,field_key) do update set notes=excluded.notes;
  end if;
  insert into site_visit_history(org_id,visit_id,actor_id,action,field_key,from_value,to_value)
    values(v.org_id,v.id,current_viewer(),case when v.status='submitted' then 'visit_edited_after_submit'
      when p_field is null then 'visit_notes_changed' else 'field_notes_changed' end,p_field,previous,p_notes);
end $$;
revoke all on function pulse.site_visit_note_save(uuid,text,text) from public;
create function pulse.site_visit_notes_save(p_visit uuid,p_notes text) returns void
  language sql security definer set search_path=pulse,pg_temp as $$ select site_visit_note_save(p_visit,null,p_notes) $$;
create function pulse.site_visit_field_note_save(p_visit uuid,p_field text,p_notes text) returns void
  language sql security definer set search_path=pulse,pg_temp as $$ select site_visit_note_save(p_visit,coalesce(p_field,''),p_notes) $$;
revoke all on function pulse.site_visit_notes_save(uuid,text),pulse.site_visit_field_note_save(uuid,text,text) from public;
grant execute on function pulse.site_visit_notes_save(uuid,text),pulse.site_visit_field_note_save(uuid,text,text) to pulse_api;
-- migrate:down
-- Forward-only: retain note/history custody.

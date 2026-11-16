-- migrate:up
-- Anyone with their own sign-in can suggest a correction to a project, client or contact. Only admins edit those
-- records, so a suggestion lands in Review data (kind 'correction') with who sent it; an admin applies it on the
-- record and marks it done or dismisses it. The review queue stays admin/HR/leadership-writable under RLS: this
-- function is the only way in for everyone else, and it accepts nothing but a bounded, plain-text suggestion.
create function pulse.suggest_correction(p_entity text, p_id uuid, p_field text, p_value text, p_note text) returns uuid
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare who uuid := current_viewer(); who_name text; label text; result uuid;
begin
 select display_name into who_name from person where id = who and side = 'staff' and status = 'active';
 if who_name is null then raise exception 'Sign in with your own account to suggest a correction' using errcode = '42501'; end if;
 if p_entity not in ('project', 'client', 'contact') then raise exception 'Choose a project, client or contact' using errcode = '22023'; end if;
 if p_field not in ('title', 'client', 'location', 'pod', 'pgs', 'status', 'segment', 'contact', 'type', 'name', 'phone', 'email', 'other') then
  raise exception 'Choose what is wrong' using errcode = '22023'; end if;
 if coalesce(btrim(p_value), '') = '' and coalesce(btrim(p_note), '') = '' then raise exception 'Say what the right value is, or describe the problem' using errcode = '22023'; end if;
 if length(coalesce(p_value, '')) > 300 or length(coalesce(p_note, '')) > 1000 then raise exception 'Keep the suggestion short' using errcode = '22023'; end if;
 if p_entity = 'project' then select coalesce(title, name) into label from project where id = p_id;
 elsif p_entity = 'client' then select display_name into label from client where id = p_id;
 else select p.display_name into label from person p join contact_profile c on c.person_id = p.id where p.id = p_id; end if;
 if label is null then raise exception 'Record not found' using errcode = 'P0002'; end if;
 if (select count(*) from review_item where kind = 'correction' and status = 'pending' and proposed->>'byId' = who::text) >= 50 then
  raise exception 'You have 50 suggestions waiting; an admin needs to work through them first' using errcode = '54000'; end if;
 insert into review_item(org_id, source_key, kind, entity_type, entity_id, title, proposed, evidence)
 values (current_org(), 'suggestion:' || gen_random_uuid(), 'correction', p_entity, p_id, label,
  jsonb_build_object('field', p_field, 'value', nullif(btrim(p_value), ''), 'note', nullif(btrim(p_note), ''), 'byId', who, 'by', who_name),
  jsonb_build_object('suggestedBy', who_name, 'at', now()))
 returning id into result;
 perform audit_write('suggest_correction', p_entity, p_id::text);
 return result;
end $$;
revoke all on function pulse.suggest_correction(text, uuid, text, text, text) from public;
grant execute on function pulse.suggest_correction(text, uuid, text, text, text) to pulse_api;
-- migrate:down

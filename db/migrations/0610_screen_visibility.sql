-- migrate:up
-- EST-1419 (Willow Lane hand-off #3 item 8; Atlas Crest asked for the same simpler menu): an organisation hides
-- single screens and their menu entries per role. One row per organisation holds the choice the API validated
-- (services/api/src/screens.ts: {newScreensHidden, known, hidden: {<role>: [screen keys]}}). Hiding is a visibility
-- state only: no permission, policy or row changes, and every route answers as before. Dashboard, Chats, My desk and
-- the HR desk always stay visible (owner, 18 Oct), so the database refuses them too. Only an organisation admin
-- writes; each change is in pulse.record_change and the audit trail.

create table pulse.org_screen_view (
  org_id      uuid primary key references pulse.org(id),
  body        jsonb not null check (jsonb_typeof(body) = 'object'),
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);
alter table pulse.org_screen_view enable row level security;
alter table pulse.org_screen_view force row level security;
create policy tenant on pulse.org_screen_view using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.org_screen_view to pulse_api, pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse.org_screen_view for each row execute function pulse.audit_mutation();

-- No row means nothing is hidden: every company keeps today's menu until an admin chooses otherwise.
create function pulse.org_screen_view_get() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select body from org_screen_view where org_id = current_org()), '{}'::jsonb)
$$;
revoke all on function pulse.org_screen_view_get() from public;
grant execute on function pulse.org_screen_view_get() to pulse_api, pulse_worker;

create function pulse.org_screen_view_set(p_body jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_before jsonb;
begin
  if not viewer_is('admin') or current_viewer() is null then
    raise exception 'An organisation admin chooses the screens each role sees' using errcode = '42501';
  end if;
  if p_body is null or jsonb_typeof(p_body) <> 'object' or jsonb_typeof(coalesce(p_body -> 'hidden', '{}'::jsonb)) <> 'object' then
    raise exception 'Send the screen choices as one object' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_each(coalesce(p_body -> 'hidden', '{}'::jsonb)) r
             cross join lateral jsonb_array_elements_text(case when jsonb_typeof(r.value) = 'array' then r.value else '[]'::jsonb end) k
             where k in ('dashboard', 'chats', 'me', 'hr')) then
    raise exception 'Dashboard, Chats, My desk and the HR desk always stay visible' using errcode = '22023';
  end if;
  v_before := org_screen_view_get();
  if v_before = p_body then return p_body; end if;
  insert into org_screen_view(org_id, body, updated_by) values (current_org(), p_body, current_viewer())
  on conflict (org_id) do update set body = excluded.body, updated_by = excluded.updated_by, updated_at = now();
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (current_org(), 'org', current_org(), 'screens', v_before::text, p_body::text, current_viewer());
  return p_body;
end $$;
revoke all on function pulse.org_screen_view_set(jsonb) from public;
grant execute on function pulse.org_screen_view_set(jsonb) to pulse_api;

-- migrate:down
-- Forward-only. Clearing a company's row shows every screen again.

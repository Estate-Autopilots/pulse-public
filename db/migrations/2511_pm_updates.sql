-- migrate:up
-- PM-BUILD-3 (22 Nov 2026; the Mac's screen 13, SPEC v1.1 §1.10 and rule 11): a project's weekly update. No new table: a
-- project comment of kind 'update' (work_comment, 0144), with what the lead picked as the health, what the system said,
-- the reason when the lead says it is better than the system does, and the week it is for (work_comment.meta).
--  * pulse.project_update_post: only a person posts (an AI employee, a connected AI app or an automation only drafts),
--    and only who runs the project (its lead, its manager, leadership: pulse.project_can_run). The lead may call it worse
--    than the system freely; better only with a written reason, kept beside the system's word.
--  * pulse.project_updates_last: the newest update per project, for the Projects list ("Updated today", "Update missing").

alter table pulse.work_comment drop constraint work_comment_kind_check,
  add constraint work_comment_kind_check check (kind = any (array['comment', 'help', 'update']));
alter table pulse.work_comment add column meta jsonb,
  add constraint work_comment_meta check (meta is null or (jsonb_typeof(meta) = 'object' and pg_column_size(meta) < 2000));
comment on column pulse.work_comment.meta is 'PM-BUILD-3 (2511): a weekly update''s health (picked and the system''s), the reason when it is better, and its week';

create function pulse.project_update_post(p_project uuid, p_body text, p_health text, p_system text, p_reason text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); body text := btrim(coalesce(p_body, '')); why text := nullif(btrim(coalesce(p_reason, '')), ''); new_id uuid;
  rank constant text[] := array['late', 'at_risk', 'waiting_client', 'needs_setup', 'not_started', 'on_track', 'paused', 'done'];
begin
  if not pulse.plan_by_person() then raise exception 'Only a person posts a project''s update; an AI employee only drafts it' using errcode = '42501'; end if;
  if not exists(select 1 from pulse.project pr where pr.org_id = pulse.current_org() and pr.id = p_project and pr.deleted_at is null) then raise exception 'Project not found' using errcode = 'P0002'; end if;
  if not pulse.project_can_run(p_project) then raise exception 'Only the project''s lead, its manager and leadership post its update' using errcode = '42501'; end if;
  if length(body) < 3 then raise exception 'Write what happened this week' using errcode = '22023'; end if;
  if length(body) > 3500 then raise exception 'Keep the update under 3,500 letters' using errcode = '22023'; end if;
  if not p_health = any(rank) then raise exception 'Choose how the project is doing' using errcode = '22023'; end if;
  if p_system is not null and not p_system = any(rank) then p_system := null; end if;
  if p_system is not null and array_position(rank, p_health) > array_position(rank, p_system) and why is null then
    raise exception 'Say why it is better than the system says' using errcode = '22023'; end if;
  if why is not null and length(why) > 300 then raise exception 'Keep the reason under 300 letters' using errcode = '22023'; end if;
  insert into pulse.work_comment(org_id, project_id, author_id, body, kind, meta)
    values (pulse.current_org(), p_project, me, body, 'update', jsonb_strip_nulls(jsonb_build_object('health', p_health, 'system', p_system, 'reason', why,
      'week', to_char((now() at time zone pulse.org_time_zone())::date, 'IYYY-"W"IW'))))
    returning work_comment.id into new_id;
  perform pulse.audit_write('project_update_post', 'project', p_project::text);
  return new_id;
end $$;
revoke all on function pulse.project_update_post(uuid, text, text, text, text) from public;
grant execute on function pulse.project_update_post(uuid, text, text, text, text) to pulse_api;

-- The newest update of each of these projects (who, when, the health picked): only when, by whom and the health word,
-- never the text, and not for a project hidden from the viewer (pulse.project_hidden_ids).
create function pulse.project_updates_last(p_projects uuid[]) returns table(project_id uuid, at timestamptz, by_name text, health text)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select distinct on (c.project_id) c.project_id, c.created_at, (select display_name from pulse.person where id = c.author_id), c.meta->>'health'
    from pulse.work_comment c
   where c.org_id = pulse.current_org() and c.project_id = any(p_projects) and c.kind = 'update' and c.removed_at is null
     and exists(select 1 from pulse.project p where p.id = c.project_id and p.org_id = c.org_id and p.deleted_at is null)
     and not c.project_id = any(coalesce(pulse.project_hidden_ids(), '{}'::uuid[]))
   order by c.project_id, c.created_at desc
$$;
revoke all on function pulse.project_updates_last(uuid[]) from public;
grant execute on function pulse.project_updates_last(uuid[]) to pulse_api;

-- migrate:down
drop function if exists pulse.project_updates_last(uuid[]);
drop function if exists pulse.project_update_post(uuid, text, text, text, text);
alter table pulse.work_comment drop constraint if exists work_comment_meta;
alter table pulse.work_comment drop column if exists meta;
alter table pulse.work_comment drop constraint work_comment_kind_check, add constraint work_comment_kind_check check (kind = any (array['comment', 'help']));

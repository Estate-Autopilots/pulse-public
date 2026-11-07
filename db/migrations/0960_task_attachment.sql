-- migrate:up
-- READY (Datup, Atlas Crest, 21 Oct 2026: "There is no option to attach something while creating task"): files and
-- links that come WITH a task (the brief, a reference, a screenshot), separate from proof. Proof means "done" (it can
-- auto-accept under the auto_proof policy and is what requires_proof checks), so a brief must never count as proof:
-- attachments live in their own table and no proof rule reads it. The bytes go where proof files go
-- (pulse_priv.work_file, no document store connected). Who may attach or remove: whoever may change the task
-- (task_for_edit); who may open: whoever sees the task. Additive and safe on a live install (one table, three functions).
-- Uses only functions defined in repo migrations: task_require_viewer, task_for_edit, task_visible (0141), current_org.

create table pulse.task_attachment (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 task_id uuid not null references pulse.task(id),
 kind text not null check (kind in ('link','file')),
 label text not null check (length(label) between 1 and 200),
 url text check (url ~ '^https?://[^\s]+$' and length(url) <= 2000),
 file_id uuid references pulse_priv.work_file(id),
 added_by uuid references pulse.person(id),
 added_at timestamptz not null default now(),
 removed_at timestamptz,
 removed_by uuid references pulse.person(id),
 check ((kind = 'link' and url is not null) or (kind = 'file' and file_id is not null))
);
create index task_attachment_task on pulse.task_attachment(org_id, task_id) where removed_at is null;
alter table pulse.task_attachment enable row level security;
alter table pulse.task_attachment force row level security;
create policy tenant on pulse.task_attachment using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy visible on pulse.task_attachment as restrictive for select to pulse_api using (pulse.task_visible(task_id));
grant select on pulse.task_attachment to pulse_api;
grant select, insert, update on pulse.task_attachment to pulse_worker;
create trigger audit_mutation after insert or update on pulse.task_attachment for each row execute function pulse.audit_mutation();

create function pulse.task_attachment_add(p_task uuid, p_label text, p_url text, p_bytes bytea default null, p_name text default null, p_mime text default null) returns uuid
 language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := task_require_viewer(); t task; fid uuid; aid uuid;
begin
 t := task_for_edit(p_task);
 if (select count(*) from task_attachment where org_id = current_org() and task_id = p_task and removed_at is null) >= 20 then
  raise exception 'A task keeps up to 20 attachments; link a Drive folder for more' using errcode = '22023';
 end if;
 if p_bytes is not null then
  if octet_length(p_bytes) > 8388608 then raise exception 'Attach files up to 5 MB, or link a Drive file' using errcode = '22023'; end if;
  if coalesce(p_mime, '') !~ '^(application/pdf|image/(png|jpeg|webp|gif)|text/(plain|csv)|application/(zip|vnd\.openxmlformats-officedocument\.[a-z.]+))$' then
   raise exception 'Attach a PDF, image, text, spreadsheet, document or zip file' using errcode = '22023';
  end if;
  insert into pulse_priv.work_file(org_id, task_id, name, mime, bytes, sha256, added_by)
   values (current_org(), p_task, left(coalesce(nullif(btrim(p_name), ''), 'attachment'), 200), p_mime, p_bytes, encode(sha256(p_bytes), 'hex'), me) returning id into fid;
  insert into task_attachment(org_id, task_id, kind, label, file_id, added_by)
   values (current_org(), p_task, 'file', left(coalesce(nullif(btrim(p_label), ''), nullif(btrim(p_name), ''), 'File'), 200), fid, me) returning id into aid;
 else
  if coalesce(p_url, '') !~ '^https?://[^\s]+$' or length(p_url) > 2000 then raise exception 'Paste a full link starting with https://' using errcode = '22023'; end if;
  insert into task_attachment(org_id, task_id, kind, label, url, added_by)
   values (current_org(), p_task, 'link', left(coalesce(nullif(btrim(p_label), ''), regexp_replace(p_url, '^https?://([^/]+).*$', '\1')), 200), p_url, me) returning id into aid;
 end if;
 return aid;
end $$;

create function pulse.task_attachment_remove(p_id uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := task_require_viewer(); tid uuid;
begin
 select task_id into tid from task_attachment where org_id = current_org() and id = p_id and removed_at is null;
 if tid is null then raise exception 'Attachment not found' using errcode = 'P0002'; end if;
 perform task_for_edit(tid);
 update task_attachment set removed_at = now(), removed_by = me where id = p_id;
end $$;

create function pulse.task_attachment_read(p_id uuid) returns table(name text, mime text, bytes bytea) language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a task_attachment;
begin
 select * into a from task_attachment where org_id = current_org() and id = p_id and removed_at is null;
 if not found or not task_visible(a.task_id) then raise exception 'Attachment not found' using errcode = 'P0002'; end if;
 if a.kind <> 'file' then raise exception 'This attachment is a link' using errcode = '22023'; end if;
 return query select f.name, f.mime, f.bytes from pulse_priv.work_file f where f.id = a.file_id;
end $$;

revoke all on function pulse.task_attachment_add(uuid, text, text, bytea, text, text), pulse.task_attachment_remove(uuid), pulse.task_attachment_read(uuid) from public;
grant execute on function pulse.task_attachment_add(uuid, text, text, bytea, text, text), pulse.task_attachment_remove(uuid), pulse.task_attachment_read(uuid) to pulse_api;

-- migrate:down
-- Forward-only: attachments are company records and are never dropped.

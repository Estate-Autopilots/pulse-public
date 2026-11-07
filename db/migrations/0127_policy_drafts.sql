-- migrate:up
-- Policy drafts (HR desk → Policies, 9 Oct 2026). The latest version of a policy may be a draft that HR keeps editing:
-- the editor autosaves into it in place, and `revision` counts those saves so two editors never overwrite each other
-- silently. Publish turns exactly the revision HR reviewed into the published version. Published versions stay
-- immutable; employees still read and acknowledge only published versions (row security from 0029 is unchanged).
alter table pulse.policy_document
 add column revision int not null default 1 check(revision>0),
 add column updated_at timestamptz,
 add column updated_by uuid references pulse.person(id),
 add column published_at timestamptz,
 add column published_by uuid references pulse.person(id);

create function pulse.policy_document_guard() returns trigger language plpgsql set search_path=pulse,pg_temp as $$
begin
 if old.status='published' then raise exception 'published policy versions are immutable' using errcode='42501'; end if;
 if (new.org_id,new.id,new.kind,new.version,new.created_at) is distinct from (old.org_id,old.id,old.kind,old.version,old.created_at)
  or new.created_by is distinct from old.created_by then
  raise exception 'a policy version keeps its kind, number and author' using errcode='42501';
 end if;
 return new;
end $$;
create trigger policy_document_guard before update on pulse.policy_document for each row execute function pulse.policy_document_guard();

-- Save HR's text as the draft: into the latest version when that is a draft, otherwise as the next version.
-- p_version is the version the editor opened, p_revision the draft revision it last saw.
create function pulse.policy_draft_save(p_kind text,p_title text,p_body text,p_version int,p_revision int) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare latest policy_document; saved policy_document;
begin
 if not viewer_is('admin','hr','leadership') or current_viewer() is null then raise exception 'denied' using errcode='42501'; end if;
 if p_kind is null or p_version is null or length(coalesce(p_body,'')) not between 10 and 30000 or length(coalesce(p_title,'')) not between 2 and 100 then
  raise exception 'invalid policy' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtext(current_org()::text||p_kind));
 select * into latest from policy_document where kind=p_kind order by version desc limit 1;
 if coalesce(latest.version,0)<>p_version then raise exception 'document changed; refresh before editing' using errcode='40001'; end if;
 if latest.status='draft' then
  if latest.revision is distinct from p_revision then raise exception 'draft changed; refresh before editing' using errcode='40001'; end if;
  if latest.title=p_title and latest.body=p_body then saved:=latest;
  else update policy_document set title=p_title,body=p_body,revision=revision+1,updated_at=now(),updated_by=current_viewer() where id=latest.id returning * into saved;
  end if;
 else
  insert into policy_document(org_id,kind,version,title,body,status,created_by)
  values(current_org(),p_kind,coalesce(latest.version,0)+1,p_title,p_body,'draft',current_viewer()) returning * into saved;
 end if;
 return jsonb_build_object('id',saved.id,'version',saved.version,'revision',saved.revision,'savedAt',coalesce(saved.updated_at,saved.created_at));
end $$;

-- Publish the draft HR reviewed: it must still be the latest version at the revision on screen.
create function pulse.policy_publish(p_document uuid,p_revision int) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d policy_document;
begin
 if not viewer_is('admin','hr','leadership') or current_viewer() is null then raise exception 'denied' using errcode='42501'; end if;
 select * into d from policy_document where id=p_document;
 if not found then raise exception 'choose a policy draft' using errcode='P0002'; end if;
 perform pg_advisory_xact_lock(hashtext(current_org()::text||d.kind));
 select * into d from policy_document where id=p_document;
 if d.status<>'draft' then raise exception 'this version is already published' using errcode='40001'; end if;
 if d.revision is distinct from p_revision or exists(select 1 from policy_document n where n.kind=d.kind and n.version>d.version) then
  raise exception 'document changed; refresh before publishing' using errcode='40001';
 end if;
 update policy_document set status='published',published_at=now(),published_by=current_viewer() where id=d.id returning * into d;
 return jsonb_build_object('id',d.id,'version',d.version,'publishedAt',d.published_at);
end $$;

revoke all on function pulse.policy_document_guard(),pulse.policy_draft_save(text,text,text,int,int),pulse.policy_publish(uuid,int) from public;
grant execute on function pulse.policy_draft_save(text,text,text,int,int),pulse.policy_publish(uuid,int) to pulse_api;
-- migrate:down
drop function if exists pulse.policy_publish(uuid,int);
drop function if exists pulse.policy_draft_save(text,text,text,int,int);
drop trigger if exists policy_document_guard on pulse.policy_document;
drop function if exists pulse.policy_document_guard();
alter table pulse.policy_document drop column if exists published_by,drop column if exists published_at,drop column if exists updated_by,drop column if exists updated_at,drop column if exists revision;

-- migrate:up
-- EST-2549: HQ mutations join the existing tenant-scoped, metadata-first audit trail.
-- Keep 0030's guards and safe fields; add only HQ feature diffs and natural resource keys.
create or replace function pulse.audit_mutation() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j jsonb; oldj jsonb; cols text[]; rid text; safe text[]:='{}'; diffs jsonb:='{}'; k text;
begin
 j:=case when TG_OP='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 if j->>'org_id' is distinct from current_org()::text then return null; end if;
 oldj:=case when TG_OP in ('UPDATE','DELETE') then to_jsonb(old) else '{}'::jsonb end;
 select array_agg(key) into cols from jsonb_object_keys(j) key where TG_OP<>'UPDATE' or j->key is distinct from oldj->key;
 if cols is null then return null; end if;
 if TG_TABLE_SCHEMA='pulse' then
  safe:=case TG_TABLE_NAME when 'project' then array['title','name','status','unit_id','lead_person_id','client_id']
    when 'task' then array['title','status','owner_id','project_id','due_label'] when 'person' then array['display_name','status']
    when 'client' then array['display_name','status'] when 'people_profile' then array['role','pod','department','manager_id']
    when 'unit' then array['name','kind'] when 'policy_document' then array['kind','title','version','status']
    when 'hq_feature' then array['name','category','status','draft','archived'] else '{}' end;
 end if;
 foreach k in array cols loop
  if k=any(safe) then diffs:=diffs||jsonb_build_object(k,jsonb_build_object('before',oldj->k,'after',case when TG_OP='DELETE' then null else j->k end));end if;
 end loop;
 rid:=coalesce(j->>'id',j->>'person_id',j->>'file_id',j->>'source_key',j->>'day',
  case TG_TABLE_NAME when 'tenant_config' then (j->>'doc_kind')||'/'||(j->>'doc_key') when 'hq_brand' then j->>'org_id' when 'hq_category' then j->>'key' end);
 insert into audit_event(org_id,actor_id,actor_account,action,resource,resource_id,fields,source,changes)
 values(current_org(),current_viewer(),nullif(current_setting('pulse.actor_account',true),''),lower(TG_OP),TG_TABLE_NAME,rid,cols,case when current_viewer() is null then 'sync' else 'pulse' end,diffs);
 return null;
end $$;

do $$
declare t text;
begin
 foreach t in array array['hq_feature','hq_offer','hq_idea','hq_idea_vote','hq_brand','hq_brand_version'] loop
  if not exists(select 1 from pg_trigger where tgrelid=format('pulse.%I',t)::regclass
    and tgfoid='pulse.audit_mutation()'::regprocedure and not tgisinternal) then
   execute format('create trigger audit_mutation after insert or update or delete on pulse.%I for each row execute function pulse.audit_mutation()',t);
  end if;
 end loop;
end $$;

-- migrate:down
-- Forward-only: retain the audit trail and its triggers.

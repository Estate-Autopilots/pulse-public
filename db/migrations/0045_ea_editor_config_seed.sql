-- migrate:up
-- Repeatable EA editor-week seed. Contains taxonomy and placeholder targets only, no person data.
-- Applied with migration 0045; to rerun explicitly, use the staging migration connection:
--   PGOPTIONS='-c role=pulse_staging_owner' psql "$PULSE_DATABASE_URL_MIGRATE" -X -v ON_ERROR_STOP=1 -f db/seeds/ea_editor_config.sql

do $seed$
declare
  v_org uuid;
  v_target_body jsonb := $json${
    "editors": {
      "model_video": {"per_week": 4, "placeholder": true},
      "vov": {"per_week": 3, "placeholder": true},
      "founder_video": {"per_week": 1, "placeholder": true},
      "testimonial": {"per_week": 1, "placeholder": true},
      "walkthrough": {"per_week": 1, "placeholder": true},
      "other": {"per_week": null, "placeholder": true}
    }
  }$json$::jsonb;
  v_target_current jsonb;
  v_rules jsonb := $json${
    "folder_path": [
      {"match": "model\\s+final\\s+videos?(\\s+and(?:\\s+its)?\\s+hooks?)?|final\\s+videos?(?:\\s+and\\s+hooks?)?", "type": "model_video"},
      {"match": "vovs?(?:\\s+and\\s+designs?)?", "type": "vov"},
      {"match": "cp\\s+videos?", "type": "vov"},
      {"match": "founders?\\s+videos?", "type": "founder_video"},
      {"match": "client\\s+testimonials?", "type": "testimonial"},
      {"match": "walkthroughs?|walk\\s+throughs?", "type": "walkthrough"}
    ],
    "file_name": [
      {"match": "\\bmodel(?:[-\\s]led)?\\s+videos?\\b", "type": "model_video"},
      {"match": "\\bvovs?\\b", "type": "vov"},
      {"match": "\\bcp[-\\s]+videos?\\b", "type": "vov"},
      {"match": "\\bfounders?[-\\s]+videos?\\b", "type": "founder_video"},
      {"match": "\\btestimonials?\\b", "type": "testimonial"},
      {"match": "\\bwalk[\\s-]*throughs?\\b", "type": "walkthrough"}
    ],
    "parsed_type_codes": {
      "MV": "model_video", "HK": "model_video", "VV": "vov", "CP": "vov",
      "FV": "founder_video", "TS": "testimonial", "WT": "walkthrough"
    }
  }$json$::jsonb;
  v_hints jsonb := $json${
    "hook\\s*\\d": "HK", "vov": "VV", "model": "MV", "\\bCP\\d{0,3}\\b": "CP",
    "walk\\s*through": "WT", "founder": "FV", "testimonial": "TS"
  }$json$::jsonb;
  v_version integer;
  v_folder_key text;
  v_folder_current jsonb;
  v_folder_next jsonb;
  v_nested jsonb;
  v_file_name jsonb;
  v_changed boolean := false;
begin
  perform pg_advisory_xact_lock(hashtextextended('pulse:ea-editor-config-seed', 0));
  select id into v_org from pulse.org where code = 'EA' and status = 'active';
  if v_org is null then
    raise notice 'Skipping EA editor config seed because no active EA organization exists';
    return;
  end if;
  perform set_config('pulse.org_id', v_org::text, true);

  select body into v_target_current from pulse.tenant_config
    where org_id = v_org and doc_kind = 'targets' and doc_key = 'editors' and is_active for update;
  if not found or v_target_current is distinct from v_target_body then
    update pulse.tenant_config set is_active = false
      where org_id = v_org and doc_kind = 'targets' and doc_key = 'editors' and is_active;
    select coalesce(max(version), 0) + 1 into v_version from pulse.tenant_config
      where org_id = v_org and doc_kind = 'targets' and doc_key = 'editors';
    insert into pulse.tenant_config(org_id, doc_kind, doc_key, version, body, is_active)
      values (v_org, 'targets', 'editors', v_version, v_target_body, true);
    insert into pulse.event(org_id,id,source,type,time,subject,actor,actor_kind,purpose,sensitivity,visibility,data)
      values (v_org, 'ea-editor-targets-v' || v_version, '/system/pulse-migration', 'config.changed', now(),
        'config:pulse:targets/editors', 'system:pulse:db-migration', 'system', array['delivery'], 0, 'org',
        jsonb_build_object('version',v_version,'changed_by_ref','system:pulse:db-migration'));
    v_changed := true;
  end if;

  select doc_key, body into v_folder_key, v_folder_current from pulse.tenant_config
    where org_id = v_org and doc_kind = 'folder_rules' and is_active
    order by doc_key limit 1 for update;
  if not found then
    v_folder_key := 'editor_creative_types';
    v_folder_current := '{}'::jsonb;
  end if;

  if jsonb_typeof(v_folder_current -> 'folder_rules') = 'object' then
    v_nested := v_folder_current -> 'folder_rules';
    v_nested := jsonb_set(v_nested, '{creative_type_rules}', v_rules, true);
    v_file_name := case when jsonb_typeof(v_nested -> 'file_name') = 'object'
      then v_nested -> 'file_name' else '{}'::jsonb end;
    v_file_name := jsonb_set(v_file_name, '{legacy_type_hints}',
      coalesce(v_file_name -> 'legacy_type_hints', '{}'::jsonb) || v_hints, true);
    v_nested := jsonb_set(v_nested, '{file_name}', v_file_name, true);
    v_folder_next := jsonb_set(v_folder_current, '{folder_rules}', v_nested, true);
  else
    v_folder_next := jsonb_set(v_folder_current, '{creative_type_rules}', v_rules, true);
    v_file_name := case when jsonb_typeof(v_folder_next -> 'file_name') = 'object'
      then v_folder_next -> 'file_name' else '{}'::jsonb end;
    v_file_name := jsonb_set(v_file_name, '{legacy_type_hints}',
      coalesce(v_file_name -> 'legacy_type_hints', '{}'::jsonb) || v_hints, true);
    v_folder_next := jsonb_set(v_folder_next, '{file_name}', v_file_name, true);
  end if;

  if v_folder_current is distinct from v_folder_next then
    update pulse.tenant_config set is_active = false
      where org_id = v_org and doc_kind = 'folder_rules' and doc_key = v_folder_key and is_active;
    select coalesce(max(version), 0) + 1 into v_version from pulse.tenant_config
      where org_id = v_org and doc_kind = 'folder_rules' and doc_key = v_folder_key;
    insert into pulse.tenant_config(org_id, doc_kind, doc_key, version, body, is_active)
      values (v_org, 'folder_rules', v_folder_key, v_version, v_folder_next, true);
    insert into pulse.event(org_id,id,source,type,time,subject,actor,actor_kind,purpose,sensitivity,visibility,data)
      values (v_org, 'ea-editor-folder-rules-' || v_folder_key || '-v' || v_version,
        '/system/pulse-migration', 'config.changed', now(), 'config:pulse:folder_rules/' || v_folder_key,
        'system:pulse:db-migration', 'system', array['delivery'], 0, 'org',
        jsonb_build_object('version',v_version,'changed_by_ref','system:pulse:db-migration'));
    v_changed := true;
  end if;
  if v_changed then perform pg_notify('pulse_events', v_org::text); end if;
end
$seed$;

-- migrate:down
-- Tenant configuration is durable seed data and is retained by rollback.

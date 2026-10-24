-- migrate:up
-- Seed the EA designer benchmark shape with explicitly unbenchmarked values.
do $seed$
declare
  v_org uuid;
  v_body jsonb := $json${
    "designers": {
      "roles": ["Graphic Designer"],
      "single_image": {"per_day": 2, "placeholder": true}
    },
    "windows": {
      "logo": {"days": {"min": 3, "max": 7}, "placeholder": true},
      "colour_palette": {"days": {"min": 1, "max": 3}, "placeholder": true},
      "brochure": {"days": {"min": 3, "max": 7}, "placeholder": true},
      "pitch_deck": {"days": {"min": 2, "max": 5}, "placeholder": true},
      "brand_identity": {"days": {"min": 7, "max": 15}, "placeholder": true}
    }
  }$json$::jsonb;
  v_current jsonb;
  v_version integer;
begin
  select id into v_org from pulse.org where code='EA' and status='active';
  if v_org is null then
    raise notice 'Skipping EA designer target seed because no active EA organization exists';
    return;
  end if;
  perform set_config('pulse.org_id',v_org::text,true);
  select body into v_current from pulse.tenant_config
    where org_id=v_org and doc_kind='targets' and doc_key='designers' and is_active for update;
  if not found or v_current is distinct from v_body then
    update pulse.tenant_config set is_active=false
      where org_id=v_org and doc_kind='targets' and doc_key='designers' and is_active;
    select coalesce(max(version),0)+1 into v_version from pulse.tenant_config
      where org_id=v_org and doc_kind='targets' and doc_key='designers';
    insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active)
      values(v_org,'targets','designers',v_version,v_body,true);
    insert into pulse.event(org_id,id,source,type,time,subject,actor,actor_kind,purpose,sensitivity,visibility,data)
      values(v_org,'ea-designer-targets-v'||v_version,'/system/pulse-migration','config.changed',now(),
        'config:pulse:targets/designers','system:pulse:db-migration','system',array['delivery'],0,'org',
        jsonb_build_object('version',v_version,'changed_by_ref','system:pulse:db-migration'));
    perform pg_notify('pulse_events',v_org::text);
  end if;
end
$seed$;

-- migrate:down
-- Tenant configuration is durable seed data and is retained by rollback.

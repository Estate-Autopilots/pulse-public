-- migrate:up
-- PEOPLE-CONTACTS part 4 (owner, 11 Oct 2026): "an add contact type button (developers, channel partners, models,
-- others); client types editable the same way. Make the app general, so any company can onboard."
--  * pulse.record_type: an organisation's own contact and client types: a key that never changes, a label, a colour,
--    a one-line hint, its own fields, an order, and archived or not. Organisation admins add, rename, recolour, reorder
--    and archive them (pulse.record_type_save); everyone reads them.
--  * The types Pulse had fixed become each organisation's defaults on first use (no trigger on pulse.org: a lazy seed,
--    like onboarding_defaults), so existing records keep their keys and simply gain an editable label ("talent" reads
--    "Model"). "Other" (both) and "Internal" (clients, which the work model relies on) cannot be archived.
--  * A record's type must be one of its organisation's types (a trigger, since a key belongs to an organisation); an
--    archived type stays on the records that have it but cannot be given to another.
--  * A type's own fields: contact_profile.custom and client.custom hold their values (checked by the API against the
--    type's field list: text, number, date, link, phone, e-mail or a choice).
create table pulse.record_type (
 org_id uuid not null references pulse.org(id),
 entity text not null check (entity in ('contact','client')),
 key text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
 label text not null check (length(btrim(label)) between 2 and 40),
 plural text check (plural is null or length(btrim(plural)) between 2 and 48),
 color text not null default 'slate' check (color in ('slate','blue','violet','rose','amber','green','teal','orange','indigo','pink')),
 hint text check (hint is null or length(hint)<=160),
 fields jsonb not null default '[]' check (jsonb_typeof(fields)='array' and jsonb_array_length(fields)<=12 and pg_column_size(fields)<8192),
 sort int not null default 100,
 system boolean not null default false,
 archived_at timestamptz,
 updated_by uuid,                          -- no foreign key (release smoke cleanup deletes people)
 updated_at timestamptz not null default now(),
 primary key (org_id, entity, key)
);
alter table pulse.record_type enable row level security;
alter table pulse.record_type force row level security;
create policy tenant on pulse.record_type using (org_id=pulse.current_org()) with check (org_id=pulse.current_org());
grant select on pulse.record_type to pulse_api, pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse.record_type for each row execute function pulse.audit_mutation();

alter table pulse.contact_profile add column custom jsonb not null default '{}' check (jsonb_typeof(custom)='object' and pg_column_size(custom)<8192);
alter table pulse.client add column custom jsonb not null default '{}' check (jsonb_typeof(custom)='object' and pg_column_size(custom)<8192);
grant update (custom) on pulse.client to pulse_api;

-- The defaults, once per organisation (called by every reader and writer; cheap when already there).
create function pulse.record_types_defaults() returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_org() is null or exists(select 1 from record_type where org_id=current_org() limit 1) then return; end if;
 insert into record_type(org_id,entity,key,label,plural,color,hint,sort,system) values
  (current_org(),'contact','developer','Developer','Developers','blue','Builds the projects we market.',10,false),
  (current_org(),'contact','channel_partner','Channel partner','Channel partners','violet','Sells the projects.',20,false),
  (current_org(),'contact','talent','Model','Models','rose','Appears in shoots.',30,false),
  (current_org(),'contact','vendor','Vendor','Vendors','amber','Supplies a service or equipment.',40,false),
  (current_org(),'contact','other','Other','Other','slate','Anyone else.',900,true),
  (current_org(),'client','developer','Developer','Developers','blue','A builder or developer marketing its projects.',10,false),
  (current_org(),'client','channel_partner','Channel partner','Channel partners','violet','Sells projects for developers.',20,false),
  (current_org(),'client','agent','Agent','Agents','teal','A broker or individual agent.',30,false),
  (current_org(),'client','brand','Brand','Brands','orange','A brand outside real estate.',40,false),
  (current_org(),'client','internal','Internal','Internal','indigo','The organisation’s own work.',800,true),
  (current_org(),'client','other','Other','Other','slate','Anyone else.',900,true)
 on conflict do nothing;
end $$;

-- A record's type is one of its organisation's types; a newly given type is not archived.
create function pulse.record_type_check() returns trigger
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_entity text:=case when tg_table_name='client' then 'client' else 'contact' end; col text:=case when tg_table_name='client' then 'client_type' else 'contact_type' end; k text; t record_type;
begin
 k:=to_jsonb(new)->>col;
 if k is null then return new; end if;
 if tg_op='UPDATE' and k is not distinct from to_jsonb(old)->>col then return new; end if;
 perform set_config('pulse.org_id',new.org_id::text,true) where current_org() is null;
 perform record_types_defaults();
 select * into t from record_type r where r.org_id=new.org_id and r.entity=v_entity and r.key=k;
 if not found then raise exception 'Unknown % type %',v_entity,k using errcode='22023'; end if;
 if t.archived_at is not null then raise exception 'The % type % is archived. Choose another',v_entity,t.label using errcode='22023'; end if;
 return new;
end $$;
alter table pulse.contact_profile drop constraint contact_profile_contact_type_check;
alter table pulse.client drop constraint client_client_type_check;
create trigger record_type_check before insert or update of contact_type on pulse.contact_profile for each row execute function pulse.record_type_check();
create trigger record_type_check before insert or update of client_type on pulse.client for each row execute function pulse.record_type_check();

-- Every type with how many records have it (for Settings and the filters).
create function pulse.record_types(p_entity text default null) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform record_types_defaults();
 return coalesce((select jsonb_agg(jsonb_build_object('entity',t.entity,'key',t.key,'label',t.label,'plural',coalesce(t.plural,t.label),'color',t.color,'hint',t.hint,
   'fields',t.fields,'sort',t.sort,'system',t.system,'archived',t.archived_at is not null,
   'count',case when t.entity='contact' then (select count(*) from contact_profile cp join person p on p.id=cp.person_id where cp.org_id=current_org() and cp.contact_type=t.key and p.status<>'offboarded')
     else (select count(*) from client c where c.org_id=current_org() and c.client_type=t.key) end) order by t.entity,t.archived_at is not null,t.sort,t.label)
  from record_type t where t.org_id=current_org() and (p_entity is null or t.entity=p_entity)),'[]');
end $$;

-- Add or change one type (admins). p_data: label, plural, color, hint, fields, sort, archived. A new key comes from
-- the label. Every change is a record_change row on the organisation.
create function pulse.record_type_save(p_entity text, p_key text, p_data jsonb) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k text:=nullif(p_key,''); t record_type; f jsonb; keys text[]:='{}'; v_label text:=nullif(btrim(p_data->>'label'),'');
begin
 if current_viewer() is null or not viewer_is('admin') then raise exception 'An organisation admin changes types' using errcode='42501'; end if;
 if p_entity not in ('contact','client') then raise exception 'Contact or client types' using errcode='22023'; end if;
 perform record_types_defaults();
 if p_data ? 'fields' then
  if jsonb_typeof(p_data->'fields')<>'array' or jsonb_array_length(p_data->'fields')>12 then raise exception 'Up to 12 fields' using errcode='22023'; end if;
  for f in select value from jsonb_array_elements(p_data->'fields') loop
   if coalesce(f->>'key','') !~ '^[a-z][a-z0-9_]{1,31}$' or length(btrim(coalesce(f->>'label','')))<2 or length(f->>'label')>40
    or coalesce(f->>'type','') not in ('text','number','date','url','tel','email','choice')
    or (f->>'type'='choice' and (jsonb_typeof(f->'options')<>'array' or jsonb_array_length(f->'options') not between 1 and 20)) then
    raise exception 'Each field needs a name and a kind; a choice needs 1 to 20 options' using errcode='22023'; end if;
   if f->>'key'=any(keys) then raise exception 'Two fields have the same name' using errcode='22023'; end if;
   keys:=keys||(f->>'key');
  end loop;
 end if;
 if k is null then
  if v_label is null or length(v_label)<2 or length(v_label)>40 then raise exception 'A type needs a name of 2 to 40 characters' using errcode='22023'; end if;
  k:=left(regexp_replace(regexp_replace(lower(v_label),'[^a-z0-9]+','_','g'),'^_+|_+$','','g'),40);
  if k !~ '^[a-z]' then k:='t_'||k; end if;
  if length(k)<2 then k:=k||'_type'; end if;
  if exists(select 1 from record_type where org_id=current_org() and entity=p_entity and key=k) then raise exception 'There is already a type called %',v_label using errcode='22023'; end if;
  insert into record_type(org_id,entity,key,label,plural,color,hint,fields,sort,updated_by)
  values(current_org(),p_entity,k,v_label,nullif(btrim(p_data->>'plural'),''),coalesce(nullif(p_data->>'color',''),'slate'),nullif(btrim(p_data->>'hint'),''),coalesce(p_data->'fields','[]'),
   coalesce((p_data->>'sort')::int,(select coalesce(max(sort),0)+10 from record_type where org_id=current_org() and entity=p_entity and not system)),current_viewer());
  insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values(current_org(),'org',current_org(),p_entity||'_type.'||k,null,v_label,current_viewer());
 else
  select * into t from record_type where org_id=current_org() and entity=p_entity and key=k for update;
  if not found then raise exception 'Unknown type' using errcode='22023'; end if;
  if coalesce((p_data->>'archived')::boolean,false) and t.system then raise exception 'This type is part of how Pulse works and stays' using errcode='22023'; end if;
  if v_label is not null and exists(select 1 from record_type r where r.org_id=current_org() and r.entity=p_entity and r.key<>k and lower(r.label)=lower(v_label)) then
   raise exception 'There is already a type called %',v_label using errcode='22023'; end if;
  update record_type set label=coalesce(v_label,record_type.label),
   plural=case when p_data ? 'plural' then nullif(btrim(p_data->>'plural'),'') else plural end,
   color=coalesce(nullif(p_data->>'color',''),color),hint=case when p_data ? 'hint' then nullif(btrim(p_data->>'hint'),'') else hint end,
   fields=coalesce(p_data->'fields',fields),sort=coalesce((p_data->>'sort')::int,sort),
   archived_at=case when p_data ? 'archived' then case when (p_data->>'archived')::boolean then coalesce(archived_at,now()) end else archived_at end,
   updated_by=current_viewer(),updated_at=now() where org_id=current_org() and entity=p_entity and key=k;
  insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by)
  select current_org(),'org',current_org(),p_entity||'_type.'||k,t.label||case when t.archived_at is not null then ' (archived)' else '' end,
   n.label||case when n.archived_at is not null then ' (archived)' else '' end,current_viewer() from record_type n where n.org_id=current_org() and n.entity=p_entity and n.key=k;
 end if;
 return (select e from jsonb_array_elements(record_types(p_entity)) e where e->>'key'=k);
end $$;

revoke all on function pulse.record_types_defaults(),pulse.record_type_check(),pulse.record_types(text),pulse.record_type_save(text,text,jsonb) from public;
grant execute on function pulse.record_types(text),pulse.record_type_save(text,text,jsonb) to pulse_api;
grant execute on function pulse.record_types_defaults() to pulse_api, pulse_worker;

-- migrate:down
-- Forward-only: an organisation's types stay.

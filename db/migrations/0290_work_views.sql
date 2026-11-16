-- migrate:up
-- TASKS-4A (12 Oct 2026): views everywhere. Each person's last view, default view, usage and "make it your default?"
-- answers per place in Work (my tasks, a pod, the company, a person, a project, the pool), their saved views, and the
-- word a company uses for its teams (EA says "Pod"; another company may say Team or Squad). Rows belong to the person
-- who made them: nobody else reads or changes them. They go with the person (on delete cascade), so cleaning up
-- validation people never trips on them.

create table pulse.work_view_pref (
 org_id uuid not null references pulse.org(id),
 person_id uuid not null references pulse.person(id) on delete cascade,
 place text not null check (place ~ '^[a-z][a-z0-9_-]{0,40}$'),
 layout text check (layout in ('list','board','table','calendar','timeline','gallery')),
 default_layout text check (default_layout in ('list','board','table','calendar','timeline','gallery')),
 config jsonb not null default '{}' check (jsonb_typeof(config)='object' and length(config::text)<=4000),
 uses jsonb not null default '{}' check (jsonb_typeof(uses)='object' and length(uses::text)<=4000),
 asked jsonb not null default '{}' check (jsonb_typeof(asked)='object' and length(asked::text)<=1000),
 updated_at timestamptz not null default now(),
 primary key (org_id, person_id, place)
);
create table pulse.work_saved_view (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references pulse.org(id),
 person_id uuid not null references pulse.person(id) on delete cascade,
 place text not null check (place ~ '^[a-z][a-z0-9_-]{0,40}$'),
 name text not null check (length(btrim(name)) between 1 and 60),
 config jsonb not null check (jsonb_typeof(config)='object' and length(config::text)<=4000),
 position smallint not null default 100,
 created_at timestamptz not null default now()
);
create index work_saved_view_owner on pulse.work_saved_view(org_id, person_id, place, position);
do $$ declare t text; begin
 foreach t in array array['work_view_pref','work_saved_view'] loop
  execute format('alter table pulse.%I enable row level security', t);
  execute format('alter table pulse.%I force row level security', t);
  execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())', t);
  execute format('create policy own_views on pulse.%I as restrictive using(person_id=pulse.current_viewer()) with check(person_id=pulse.current_viewer())', t);
  execute format('grant select,insert,update,delete on pulse.%I to pulse_api', t);
 end loop;
end $$;

-- The word for a team. Null keeps "Pod".
alter table pulse.work_settings add column team_label text check (team_label ~ '^[[:alpha:]][[:alpha:] -]{1,19}$');
create or replace function pulse.work_settings_get() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('businessModel',coalesce(s.business_model,'agency'),'aiAutoAcceptMax',s.ai_auto_accept_max,'teamLabel',coalesce(s.team_label,'Pod'),'updatedAt',s.updated_at,
  'updatedBy',(select display_name from person where id=s.updated_by),'canEdit',coalesce(current_viewer() is not null and viewer_is('admin','leadership'),false))
 from (select 1) x left join work_settings s on s.org_id=current_org()
$$;
create or replace function pulse.work_settings_set(p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cur work_settings;v_model text;v_max int;v_team text;
begin
 if current_viewer() is null or not viewer_is('admin','leadership') then raise exception 'Leadership and admins choose how Pulse names your work' using errcode='42501';end if;
 if jsonb_typeof(p)<>'object' then raise exception 'Choose a setting' using errcode='22023';end if;
 select * into cur from work_settings where org_id=current_org() for update;
 v_model:=case when p ? 'businessModel' then p->>'businessModel' else coalesce(cur.business_model,'agency') end;
 if v_model not in ('agency','product','internal') then raise exception 'Choose agency, product or internal' using errcode='22023';end if;
 begin v_max:=case when p ? 'aiAutoAcceptMax' then nullif(p->>'aiAutoAcceptMax','')::int else cur.ai_auto_accept_max end;
 exception when others then raise exception 'Enter a number of value points from 1 to 100, or leave it off' using errcode='22023';end;
 if v_max is not null and v_max not between 1 and 100 then raise exception 'Enter a number of value points from 1 to 100, or leave it off' using errcode='22023';end if;
 v_team:=case when p ? 'teamLabel' then nullif(initcap(btrim(regexp_replace(coalesce(p->>'teamLabel',''),'\s+',' ','g'))),'') else cur.team_label end;
 if v_team='Pod' then v_team:=null;end if;
 if v_team is not null and v_team !~ '^[[:alpha:]][[:alpha:] -]{1,19}$' then raise exception 'Call a team with one or two words, 2 to 20 letters' using errcode='22023';end if;
 insert into work_settings(org_id,business_model,ai_auto_accept_max,team_label,updated_by) values(current_org(),v_model,v_max,v_team,current_viewer())
  on conflict(org_id) do update set business_model=excluded.business_model,ai_auto_accept_max=excluded.ai_auto_accept_max,team_label=excluded.team_label,updated_by=excluded.updated_by,updated_at=now();
 perform audit_write('work_settings_set','org',current_org()::text);
 return work_settings_get();
end $$;
-- migrate:down
-- Forward-only: people's saved views and preferences are their own records.

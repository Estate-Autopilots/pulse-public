-- migrate:up
-- UX-TASKS-2 (owner feedback, 10 Oct 2026): responsibility domains, the task pool, value and the leader's view.
-- * The kind of business is a company setting (agency, product or internal) that names things; Pip's low-value
--   automatic acceptance is a company setting too, off by default.
-- * Work categories and tags on tasks and projects; responsibility domains match on them. A domain is agreed between
--   the person and the company (proposed by one side, accepted by the other, with a date) or set by company policy.
-- * Assigning: inside the person's domains it is direct (their head always may); outside them it is a request to join
--   that they accept or decline. Until someone has domains, Who can do what decides, as before.
-- * The pool: a task with nobody yet, for the company, a department or a pod, with importance, urgency, an estimate and
--   value points. The first claim wins; the claimant is credited the value when the work is accepted.
-- * A client project ties to many projects: links with evidence (Drive folders, names, trackers, PEOPLE-LIVE), detected
--   as suggestions for one-click review, and a capture seam for the admin Google connection.
-- Every write goes through the functions below; nothing is deleted.

-- 1. The company's work settings ---------------------------------------------------------------------------------------
create table pulse.work_settings (
 org_id uuid primary key references pulse.org(id),
 business_model text not null default 'agency' check(business_model in ('agency','product','internal')),
 ai_auto_accept_max smallint check(ai_auto_accept_max between 1 and 100),   -- null: Pip only suggests (the default)
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now()
);

-- 2. Work categories: what kind of work a task is. Tasks, projects and domains share them ----------------------------
create table pulse.work_category (
 org_id uuid not null references pulse.org(id),key text not null check(key ~ '^[a-z][a-z0-9_]{1,39}$'),
 label text not null check(length(btrim(label)) between 2 and 60),
 keywords text[] not null default '{}' check(cardinality(keywords)<=40),   -- regular-expression stems read from task titles
 position smallint not null default 100,active boolean not null default true,
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now(),
 primary key(org_id,key)
);
alter table pulse.task add column category text,
 add column tags text[] not null default '{}' check(cardinality(tags)<=12),
 add column urgency text not null default 'normal' check(urgency in ('low','normal','high')),
 add column estimate_minutes int check(estimate_minutes between 5 and 20000),
 add column value_points smallint check(value_points between 1 and 100),
 add column value_source text check(value_source in ('leadership','creator','reviewer','ai_auto')),
 add column value_by uuid references pulse.person(id),add column value_at timestamptz,
 add column ai_suggestion jsonb,
 add column pool_scope text check(pool_scope in ('company','department','pod')),
 add column pool_ref text check(length(pool_ref)<=80),
 add column pooled_at timestamptz,add column pooled_by uuid references pulse.person(id),
 add column claimed_at timestamptz,add column claimed_by uuid references pulse.person(id),
 add constraint task_pool_ref check(pool_scope is null or (pool_scope='company')=(pool_ref is null)),
 add constraint task_category_fk foreign key(org_id,category) references pulse.work_category(org_id,key);
create index task_pool on pulse.task(org_id,pool_scope,pool_ref) where pool_scope is not null and assignee_person_id is null and owner_id is null;
create index task_category on pulse.task(org_id,category) where category is not null;
alter table pulse.work_project add column category text,add column tags text[] not null default '{}' check(cardinality(tags)<=12),
 add constraint work_project_category_fk foreign key(org_id,category) references pulse.work_category(org_id,key);
alter table pulse.task_event drop constraint task_event_kind_check;
alter table pulse.task_event add constraint task_event_kind_check check(kind in ('created','edited','status','assigned','reviewer','blocked','unblocked','proof','accepted','returned','moved','asked','joined',
 'pooled','claimed','valued'));

-- 3. A client project and the projects that deliver it ------------------------------------------------------------------
-- The fulfilment project shares the client project's id (0144). Other work projects that deliver it are linked here.
create table pulse.work_project_link (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 client_project_id uuid not null references pulse.project(id),project_id uuid not null references pulse.project(id),
 status text not null default 'suggested' check(status in ('suggested','linked','dismissed')),
 source text not null check(source in ('drive','name','tracker','people','google','manual')),
 confidence numeric(3,2) not null default 0.5 check(confidence between 0 and 1),
 evidence jsonb not null default '[]' check(jsonb_typeof(evidence)='array'),
 created_by uuid references pulse.person(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 decided_by uuid references pulse.person(id),decided_at timestamptz,
 check(client_project_id<>project_id),unique(org_id,client_project_id,project_id)
);
create index work_project_link_project on pulse.work_project_link(org_id,project_id) where status='linked';
create index work_project_link_review on pulse.work_project_link(org_id,status,confidence desc) where status='suggested';

-- 4. Responsibility domains ---------------------------------------------------------------------------------------------
-- What a person is responsible for: a kind of work (categories, tags) and where (a pod's work, a client, a project).
create table pulse.work_domain (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id),
 title text not null check(length(btrim(title)) between 3 and 160),
 basis text not null check(basis in ('agreement','policy')),
 categories text[] not null default '{}' check(cardinality(categories)<=8),
 tags text[] not null default '{}' check(cardinality(tags)<=8),
 pod text check(length(pod)<=80),project_id uuid references pulse.project(id),client_id uuid references pulse.client(id),
 note text check(length(note)<=500),
 status text not null default 'proposed' check(status in ('proposed','active','declined','withdrawn','ended')),
 proposed_by uuid not null references pulse.person(id),proposed_side text not null check(proposed_side in ('employee','company')),
 person_agreed_at timestamptz,company_agreed_at timestamptz,company_agreed_by uuid references pulse.person(id),
 effective_from date,agreed_on date,
 answered_by uuid references pulse.person(id),answered_at timestamptz,answer_note text check(length(answer_note)<=500),
 ended_at timestamptz,ended_by uuid references pulse.person(id),end_note text check(length(end_note)<=500),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(cardinality(categories)>0 or cardinality(tags)>0 or pod is not null or project_id is not null or client_id is not null),
 check(basis<>'policy' or proposed_side='company')
);
create index work_domain_person on pulse.work_domain(org_id,person_id) where status in ('proposed','active');

-- 5. Credit: the value a person is credited when their work is accepted ---------------------------------------------
create table pulse.work_credit (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 task_id uuid not null references pulse.task(id),person_id uuid not null references pulse.person(id),
 points smallint not null check(points between 0 and 100),
 basis text not null check(basis in ('value','rating')),            -- value points set up front, or the reviewer's effort × impact
 via text not null check(via in ('pool','assigned')),
 work_day date not null,credited_at timestamptz not null default now(),reversed_at timestamptz
);
create unique index work_credit_live on pulse.work_credit(org_id,task_id) where reversed_at is null;
create index work_credit_person on pulse.work_credit(org_id,person_id,work_day) where reversed_at is null;

do $$ declare t text;begin
 foreach t in array array['work_settings','work_category','work_project_link','work_domain','work_credit'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('grant select on pulse.%I to pulse_api',t);
  execute format('grant select,insert,update on pulse.%I to pulse_worker',t);
  execute format('create trigger audit_mutation after insert or update on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;
end $$;
-- Linked projects are ordinary facts; suggestions wait for leadership. Active domains are on everyone's profile;
-- proposals only reach the two sides, HR, leadership and the person's head. Credits are as private as time entries.
create policy visible on pulse.work_project_link as restrictive for select to pulse_api using(status='linked' or pulse.viewer_is('admin','leadership','hr'));
create policy visible on pulse.work_domain as restrictive for select to pulse_api using(status='active' or person_id=pulse.current_viewer() or proposed_by=pulse.current_viewer()
 or pulse.viewer_is('admin','leadership','hr') or pulse.manages(person_id));
create policy visible on pulse.work_credit as restrictive for select to pulse_api using(person_id=pulse.current_viewer() or pulse.viewer_is('admin','leadership','hr') or pulse.manages(person_id)
 or exists(select 1 from pulse.people_profile pp where pp.person_id=work_credit.person_id and pp.pod=any(pulse.work_head_pods())));

-- Settings ------------------------------------------------------------------------------------------------------------
create function pulse.work_settings_get() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('businessModel',coalesce(s.business_model,'agency'),'aiAutoAcceptMax',s.ai_auto_accept_max,'updatedAt',s.updated_at,
  'updatedBy',(select display_name from person where id=s.updated_by),'canEdit',coalesce(current_viewer() is not null and viewer_is('admin','leadership'),false))
 from (select 1) x left join work_settings s on s.org_id=current_org()
$$;
create function pulse.work_settings_set(p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cur work_settings;v_model text;v_max int;
begin
 if current_viewer() is null or not viewer_is('admin','leadership') then raise exception 'Leadership and admins choose how Pulse names your work' using errcode='42501';end if;
 if jsonb_typeof(p)<>'object' then raise exception 'Choose a setting' using errcode='22023';end if;
 select * into cur from work_settings where org_id=current_org() for update;
 v_model:=case when p ? 'businessModel' then p->>'businessModel' else coalesce(cur.business_model,'agency') end;
 if v_model not in ('agency','product','internal') then raise exception 'Choose agency, product or internal' using errcode='22023';end if;
 begin v_max:=case when p ? 'aiAutoAcceptMax' then nullif(p->>'aiAutoAcceptMax','')::int else cur.ai_auto_accept_max end;
 exception when others then raise exception 'Enter a number of value points from 1 to 100, or leave it off' using errcode='22023';end;
 if v_max is not null and v_max not between 1 and 100 then raise exception 'Enter a number of value points from 1 to 100, or leave it off' using errcode='22023';end if;
 insert into work_settings(org_id,business_model,ai_auto_accept_max,updated_by) values(current_org(),v_model,v_max,current_viewer())
 on conflict(org_id) do update set business_model=excluded.business_model,ai_auto_accept_max=excluded.ai_auto_accept_max,updated_by=excluded.updated_by,updated_at=now();
 perform audit_write('work_settings_set','org',current_org()::text);
 return work_settings_get();
end $$;

-- Categories ----------------------------------------------------------------------------------------------------------
-- One vocabulary for agencies, product companies and internal teams; a company switches off what it does not do.
create function pulse.work_category_seed() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n int;
begin
 insert into work_category(org_id,key,label,keywords,position)
 select current_org(),k,l,kw,pos from (values
  ('video_shoot','Video shoot',array['shoot','shooting','videograph','drones?\M','recce','location scout','b-?rolls?','testimonial','site visit'],10),
  ('video_edit','Video editing',array['edit','editing','cut\M','cuts\M','reels?\M','teaser','vov\M','colou?r grad','montage','model video','video finali','hooks?\M','subtitles?','render'],20),
  ('design','Design and creatives',array['design','creatives?\M','carousel','banner','poster','brochure','static','single image','thumbnail','logo','graphic','mock-?up','flyer','hoarding'],30),
  ('scripting','Scripts and copy',array['script','copy\M','copywrit','captions?\M','blog','article','voice-?over','content writ'],40),
  ('meta_ads','Meta ads',array['meta\M','facebook','fb\M','instagram ads?','ad ?sets?\M','campaigns?\M','lead ads?','ads? account','boost'],50),
  ('google_ads','Google ads',array['google ads?','adwords','search ads?','ppc\M','youtube ads?','performance max','pmax'],60),
  ('social','Social media',array['instagram','posts?\M','posting','social','linkedin','stories','story\M','youtube'],70),
  ('onboarding','Client onboarding',array['onboarding','kick-?off','collect inputs','welcome kit','brief\M'],80),
  ('client_service','Client service',array['client call','call with','follow-?up','feedback','approval','client meeting','reports?\M','check-?in with'],90),
  ('sales','Sales',array['leads?\M','proposal','pitch','quotation','quote\M','bookings?\M','deal\M','prospect','demo call','sales'],100),
  ('web','Web and tech',array['website','web ?site','landing page','web page','pricing page','homepage','domain\M','hosting','wordpress','seo\M'],110),
  ('engineering','Engineering',array['bugs?\M','feature','api\M','deploy','release','build\M','code\M','refactor','database','migration','app\M','backend','frontend','infrastructure','security'],120),
  ('qa','Testing',array['testing','qa\M','regression','test cases?','test plan'],130),
  ('hr','HR and people',array['hiring','hire\M','interview','recruit','payroll','leave policy','appraisal','attendance','hr\M'],140),
  ('finance','Finance',array['invoice','payments?\M','gst\M','tds\M','bank','reconcil','expense','budget','accounts\M','salary'],150),
  ('operations','Operations',array['licen[cs]e','permit','vendor','purchase','logistics','inventory','equipment','travel'],160),
  ('research','Research and strategy',array['research','strategy','plan\M','planning','audit','analysis','competitor','market','roadmap'],170)
 ) v(k,l,kw,pos) on conflict do nothing;
 get diagnostics n=row_count;return n;
end $$;
-- The first category (in order) whose stems appear in the text; null when none do.
create function pulse.work_category_guess(p_text text) returns text language sql stable security definer set search_path=pulse,pg_temp as $$
 select key from work_category where org_id=current_org() and active and cardinality(keywords)>0
  and lower(coalesce(p_text,'')) ~ ('\m('||array_to_string(keywords,'|')||')') order by position,key limit 1
$$;
-- A new company starts with the same vocabulary.
create function pulse.work_category_follow_org() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare previous_org text:=current_setting('pulse.org_id',true);
begin
 perform set_config('pulse.org_id',new.id::text,true);
 perform work_category_seed();
 perform set_config('pulse.org_id',coalesce(previous_org,''),true);
 return null;
end $$;
create trigger work_category_follow_org after insert on pulse.org for each row execute function pulse.work_category_follow_org();
create function pulse.work_re_escape(p text) returns text language sql immutable as $$ select regexp_replace(p,'([.*+?^${}()|\[\]\\])','\\\1','g') $$;
-- Admins and HR name categories and their words; typed words are matched as plain words.
create function pulse.work_category_save(p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_key text:=lower(btrim(coalesce(p->>'key','')));v_label text:=btrim(regexp_replace(coalesce(p->>'label',''),'\s+',' ','g'));words text[];
begin
 if current_viewer() is null or not viewer_is('admin','hr') then raise exception 'HR and admins name the kinds of work' using errcode='42501';end if;
 if v_key !~ '^[a-z][a-z0-9_]{1,39}$' then raise exception 'Use a short key of letters, digits and _' using errcode='22023';end if;
 if length(v_label) not between 2 and 60 then raise exception 'Name the kind of work in 2 to 60 characters' using errcode='22023';end if;
 words:=array(select distinct work_re_escape(lower(btrim(x))) from jsonb_array_elements_text(coalesce(p->'words','[]')) x where length(btrim(x)) between 2 and 40 limit 40);
 insert into work_category(org_id,key,label,keywords,position,active,updated_by)
 values(current_org(),v_key,v_label,words,coalesce(nullif(p->>'position','')::int,100),coalesce((p->>'active')::boolean,true),current_viewer())
 on conflict(org_id,key) do update set label=excluded.label,keywords=case when p ? 'words' then excluded.keywords else work_category.keywords end,
  active=excluded.active,updated_by=excluded.updated_by,updated_at=now();
 perform audit_write('work_category_save','work_category',v_key);
end $$;
-- New tasks (the tracker import included) get a category from their title and tracker type when nobody chose one.
create function pulse.task_category_default() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.category is null then new.category:=work_category_guess(concat_ws(' ',new.title,new.deliverable_type));end if;
 return new;
end $$;
create trigger task_category_default before insert or update of title,deliverable_type on pulse.task for each row execute function pulse.task_category_default();
create function pulse.task_category_backfill() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n int;
begin
 if current_viewer() is not null and not viewer_is('admin') then raise exception 'Admins or the import worker sort tasks' using errcode='42501';end if;
 update task set category=g.c from (select id,work_category_guess(concat_ws(' ',title,deliverable_type)) c from task where org_id=current_org() and category is null) g
  where task.id=g.id and g.c is not null;
 get diagnostics n=row_count;return n;
end $$;
create function pulse.work_tags_clean(p jsonb) returns text[] language plpgsql immutable as $$
declare out text[]:='{}';x text;
begin
 if p is null or jsonb_typeof(p)='null' then return out;end if;
 if jsonb_typeof(p)<>'array' then raise exception 'Tags are a list' using errcode='22023';end if;
 for x in select distinct lower(regexp_replace(btrim(v),'\s+','-','g')) from jsonb_array_elements_text(p) v where btrim(v)<>'' loop
  if x !~ '^[a-z0-9][a-z0-9&._+-]{0,39}$' then raise exception 'Tags use letters, digits and - (up to 40)' using errcode='22023';end if;
  out:=out||x;
 end loop;
 if cardinality(out)>12 then raise exception 'Use up to 12 tags' using errcode='22023';end if;
 return out;
end $$;

-- Domains -------------------------------------------------------------------------------------------------------------
-- Who may speak for the company about a person's domains: leadership, HR and admins, or the person's head.
create function pulse.work_domain_company(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and current_viewer() is distinct from p_person and (viewer_is('admin','leadership','hr') or coalesce(manages(p_person),false))
$$;
-- The person's first active domain the work falls in (company policies first), or null.
create function pulse.work_domain_match(p_person uuid,p_project uuid,p_category text,p_tags text[]) returns uuid language sql stable security definer set search_path=pulse,pg_temp as $$
 with served as (select p_project id union select l.client_project_id from work_project_link l where l.org_id=current_org() and l.project_id=p_project and l.status='linked')
 select d.id from work_domain d where d.org_id=current_org() and d.person_id=p_person and d.status='active' and coalesce(d.effective_from,'-infinity')<=(now() at time zone 'Asia/Kolkata')::date
  and (cardinality(d.categories)=0 or p_category=any(d.categories))
  and (cardinality(d.tags)=0 or d.tags && (coalesce(p_tags,'{}')||coalesce((select wp.tags from work_project wp where wp.project_id=p_project),'{}')))
  and (d.pod is null or exists(select 1 from work_project wp join served s on s.id=wp.project_id where wp.pod=d.pod))
  and (d.project_id is null or d.project_id in (select id from served))
  and (d.client_id is null or exists(select 1 from project pr join served s on s.id=pr.id where pr.client_id=d.client_id))
 order by d.basis='policy' desc,d.created_at limit 1
$$;
create function pulse.work_domain_fields(p jsonb) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare v_title text:=btrim(regexp_replace(coalesce(p->>'title',''),'\s+',' ','g'));cats text[];v_pod text:=nullif(btrim(coalesce(p->>'pod','')),'');
 v_project uuid;v_client uuid;v_from date;
begin
 if jsonb_typeof(p)<>'object' then raise exception 'Describe the domain' using errcode='22023';end if;
 if length(v_title) not between 3 and 160 then raise exception 'Name the domain in 3 to 160 characters, e.g. “Video editing for Pod 2 clients”' using errcode='22023';end if;
 cats:=array(select distinct x from jsonb_array_elements_text(coalesce(p->'categories','[]')) x);
 if cardinality(cats)>8 or exists(select 1 from unnest(cats) c where not exists(select 1 from work_category where org_id=current_org() and key=c)) then raise exception 'Choose kinds of work from the list' using errcode='22023';end if;
 begin v_project:=nullif(p->>'projectId','')::uuid;v_client:=nullif(p->>'clientId','')::uuid;v_from:=nullif(p->>'effectiveFrom','')::date;
 exception when others then raise exception 'Choose a valid project, client and date' using errcode='22023';end;
 if v_project is not null and not exists(select 1 from project where org_id=current_org() and id=v_project) then raise exception 'Choose a project' using errcode='22023';end if;
 if v_client is not null and not exists(select 1 from client where org_id=current_org() and id=v_client) then raise exception 'Choose a client' using errcode='22023';end if;
 if v_pod is not null and not exists(select 1 from people_profile where org_id=current_org() and pod=v_pod union select 1 from unit where org_id=current_org() and kind='pod' and name=v_pod)
  then raise exception 'Choose a pod' using errcode='22023';end if;
 if cardinality(cats)=0 and jsonb_array_length(coalesce(nullif(p->'tags','null'),'[]'))=0 and v_pod is null and v_project is null and v_client is null then
  raise exception 'Say what kind of work it covers, or where: a pod, a client or a project' using errcode='22023';end if;
 return jsonb_build_object('title',v_title,'categories',to_jsonb(cats),'tags',to_jsonb(work_tags_clean(p->'tags')),'pod',v_pod,'projectId',v_project,'clientId',v_client,
  'effectiveFrom',v_from,'note',nullif(btrim(coalesce(p->>'note','')),''));
end $$;
-- Propose a domain: the person for themselves, or someone speaking for the company. The other side accepts.
-- Company policy (HR, leadership and admins) is active at once and is shown as mandatory.
create function pulse.work_domain_propose(p_person uuid,p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();f jsonb;did uuid;v_policy boolean:=coalesce(p->>'basis','agreement')='policy';side text;r record;
begin
 if not task_person_ok(p_person) then raise exception 'Choose an active team member' using errcode='22023';end if;
 if coalesce(p->>'basis','agreement') not in ('agreement','policy') then raise exception 'Choose an agreement or a company policy' using errcode='22023';end if;
 if v_policy and not (current_viewer() is distinct from p_person and viewer_is('admin','leadership','hr')) then raise exception 'HR, leadership and admins set company policy' using errcode='42501';end if;
 side:=case when p_person=me then 'employee' else 'company' end;
 if side='company' and not work_domain_company(p_person) then raise exception 'Only the person, their head, HR or leadership can propose their domains' using errcode='42501';end if;
 f:=work_domain_fields(p);
 insert into work_domain(org_id,person_id,title,basis,categories,tags,pod,project_id,client_id,note,status,proposed_by,proposed_side,person_agreed_at,company_agreed_at,company_agreed_by,effective_from,agreed_on)
 values(current_org(),p_person,f->>'title',case when v_policy then 'policy' else 'agreement' end,array(select jsonb_array_elements_text(f->'categories')),array(select jsonb_array_elements_text(f->'tags')),
  f->>'pod',(f->>'projectId')::uuid,(f->>'clientId')::uuid,f->>'note',case when v_policy then 'active' else 'proposed' end,me,side,
  case when side='employee' then now() end,case when side='company' then now() end,case when side='company' then me end,
  coalesce((f->>'effectiveFrom')::date,case when v_policy then (now() at time zone 'Asia/Kolkata')::date end),case when v_policy then (now() at time zone 'Asia/Kolkata')::date end)
 returning id into did;
 if v_policy then
  perform work_notify(p_person,'domain.policy','work_domain',did,did::text,'Company policy: '||(f->>'title')||' is now one of your domains','/people/'||p_person||'?tab=domains','task');
 elsif side='company' then
  perform work_notify(p_person,'domain.proposed','work_domain',did,did::text,work_first_name(me)||' proposes a domain for you: '||(f->>'title'),'/people/'||p_person||'?tab=domains','task');
 else
  -- The person's head hears first; with no head, HR.
  for r in select distinct x from (select hr_head(p_person) x union select ra.person_id from role_assignment ra where hr_head(p_person) is null and ra.org_id=current_org() and ra.role_key='hr'
   and current_date between ra.valid_from and coalesce(ra.valid_to,'infinity')) s where x is not null and x<>p_person limit 5 loop
   perform work_notify(r.x,'domain.proposed','work_domain',did,did::text,work_first_name(me)||' proposes a domain: '||(f->>'title'),'/people/'||p_person||'?tab=domains','task');
  end loop;
 end if;
 perform audit_write(case when v_policy then 'work_domain_policy' else 'work_domain_propose' end,'work_domain',did::text);
 return did;
end $$;
create function pulse.work_domain_answer(p_id uuid,p_accept boolean,p_note text default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();d work_domain;day date:=(now() at time zone 'Asia/Kolkata')::date;
begin
 select * into d from work_domain where org_id=current_org() and id=p_id for update;
 if not found then raise exception 'Domain not found' using errcode='P0002';end if;
 if d.status<>'proposed' then
  if d.status=(case when p_accept then 'active' else 'declined' end) then return jsonb_build_object('status',d.status);end if;
  raise exception 'This proposal was already %',case d.status when 'active' then 'agreed' else d.status end using errcode='22023';
 end if;
 if (d.proposed_side='company' and me<>d.person_id) or (d.proposed_side='employee' and not work_domain_company(d.person_id)) then
  raise exception 'The other side answers: % for a company proposal, their head, HR or leadership for the person''s own',work_first_name(d.person_id) using errcode='42501';end if;
 update work_domain set status=case when p_accept then 'active' else 'declined' end,answered_by=me,answered_at=now(),answer_note=nullif(btrim(coalesce(p_note,'')),''),
  person_agreed_at=case when p_accept then coalesce(person_agreed_at,now()) end,
  company_agreed_at=case when p_accept then coalesce(company_agreed_at,now()) end,company_agreed_by=case when p_accept then coalesce(company_agreed_by,me) else company_agreed_by end,
  agreed_on=case when p_accept then day end,effective_from=case when p_accept then greatest(coalesce(effective_from,day),day) else effective_from end,updated_at=now() where id=p_id;
 perform work_notify(d.proposed_by,'domain.answered','work_domain',p_id,p_id||':answered',work_first_name(me)||case when p_accept then ' agreed: ' else ' declined: ' end||d.title,'/people/'||d.person_id||'?tab=domains','task');
 perform audit_write(case when p_accept then 'work_domain_agree' else 'work_domain_decline' end,'work_domain',p_id::text);
 return jsonb_build_object('status',case when p_accept then 'active' else 'declined' end);
end $$;
create function pulse.work_domain_withdraw(p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();
begin
 update work_domain set status='withdrawn',updated_at=now() where org_id=current_org() and id=p_id and proposed_by=me and status='proposed';
 if not found then raise exception 'Only a pending proposal you made can be withdrawn' using errcode='22023';end if;
end $$;
-- Either side ends an agreement (with a note); company policy is ended by HR, leadership or admins.
create function pulse.work_domain_end(p_id uuid,p_note text default null) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();d work_domain;other uuid;
begin
 select * into d from work_domain where org_id=current_org() and id=p_id for update;
 if not found or d.status<>'active' then raise exception 'Only an active domain can be ended' using errcode='22023';end if;
 if d.basis='policy' and not (me<>d.person_id and viewer_is('admin','leadership','hr')) then raise exception 'Company policy is changed by HR or leadership' using errcode='42501';end if;
 if d.basis='agreement' and not (me=d.person_id or work_domain_company(d.person_id)) then raise exception 'The person, their head, HR or leadership can end this agreement' using errcode='42501';end if;
 update work_domain set status='ended',ended_at=now(),ended_by=me,end_note=nullif(btrim(coalesce(p_note,'')),''),updated_at=now() where id=p_id;
 other:=case when me=d.person_id then coalesce(d.company_agreed_by,hr_head(d.person_id)) else d.person_id end;
 perform work_notify(other,'domain.ended','work_domain',p_id,p_id||':ended',work_first_name(me)||' ended the domain: '||d.title,'/people/'||d.person_id||'?tab=domains','task');
 perform audit_write('work_domain_end','work_domain',p_id::text);
end $$;

-- Assigning: inside the person's domains, outside them, or (before anyone agreed domains) the matrix --------------
-- Returns {mode: self | direct | request | none, why, domainId, domainTitle, basis}.
create function pulse.work_assign_mode(p_person uuid,p_project uuid,p_category text,p_tags text[]) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();d work_domain;head boolean;ask boolean;
begin
 if me is null or p_person is null then return jsonb_build_object('mode','none','why','nobody');end if;
 if p_person=me then return jsonb_build_object('mode','self','why','self');end if;
 if not task_person_ok(p_person) then return jsonb_build_object('mode','none','why','inactive');end if;
 head:=work_role()='leadership' or coalesce(manages(p_person),false);
 ask:=work_reaches(work_scope('task.ask'),p_person);
 select * into d from work_domain where id=work_domain_match(p_person,p_project,p_category,p_tags);
 if d.id is not null then
  if head or ask or task_can_give(p_person) then
   return jsonb_build_object('mode','direct','why',case when coalesce(manages(p_person),false) then 'head_domain' else 'in_domain' end,'domainId',d.id,'domainTitle',d.title,'basis',d.basis);
  end if;
  return jsonb_build_object('mode','none','why','no_reach');
 end if;
 if exists(select 1 from work_domain where org_id=current_org() and person_id=p_person and status='active') then
  return case when head or ask then jsonb_build_object('mode','request','why','outside_domains') else jsonb_build_object('mode','none','why','no_reach') end;
 end if;
 if task_can_give(p_person) then return jsonb_build_object('mode','direct','why','matrix');end if;
 if ask then return jsonb_build_object('mode','request','why','matrix');end if;
 return jsonb_build_object('mode','none','why','no_reach');
end $$;

-- The pool ------------------------------------------------------------------------------------------------------------
-- Leadership and HR put tasks in any pool; a pod head in their pods' pools and their own department's.
create function pulse.work_can_pool(p_scope text,p_ref text) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and case when work_role() in ('leadership','hr') then p_scope in ('company','department','pod')
  when work_role()='pod_head' then (p_scope='pod' and p_ref=any(work_head_pods()))
   or (p_scope='department' and exists(select 1 from people_profile where org_id=current_org() and person_id=current_viewer() and department=p_ref))
  else false end
$$;
create function pulse.work_pool_eligible_for(p_person uuid,p_scope text,p_ref text) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select task_person_ok(p_person) and case p_scope when 'company' then true
  when 'department' then exists(select 1 from people_profile where org_id=current_org() and person_id=p_person and department=p_ref)
  when 'pod' then exists(select 1 from people_profile where org_id=current_org() and person_id=p_person and pod=p_ref) or exists(select 1 from hr_pod where org_id=current_org() and name=p_ref and head_id=p_person)
  else false end
$$;
create function pulse.work_pool_eligible(p_scope text,p_ref text) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (viewer_is('admin','leadership','hr') or case p_scope when 'company' then true
  when 'department' then exists(select 1 from people_profile where org_id=current_org() and person_id=current_viewer() and department=p_ref)
  when 'pod' then p_ref=any(work_my_pods()) else false end)
$$;
-- The first claim wins: the update only succeeds while nobody has the task.
create function pulse.work_pool_claim(p_task uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;done task;who uuid;
begin
 select * into t from task where org_id=current_org() and id=p_task;
 if not found or not task_visible(p_task) then raise exception 'Task not found' using errcode='P0002';end if;
 if t.pool_scope is null then raise exception 'This task is not in the pool' using errcode='22023';end if;
 if not work_pool_eligible(t.pool_scope,t.pool_ref) then raise exception 'This task is in the pool for %',coalesce(t.pool_ref,'the company') using errcode='42501';end if;
 if t.status not in ('open','unknown','in_progress','blocked') then raise exception 'This task is already finished' using errcode='22023';end if;
 who:=coalesce(t.pooled_by,t.created_by);
 update task set assignee_person_id=me,owner_id=me,assigned_at=now(),claimed_at=now(),claimed_by=me,edited_by=me,updated_at=now(),
  status=case when status='unknown' then 'open' else status end,
  review_owner_id=case when review_owner_id is not null and review_owner_id<>me then review_owner_id when who is not null and who<>me then who else hr_head(me) end,
  locked=array(select distinct unnest(locked||'{owner_id}'::text[]))
 where org_id=current_org() and id=p_task and assignee_person_id is null and owner_id is null and pool_scope is not null returning * into done;
 if done.id is null then raise exception 'Someone claimed it first' using errcode='23505';end if;
 update work_ask set status='withdrawn',decided_at=now() where org_id=current_org() and task_id=p_task and kind='take' and status='pending';
 perform task_event_add(p_task,'claimed',null,(select display_name from person where id=me),'From the '||coalesce(t.pool_ref||' ','company ')||'pool');
 perform work_notify(who,'pool.claimed','task',p_task,p_task||':claimed:'||me,work_first_name(me)||' claimed “'||left(t.title,90)||'” from the pool','/tasks/'||p_task,'task');
 return jsonb_build_object('status','claimed','valuePoints',done.value_points,'reviewerId',done.review_owner_id);
end $$;
-- The claimant can hand a task back to the pool before finishing it.
create function pulse.work_pool_release(p_task uuid,p_note text default null) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;
begin
 select * into t from task where org_id=current_org() and id=p_task for update;
 if not found or t.claimed_by is distinct from me or coalesce(t.assignee_person_id,t.owner_id) is distinct from me then raise exception 'Only the person who claimed it hands it back' using errcode='42501';end if;
 if t.status not in ('open','in_progress','blocked') then raise exception 'Finished work stays with you' using errcode='22023';end if;
 update task set assignee_person_id=null,owner_id=null,assigned_at=null,claimed_at=null,claimed_by=null,status='open',started_at=null,edited_by=me,updated_at=now() where id=p_task;
 perform task_event_add(p_task,'pooled',(select display_name from person where id=me),null,coalesce(nullif(btrim(coalesce(p_note,'')),''),'Handed back to the pool'));
end $$;

-- Value ---------------------------------------------------------------------------------------------------------------
-- Leadership, HR, the doer's head, the reviewer or whoever created or pooled it sets value; nobody values their own
-- work; once accepted, only leadership changes it.
create function pulse.work_can_value(p_task uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from task t where t.org_id=current_org() and t.id=p_task and current_viewer() is not null
  and current_viewer() is distinct from coalesce(t.assignee_person_id,t.owner_id)
  and case when t.status='accepted' then viewer_is('admin','leadership') else viewer_is('admin','leadership','hr') or coalesce(manages(coalesce(t.assignee_person_id,t.owner_id)),false)
   or current_viewer() in (t.review_owner_id,t.created_by,t.pooled_by)
   or (t.project_id is not null and exists(select 1 from work_project wp where wp.org_id=current_org() and wp.project_id=t.project_id and wp.pod=any(work_head_pods()))) end)
$$;
-- p: valuePoints (1–100 or null), importance (low | normal | high | urgent), urgency (low | normal | high),
-- estimateMinutes, useSuggestion (take Pip's suggestion as it is).
create function pulse.task_value_set(p_task uuid,p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;s jsonb;v_points int;v_importance text;v_urgency text;v_estimate int;src text;
begin
 select * into t from task where org_id=current_org() and id=p_task for update;
 if not found or not task_visible(p_task) then raise exception 'Task not found' using errcode='P0002';end if;
 if not work_can_value(p_task) then raise exception 'Value is set by leadership, HR, the doer''s head, the reviewer or whoever created it; nobody values their own work' using errcode='42501';end if;
 s:=case when coalesce((p->>'useSuggestion')::boolean,false) then coalesce(t.ai_suggestion,'{}') else '{}' end;
 begin
  v_points:=case when p ? 'valuePoints' then nullif(p->>'valuePoints','')::int when s ? 'valuePoints' then (s->>'valuePoints')::int else t.value_points end;
  v_estimate:=case when p ? 'estimateMinutes' then nullif(p->>'estimateMinutes','')::int when s ? 'effortMinutes' then (s->>'effortMinutes')::int else t.estimate_minutes end;
 exception when others then raise exception 'Enter value points and minutes as numbers' using errcode='22023';end;
 v_importance:=case when p ? 'importance' then p->>'importance' when s ? 'importance' then s->>'importance' else t.priority end;
 v_urgency:=case when p ? 'urgency' then p->>'urgency' else t.urgency end;
 if v_points is not null and v_points not between 1 and 100 then raise exception 'Value points run from 1 to 100' using errcode='22023';end if;
 if v_estimate is not null and v_estimate not between 5 and 20000 then raise exception 'Estimate between 5 minutes and about 330 hours' using errcode='22023';end if;
 if v_importance not in ('low','normal','high','urgent') then raise exception 'Choose an importance' using errcode='22023';end if;
 if v_urgency not in ('low','normal','high') then raise exception 'Choose an urgency' using errcode='22023';end if;
 src:=case when viewer_is('admin','leadership','hr') or coalesce(manages(coalesce(t.assignee_person_id,t.owner_id)),false)
   or (t.project_id is not null and exists(select 1 from work_project wp where wp.project_id=t.project_id and wp.pod=any(work_head_pods()))) then 'leadership'
  when me=t.review_owner_id then 'reviewer' else 'creator' end;
 update task set value_points=v_points,estimate_minutes=v_estimate,priority=v_importance,urgency=v_urgency,
  value_source=case when v_points is distinct from t.value_points then case when v_points is null then null else src end else value_source end,
  value_by=case when v_points is distinct from t.value_points then me else value_by end,value_at=case when v_points is distinct from t.value_points then now() else value_at end,
  edited_by=me,updated_at=now() where id=p_task;
 if v_points is distinct from t.value_points then
  perform task_event_add(p_task,'valued',t.value_points::text,v_points::text,coalesce(case when coalesce((p->>'useSuggestion')::boolean,false) then 'Pip''s suggestion, confirmed' end,src));
 end if;
 return jsonb_build_object('valuePoints',v_points,'importance',v_importance,'urgency',v_urgency,'estimateMinutes',v_estimate,'source',src);
end $$;
-- Pip's suggestion (importance, value points, effort, a one-line reason) is kept beside the task for the creator or
-- leadership to confirm. With the company's low-value automatic acceptance on, a suggestion at or under its limit is
-- applied at once (value and estimate only).
create function pulse.task_suggestion_save(p_task uuid,p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;lim int;pts int;applied boolean:=false;
begin
 select * into t from task where org_id=current_org() and id=p_task for update;
 if not found or not task_visible(p_task) then raise exception 'Task not found' using errcode='P0002';end if;
 if not (task_can_edit(p_task) or t.created_by=me or work_can_value(p_task)) then raise exception 'Only the people on this task or leadership keep suggestions on it' using errcode='42501';end if;
 if jsonb_typeof(p)<>'object' or not (p ? 'valuePoints') or not (p ? 'reason') then raise exception 'A suggestion has value points and a reason' using errcode='22023';end if;
 begin pts:=(p->>'valuePoints')::int;exception when others then raise exception 'Value points are a number' using errcode='22023';end;
 if pts not between 1 and 100 then raise exception 'Value points run from 1 to 100' using errcode='22023';end if;
 update task set ai_suggestion=(p-'applied')||jsonb_build_object('at',now(),'by',me) where id=p_task;
 lim:=(select ai_auto_accept_max from work_settings where org_id=current_org());
 if lim is not null and t.value_points is null and pts<=lim then
  update task set value_points=pts,value_source='ai_auto',value_by=null,value_at=now(),
   estimate_minutes=coalesce(estimate_minutes,case when (p->>'effortMinutes') ~ '^\d+$' and (p->>'effortMinutes')::int between 5 and 20000 then (p->>'effortMinutes')::int end) where id=p_task;
  perform task_event_add(p_task,'valued',null,pts::text,'Pip''s suggestion, accepted automatically (low value)');
  applied:=true;
 end if;
 return jsonb_build_object('applied',applied,'valuePoints',pts);
end $$;

-- Credit follows acceptance: value points when they were set, else the reviewer's effort × impact. Reopening reverses it.
create function pulse.task_credit_follow() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare who uuid:=coalesce(new.assignee_person_id,new.owner_id);pts int:=least(100,coalesce(new.value_points,new.effort*new.impact,0));
begin
 if new.status='accepted' and old.status is distinct from 'accepted' and who is not null then
  insert into work_credit(org_id,task_id,person_id,points,basis,via,work_day)
  values(new.org_id,new.id,who,pts,case when new.value_points is not null then 'value' else 'rating' end,case when new.claimed_by=who then 'pool' else 'assigned' end,
   (coalesce(new.accepted_at,now()) at time zone 'Asia/Kolkata')::date)
  on conflict(org_id,task_id) where reversed_at is null do update set points=excluded.points,basis=excluded.basis,person_id=excluded.person_id,via=excluded.via;
 elsif old.status='accepted' and new.status<>'accepted' then
  update work_credit set reversed_at=now() where org_id=new.org_id and task_id=new.id and reversed_at is null;
 elsif new.status='accepted' then
  update work_credit set points=pts,basis=case when new.value_points is not null then 'value' else 'rating' end where org_id=new.org_id and task_id=new.id and reversed_at is null and points<>pts;
 end if;
 return null;
end $$;
create trigger task_credit_follow after update of status,value_points,effort,impact on pulse.task for each row execute function pulse.task_credit_follow();

-- Tasks: save with categories, tags, urgency, estimate and the pool; assignment follows domains ----------------------
create or replace function pulse.task_save(p_id uuid,p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;nid uuid;v_title text;v_assignee uuid;v_reviewer uuid;v_project uuid;v_parent uuid;v_due timestamptz;
 v_priority text;v_notes text;v_value text;v_label text;changed text[]:='{}';
 v_category text;v_tags text[];v_urgency text;v_estimate int;v_pool_scope text;v_pool_ref text;pooling boolean:=false;mode jsonb;r record;
begin
 if jsonb_typeof(p)<>'object' then raise exception 'Describe the task' using errcode='22023';end if;
 if p_id is not null then t:=task_for_edit(p_id);end if;
 v_title:=case when p ? 'title' then btrim(regexp_replace(p->>'title','\s+',' ','g')) else t.title end;
 if coalesce(v_title,'')='' or length(v_title)>300 then raise exception 'Name the task in up to 300 characters' using errcode='22023';end if;
 pooling:=jsonb_typeof(p->'pool')='object';
 v_assignee:=case when p ? 'assigneeId' then nullif(p->>'assigneeId','')::uuid when p_id is null then case when pooling then null else me end else t.assignee_person_id end;
 v_project:=case when p ? 'projectId' then nullif(p->>'projectId','')::uuid else t.project_id end;
 if v_project is not null and v_project is distinct from t.project_id and not exists(select 1 from project where org_id=current_org() and id=v_project) then raise exception 'Choose a project' using errcode='22023';end if;
 v_parent:=case when p ? 'parentId' then nullif(p->>'parentId','')::uuid else t.parent_id end;
 if v_parent is not null and v_parent is distinct from t.parent_id and not task_visible(v_parent) then raise exception 'Choose a parent task you can see' using errcode='22023';end if;
 if p_id is null and v_parent is not null and v_project is null then select project_id into v_project from task where id=v_parent;end if;
 v_category:=case when p ? 'category' then nullif(p->>'category','') else t.category end;
 if v_category is not null and v_category is distinct from t.category and not exists(select 1 from work_category where org_id=current_org() and key=v_category and active) then
  raise exception 'Choose a kind of work from the list' using errcode='22023';end if;
 if v_category is null and (p_id is null or v_title is distinct from t.title) and not (p ? 'category') then v_category:=work_category_guess(v_title);end if;
 v_tags:=case when p ? 'tags' then work_tags_clean(p->'tags') else coalesce(t.tags,'{}') end;
 v_urgency:=case when p ? 'urgency' then coalesce(nullif(p->>'urgency',''),'normal') else coalesce(t.urgency,'normal') end;
 if v_urgency not in ('low','normal','high') then raise exception 'Choose an urgency' using errcode='22023';end if;
 begin v_estimate:=case when p ? 'estimateMinutes' then nullif(p->>'estimateMinutes','')::int else t.estimate_minutes end;
 exception when others then raise exception 'Enter the estimate in minutes' using errcode='22023';end;
 if v_estimate is not null and v_estimate not between 5 and 20000 then raise exception 'Estimate between 5 minutes and about 330 hours' using errcode='22023';end if;
 v_pool_scope:=t.pool_scope;v_pool_ref:=t.pool_ref;
 if pooling then
  v_pool_scope:=p->'pool'->>'scope';v_pool_ref:=case when v_pool_scope='company' then null else nullif(btrim(coalesce(p->'pool'->>'ref','')),'') end;
  if v_pool_scope is null or v_pool_scope not in ('company','department','pod') or (v_pool_scope<>'company' and v_pool_ref is null) then raise exception 'Choose who the pool is for: the company, a department or a pod' using errcode='22023';end if;
  if v_assignee is not null then raise exception 'A task in the pool has nobody yet: leave Who empty' using errcode='22023';end if;
  if not work_can_pool(v_pool_scope,v_pool_ref) then raise exception 'Leadership and HR put tasks in any pool; pod heads in their pod''s or department''s' using errcode='42501';end if;
 elsif p ? 'pool' and t.id is not null and t.pool_scope is not null and t.assignee_person_id is null then
  -- Taking a task out of the pool is for whoever may pool there, or whoever put it there.
  if not (work_can_pool(t.pool_scope,t.pool_ref) or me in (t.pooled_by,t.created_by)) then raise exception 'Only whoever put it in the pool, HR or leadership takes it out' using errcode='42501';end if;
  v_pool_scope:=null;v_pool_ref:=null;
 end if;
 if v_assignee is not null and v_assignee is distinct from t.assignee_person_id then
  if not task_person_ok(v_assignee) then raise exception 'Choose an active team member' using errcode='22023';end if;
  mode:=work_assign_mode(v_assignee,v_project,v_category,v_tags);
  if mode->>'mode' not in ('self','direct') then
   if mode->>'why'='outside_domains' then raise exception 'This is outside %''s domains: send a request to join instead',work_first_name(v_assignee) using errcode='42501';end if;
   raise exception 'You can give tasks to your own pod. Leadership, HR and admins can give tasks to anyone.' using errcode='42501';
  end if;
 end if;
 v_reviewer:=case when p ? 'reviewerId' then nullif(p->>'reviewerId','')::uuid when p_id is null then
  case when v_assignee is null or me<>v_assignee then me else coalesce(hr_head(v_assignee),(select manager_id from people_profile where person_id=v_assignee)) end else t.review_owner_id end;
 if v_reviewer is not null and v_reviewer is distinct from t.review_owner_id and not task_person_ok(v_reviewer) then raise exception 'Choose an active reviewer' using errcode='22023';end if;
 if v_reviewer=v_assignee and p ? 'reviewerId' then raise exception 'Choose a reviewer other than the person doing the task' using errcode='22023';end if;
 if v_reviewer=v_assignee then v_reviewer:=null;end if;
 v_due:=case when p ? 'dueOn' or p ? 'dueAt' then task_due_from(p) else t.due_at end;
 -- A typed deadline replaces the tracker's free-text label; a label can still be given on its own ("end of month").
 v_label:=case when p ? 'dueLabel' then left(nullif(btrim(p->>'dueLabel'),''),120) when v_due is distinct from t.due_at then null else t.due_label end;
 v_priority:=case when p ? 'priority' then p->>'priority' else coalesce(t.priority,'normal') end;
 if v_priority not in ('low','normal','high','urgent') then raise exception 'Choose a priority' using errcode='22023';end if;
 v_notes:=case when p ? 'notes' then nullif(btrim(p->>'notes'),'') else t.notes end;
 v_value:=case when p ? 'valueNote' then nullif(btrim(p->>'valueNote'),'') else t.value_note end;
 if length(v_notes)>4000 or length(v_value)>1000 then raise exception 'Keep notes under 4,000 characters' using errcode='22023';end if;
 if p_id is null then
  insert into task(org_id,title,status,project_id,parent_id,owner_id,assignee_person_id,review_owner_id,due_at,due_label,priority,notes,value_note,source,created_by,created_at,edited_by,updated_at,assigned_at,locked,
   category,tags,urgency,estimate_minutes,pool_scope,pool_ref,pooled_at,pooled_by)
  values(current_org(),v_title,'open',v_project,v_parent,v_assignee,v_assignee,v_reviewer,v_due,v_label,v_priority,v_notes,v_value,'pulse',me,now(),me,now(),case when v_assignee is not null then now() end,'{title,status,owner_id,project_id,due_label}',
   v_category,v_tags,v_urgency,v_estimate,v_pool_scope,v_pool_ref,case when pooling then now() end,case when pooling then me end)
  returning id into nid;
  perform task_event_add(nid,'created',null,v_title);
  if v_assignee is not null and v_assignee<>me then perform task_event_add(nid,'assigned',null,(select display_name from person where id=v_assignee));end if;
  if pooling then
   perform task_event_add(nid,'pooled',null,coalesce(v_pool_ref,'Company'));
   -- People whose domains it fits hear about it (a few, never the whole company).
   for r in select distinct d.person_id from work_domain d where d.org_id=current_org() and d.status='active' and d.person_id<>me
    and work_pool_eligible_for(d.person_id,v_pool_scope,v_pool_ref) and work_domain_match(d.person_id,v_project,v_category,v_tags) is not null limit 25 loop
    perform work_notify(r.person_id,'pool.match','task',nid,nid||':pool',work_first_name(me)||' put “'||left(v_title,90)||'” in the pool: it fits your domains','/tasks?view=pool&task='||nid,'task');
   end loop;
  end if;
  perform audit_write('create','task',nid::text);
  return nid;
 end if;
 if v_title is distinct from t.title then changed:=changed||'title'::text;end if;
 if v_assignee is distinct from t.assignee_person_id then changed:=changed||'owner_id'::text;
  perform task_event_add(p_id,'assigned',(select display_name from person where id=t.assignee_person_id),coalesce((select display_name from person where id=v_assignee),'Anyone'));end if;
 if v_reviewer is distinct from t.review_owner_id then perform task_event_add(p_id,'reviewer',(select display_name from person where id=t.review_owner_id),(select display_name from person where id=v_reviewer));end if;
 if v_project is distinct from t.project_id then changed:=changed||'project_id'::text;end if;
 if v_parent is distinct from t.parent_id then perform task_event_add(p_id,'moved',null,(select title from task where id=v_parent));end if;
 if v_due is distinct from t.due_at or v_label is distinct from t.due_label then changed:=changed||'due_label'::text;end if;
 if pooling and (v_pool_scope,v_pool_ref) is distinct from (t.pool_scope,t.pool_ref) then perform task_event_add(p_id,'pooled',t.pool_ref,coalesce(v_pool_ref,'Company'));end if;
 if v_title is distinct from t.title or v_project is distinct from t.project_id or v_due is distinct from t.due_at or v_label is distinct from t.due_label or v_priority is distinct from t.priority or v_notes is distinct from t.notes or v_value is distinct from t.value_note
  or v_category is distinct from t.category or v_tags is distinct from t.tags or v_urgency is distinct from t.urgency or v_estimate is distinct from t.estimate_minutes then
  perform task_event_add(p_id,'edited',null,null);end if;
 update task set title=v_title,assignee_person_id=v_assignee,owner_id=v_assignee,review_owner_id=v_reviewer,project_id=v_project,parent_id=v_parent,due_at=v_due,
  due_label=v_label,priority=v_priority,notes=v_notes,value_note=v_value,category=v_category,tags=v_tags,urgency=v_urgency,estimate_minutes=v_estimate,
  pool_scope=v_pool_scope,pool_ref=v_pool_ref,pooled_at=case when pooling and (v_pool_scope,v_pool_ref) is distinct from (t.pool_scope,t.pool_ref) then now() else pooled_at end,
  pooled_by=case when pooling and (v_pool_scope,v_pool_ref) is distinct from (t.pool_scope,t.pool_ref) then me else pooled_by end,
  assigned_at=case when v_assignee is distinct from t.assignee_person_id then now() else assigned_at end,
  edited_by=me,updated_at=now(),locked=array(select distinct unnest(locked||changed)) where id=p_id;
 return p_id;
end $$;

-- Visibility: open pool tasks are seen by the people who may claim them. Editing a pool task is for whoever may pool
-- there (everyone else claims it). task_visible_ids() stays equal to task_visible_row() (tests hold them together).
create or replace function pulse.task_visible_row(p_id uuid,p_owner uuid,p_assignee uuid,p_reviewer uuid,p_creator uuid,p_project uuid,p_parent uuid)
 returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (viewer_is('admin','leadership','hr')
 or current_viewer() in (p_owner,p_assignee,p_reviewer,p_creator)
 or exists(select 1 from task_member m where m.org_id=current_org() and m.task_id=p_id and m.person_id=current_viewer() and m.removed_at is null)
 or exists(select 1 from work_ask a where a.org_id=current_org() and a.task_id=p_id and a.to_id=current_viewer() and a.status='pending')
 or coalesce(manages(p_owner),false) or coalesce(manages(p_assignee),false)
 or exists(select 1 from people_profile me join people_profile them on them.org_id=me.org_id and them.pod=me.pod
  where me.org_id=current_org() and me.person_id=current_viewer() and me.pod is not null and them.person_id=coalesce(p_assignee,p_owner,p_creator))
 or exists(select 1 from project pr join role_assignment r on r.unit_id=pr.unit_id where pr.id=p_project and r.person_id=current_viewer()
  and (r.is_manager_of_unit or r.role_key in ('manager','pgs','head_pgs')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity'))
 or work_project_in(p_project)
 or exists(select 1 from task_link l join task b on b.id=l.task_id where l.org_id=current_org() and l.blocker_id=p_id and l.cleared_at is null
  and current_viewer() in (b.owner_id,b.assignee_person_id,b.review_owner_id,b.created_by))
 or exists(select 1 from task_link l join task b on b.id=l.blocker_id where l.org_id=current_org() and l.task_id=p_id and l.cleared_at is null
  and current_viewer() in (b.owner_id,b.assignee_person_id))
 or exists(select 1 from task par where par.org_id=current_org() and par.id=p_parent and current_viewer() in (par.owner_id,par.assignee_person_id,par.review_owner_id,par.created_by))
 or (p_owner is null and p_assignee is null and exists(select 1 from task x where x.org_id=current_org() and x.id=p_id and x.pool_scope is not null
  and x.status not in ('done','accepted','cancelled','in_review') and work_pool_eligible(x.pool_scope,x.pool_ref))))
$$;
create or replace function pulse.task_visible_ids() returns setof uuid language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare v uuid:=current_viewer();
begin
 if v is null then return;end if;
 if viewer_is('admin','leadership','hr') then return query select t.id from task t where t.org_id=current_org();return;end if;
 return query
 with mine as (select t.id from task t where t.org_id=current_org() and v in (t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by)),
 managed as (select pp.person_id p from people_profile pp where pp.org_id=current_org() and pp.person_id<>v and manages(pp.person_id)),
 podmates as (select them.person_id p from people_profile self join people_profile them on them.org_id=self.org_id and them.pod=self.pod
  where self.org_id=current_org() and self.person_id=v and self.pod is not null),
 unit_projects as (select pr.id from project pr join role_assignment r on r.unit_id=pr.unit_id where pr.org_id=current_org() and r.person_id=v
  and (r.is_manager_of_unit or r.role_key in ('manager','pgs','head_pgs')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity')),
 in_projects as (select m.project_id id from project_member m where m.org_id=current_org() and m.person_id=v and m.left_at is null
  union select wp.project_id from work_project wp where wp.org_id=current_org() and (wp.owner_id=v or (wp.pod is not null and wp.pod=any(work_head_pods()))))
 select mine.id from mine
 union select m.task_id from task_member m where m.org_id=current_org() and m.person_id=v and m.removed_at is null
 union select a.task_id from work_ask a where a.org_id=current_org() and a.to_id=v and a.status='pending' and a.task_id is not null
 union select t.id from task t where t.org_id=current_org() and (t.owner_id in (select p from managed) or t.assignee_person_id in (select p from managed)
  or coalesce(t.assignee_person_id,t.owner_id,t.created_by) in (select p from podmates)
  or t.project_id in (select id from unit_projects) or t.project_id in (select id from in_projects) or t.parent_id in (select id from mine))
 union select l.blocker_id from task_link l join task b on b.id=l.task_id where l.org_id=current_org() and l.cleared_at is null and v in (b.owner_id,b.assignee_person_id,b.review_owner_id,b.created_by)
 union select l.task_id from task_link l join task b on b.id=l.blocker_id where l.org_id=current_org() and l.cleared_at is null and v in (b.owner_id,b.assignee_person_id)
 union select t.id from task t where t.org_id=current_org() and t.pool_scope is not null and t.assignee_person_id is null and t.owner_id is null
  and t.status not in ('done','accepted','cancelled','in_review') and work_pool_eligible(t.pool_scope,t.pool_ref);
end $$;
create or replace function pulse.task_can_edit(p_id uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from task t where t.org_id=current_org() and t.id=p_id and current_viewer() is not null and (viewer_is('admin','leadership','hr')
 or current_viewer() in (t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by)
 or coalesce(manages(t.assignee_person_id),false) or coalesce(manages(t.owner_id),false)
 or exists(select 1 from task_member m where m.org_id=current_org() and m.task_id=t.id and m.person_id=current_viewer() and m.role='collaborator' and m.removed_at is null)
 or (t.project_id is not null and work_project_can_manage(t.project_id))
 or (t.assignee_person_id is null and t.owner_id is null and (t.pool_scope is null or current_viewer()=t.pooled_by or work_can_pool(t.pool_scope,t.pool_ref))
  and task_visible_row(t.id,t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by,t.project_id,t.parent_id))))
$$;

-- Links between a client project and the projects that deliver it ------------------------------------------------
-- Suggestions from what EA already has: an internal project's Drive folder inside the package's folder, its name
-- carrying the package's or the client's name, tracker rows that name the package, and (as support only) the same
-- people credited on both from one tracker (PEOPLE-LIVE). Never links on its own; linked and dismissed rows stay.
create function pulse.work_link_suggest() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n_new int;n_upd int;
begin
 if current_viewer() is not null and not viewer_is('admin','leadership') then raise exception 'Leadership and admins look for links' using errcode='42501';end if;
 with internal as (select p.id,coalesce(p.title,p.name) t,nullif(p.storage_root,'') root from project p where p.org_id=current_org() and p.kind='internal' and p.status<>'cancelled'
   and not exists(select 1 from record_merge rm where rm.org_id=p.org_id and rm.entity_type='project' and rm.gone_id=p.id and rm.undone_at is null)),
 pkg as (select p.id,coalesce(p.title,p.name) t,nullif(p.storage_root,'') root,nullif(btrim(c.display_name),'') client,p.start_month from project p left join client c on c.id=p.client_id and c.client_type<>'internal'
   where p.org_id=current_org() and p.kind='client_work' and p.status<>'cancelled'
   and not exists(select 1 from record_merge rm where rm.org_id=p.org_id and rm.entity_type='project' and rm.gone_id=p.id and rm.undone_at is null)),
 ev as (
  select pk.id pkg,i.id prj,0.9::numeric w,jsonb_build_object('kind','drive','text','Its Drive folder sits inside this client project’s folder','detail',substr(i.root,length(pk.root)+2)) e
   from internal i join pkg pk on pk.root is not null and i.root is not null and length(pk.root)>=12 and starts_with(i.root,pk.root||'/')
  union all
  select pk.id,i.id,0.6,jsonb_build_object('kind','name','text','Its name carries “'||pk.t||'”')
   from internal i join pkg pk on length(btrim(pk.t))>=5 and lower(i.t)<>lower(btrim(pk.t)) and lower(i.t) ~ ('\m'||work_re_escape(lower(btrim(pk.t)))||'\M')
  union all
  select pk.id,i.id,0.5,jsonb_build_object('kind','name','text','Its name carries the client “'||pk.client||'”')
   from internal i join pkg pk on length(coalesce(pk.client,''))>=5 and lower(i.t) ~ ('\m'||work_re_escape(lower(pk.client))||'\M')
  union all
  select pk.id,x.project_id,0.6,jsonb_build_object('kind','tracker','text',x.n||' tracker row'||case when x.n=1 then '' else 's' end||' name “'||x.k||'”')
   from (select t.project_id,min(t.project_key) k,lower(btrim(t.project_key)) lk,count(*) n from task t join internal i on i.id=t.project_id
    where t.org_id=current_org() and coalesce(btrim(t.project_key),'')<>'' group by 1,3) x
   join pkg pk on x.lk in (lower(btrim(pk.t)),lower(coalesce(pk.client,'')))
  union all
  select a.project_id,b.project_id,0.2,jsonb_build_object('kind','people','text',count(distinct a.person_id)||' of the same people work on both in “'||min(a.group_label)||'”')
   from people_work_link a join people_work_link b on b.org_id=a.org_id and b.group_key=a.group_key and b.person_id=a.person_id and b.kind='project'
    and b.status in ('accepted','suggested') and b.retired_at is null
   where a.org_id=current_org() and a.kind='project' and a.status in ('accepted','suggested') and a.retired_at is null
    and a.project_id in (select id from pkg) and b.project_id in (select id from internal)
   group by a.project_id,b.project_id),
 scored as (select pkg,prj,least(0.99,1-exp(sum(ln(1-w))))::numeric(3,2) conf,jsonb_agg(e order by w desc) evidence,(array_agg(e->>'kind' order by w desc))[1] src
   from ev group by pkg,prj having 1-exp(sum(ln(1-w)))>=0.5),
 ranked as (select s.*,row_number() over(partition by s.prj order by s.conf desc,pk.start_month desc nulls last,s.pkg) r from scored s join pkg pk on pk.id=s.pkg),
 saved as (insert into work_project_link(org_id,client_project_id,project_id,status,source,confidence,evidence)
  select current_org(),pkg,prj,'suggested',src,conf,evidence from ranked where r<=3
  on conflict(org_id,client_project_id,project_id) do update set confidence=excluded.confidence,evidence=excluded.evidence,source=excluded.source,updated_at=now()
   where work_project_link.status='suggested' and (work_project_link.evidence is distinct from excluded.evidence or work_project_link.confidence is distinct from excluded.confidence)
  returning (xmax=0) fresh)
 select count(*) filter(where fresh),count(*) filter(where not fresh) into n_new,n_upd from saved;
 return jsonb_build_object('suggested',n_new,'refreshed',n_upd,'pending',(select count(*) from work_project_link where org_id=current_org() and status='suggested'));
end $$;
create function pulse.work_link_decide(p_id uuid,p_decision text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare l work_project_link;
begin
 if current_viewer() is null or not viewer_is('admin','leadership') then raise exception 'Leadership decides what a client project includes' using errcode='42501';end if;
 if p_decision not in ('link','dismiss') then raise exception 'Choose link or not related' using errcode='22023';end if;
 select * into l from work_project_link where org_id=current_org() and id=p_id for update;
 if not found then raise exception 'Suggestion not found' using errcode='P0002';end if;
 update work_project_link set status=case when p_decision='link' then 'linked' else 'dismissed' end,decided_by=current_viewer(),decided_at=now(),updated_at=now() where id=p_id;
 perform audit_write('work_link_'||p_decision,'project',l.client_project_id::text);
 return jsonb_build_object('status',case when p_decision='link' then 'linked' else 'dismissed' end);
end $$;
-- Link (or unlink) by hand: leadership, or whoever manages the project being placed under the client project.
create function pulse.work_link_set(p_client_project uuid,p_project uuid,p_on boolean) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();lid uuid;
begin
 if not exists(select 1 from project where org_id=current_org() and id=p_client_project and kind='client_work') then raise exception 'Choose a client project' using errcode='22023';end if;
 if not exists(select 1 from work_project wp join project pr on pr.id=wp.project_id where wp.org_id=current_org() and wp.project_id=p_project and pr.kind='internal') then
  raise exception 'Choose one of the company’s projects to place under it' using errcode='22023';end if;
 if not (viewer_is('admin','leadership') or work_project_can_manage(p_project)) then raise exception 'Leadership or the project’s owner places it under a client project' using errcode='42501';end if;
 insert into work_project_link(org_id,client_project_id,project_id,status,source,confidence,created_by,decided_by,decided_at)
 values(current_org(),p_client_project,p_project,case when p_on then 'linked' else 'dismissed' end,'manual',1,me,me,now())
 on conflict(org_id,client_project_id,project_id) do update set status=excluded.status,decided_by=me,decided_at=now(),updated_at=now() returning id into lid;
 perform audit_write(case when p_on then 'work_link_add' else 'work_link_remove' end,'project',p_client_project::text);
 return lid;
end $$;
-- The seam for automatic capture through the admin Google connection: a collector (the worker, or an admin's import)
-- hands in a suggestion with its evidence; it waits for leadership like any other and never links by itself.
-- p: clientProjectId, projectId, confidence (0–1), evidence [{kind, text, ref?}].
create function pulse.work_link_capture(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_pkg uuid;v_prj uuid;v_conf numeric;v_ev jsonb;lid uuid;
begin
 if current_viewer() is not null and not viewer_is('admin') then raise exception 'Admins or the Google collector capture links' using errcode='42501';end if;
 begin v_pkg:=(p->>'clientProjectId')::uuid;v_prj:=(p->>'projectId')::uuid;v_conf:=least(0.95,greatest(0.05,coalesce((p->>'confidence')::numeric,0.6)));
 exception when others then raise exception 'Name the client project and the project' using errcode='22023';end;
 if not exists(select 1 from project where org_id=current_org() and id=v_pkg and kind='client_work') or not exists(select 1 from project where org_id=current_org() and id=v_prj and kind='internal') then
  raise exception 'Name a client project and one of the company’s projects' using errcode='22023';end if;
 v_ev:=coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('kind','google','text',left(e->>'text',300),'ref',left(e->>'ref',300)))) from jsonb_array_elements(coalesce(p->'evidence','[]')) e
  where jsonb_typeof(e)='object' and length(btrim(coalesce(e->>'text','')))>0),'[]');
 if jsonb_array_length(v_ev) not between 1 and 10 then raise exception 'Give one to ten pieces of evidence' using errcode='22023';end if;
 insert into work_project_link(org_id,client_project_id,project_id,status,source,confidence,evidence,created_by) values(current_org(),v_pkg,v_prj,'suggested','google',v_conf,v_ev,current_viewer())
 on conflict(org_id,client_project_id,project_id) do update set evidence=excluded.evidence,confidence=greatest(work_project_link.confidence,excluded.confidence),updated_at=now()
  where work_project_link.status='suggested' returning id into lid;
 return coalesce(lid,(select id from work_project_link where org_id=current_org() and client_project_id=v_pkg and project_id=v_prj));
end $$;

-- Notifications: domain proposals, answers, policies and endings; pool claims and pool tasks that fit someone ------
alter table pulse.notification drop constraint notification_event_type_check;
alter table pulse.notification add constraint notification_event_type_check check(event_type in ('update.self','chat.message','chat.mention','chat.reply','policy.published','holiday.announced',
 'task.assigned','task.blocked','task.unblocked','task.due_soon','task.done','task.accepted','task.ask','project.ask','ask.answered',
 'task.mention','project.mention','task.comment','project.comment','project.added','task.update',
 'domain.proposed','domain.answered','domain.policy','domain.ended','pool.claimed','pool.match',
 'leave.decision','request.updated','request.decision','approval.waiting','approval.reminder',
 'payroll.processed','attendance.start','attendance.end','attendance.done','attendance.departure','attendance.confirmed',
 'attendance.arrival','attendance.break','attendance.nudge','profile.reminder'));
alter table pulse.notification drop constraint notification_subject_type_check;
alter table pulse.notification add constraint notification_subject_type_check check(subject_type in ('person','message','hr_flow','task','policy','holiday','payroll_notice','project','work_ask','comment','work_domain'));
do $$
declare definition text;changed text;
begin
 definition:=pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
 changed:=replace(definition,' elsif p_type=''policy.published'' then',
 ' elsif p_type in (''domain.proposed'',''domain.answered'',''domain.policy'',''domain.ended'') then
  return p_subject=''work_domain'' and exists(select 1 from work_domain d where d.org_id=current_org() and d.id=p_id and (
   (p_type=''domain.proposed'' and d.status=''proposed'' and ((d.proposed_side=''company'' and d.person_id=p_person)
    or (d.proposed_side=''employee'' and d.person_id<>p_person and (hr_head(d.person_id)=p_person or hr_is_staff(p_person)))))
   or (p_type=''domain.answered'' and d.proposed_by=p_person and d.status in (''active'',''declined''))
   or (p_type=''domain.policy'' and d.basis=''policy'' and d.person_id=p_person)
   or (p_type=''domain.ended'' and d.status=''ended'' and p_person in (d.person_id,d.proposed_by,coalesce(d.company_agreed_by,d.person_id),coalesce(hr_head(d.person_id),d.person_id)))));
 elsif p_type=''pool.claimed'' then
  return p_subject=''task'' and exists(select 1 from task where org_id=current_org() and id=p_id and claimed_by is not null and coalesce(pooled_by,created_by)=p_person);
 elsif p_type=''pool.match'' then
  return p_subject=''task'' and exists(select 1 from task t where t.org_id=current_org() and t.id=p_id and t.pool_scope is not null and t.assignee_person_id is null and t.owner_id is null
   and t.status in (''open'',''unknown'') and work_pool_eligible_for(p_person,t.pool_scope,t.pool_ref) and work_domain_match(p_person,t.project_id,t.category,t.tags) is not null);
 elsif p_type=''policy.published'' then');
 if changed=definition then raise exception 'notification_recipient_allowed changed shape';end if;
 execute changed;
end $$;

-- The migration: categories for every company, existing tasks sorted, credits for work already accepted, link
-- suggestions from the data already there. Idempotent per tenant.
do $$ declare o uuid;previous_org text:=current_setting('pulse.org_id',true);begin
 for o in select id from pulse.org loop
  perform set_config('pulse.org_id',o::text,true);
  perform pulse.work_category_seed();
  perform pulse.task_category_backfill();
  insert into pulse.work_credit(org_id,task_id,person_id,points,basis,via,work_day)
  select t.org_id,t.id,coalesce(t.assignee_person_id,t.owner_id),least(100,coalesce(t.value_points,t.effort*t.impact,0)),case when t.value_points is not null then 'value' else 'rating' end,'assigned',
   (coalesce(t.accepted_at,t.done_at,t.updated_at,now()) at time zone 'Asia/Kolkata')::date
  from pulse.task t where t.org_id=o and t.status='accepted' and coalesce(t.assignee_person_id,t.owner_id) is not null
  on conflict do nothing;
  perform pulse.work_link_suggest();
 end loop;
 perform set_config('pulse.org_id',coalesce(previous_org,''),true);
end $$;

revoke all on function pulse.work_settings_get(),pulse.work_settings_set(jsonb),pulse.work_category_seed(),pulse.work_category_follow_org(),pulse.work_category_guess(text),pulse.work_re_escape(text),pulse.work_category_save(jsonb),
 pulse.task_category_default(),pulse.task_category_backfill(),pulse.work_tags_clean(jsonb),pulse.work_domain_company(uuid),pulse.work_domain_match(uuid,uuid,text,text[]),pulse.work_domain_fields(jsonb),
 pulse.work_domain_propose(uuid,jsonb),pulse.work_domain_answer(uuid,boolean,text),pulse.work_domain_withdraw(uuid),pulse.work_domain_end(uuid,text),pulse.work_assign_mode(uuid,uuid,text,text[]),
 pulse.work_can_pool(text,text),pulse.work_pool_eligible_for(uuid,text,text),pulse.work_pool_eligible(text,text),pulse.work_pool_claim(uuid),pulse.work_pool_release(uuid,text),
 pulse.work_can_value(uuid),pulse.task_value_set(uuid,jsonb),pulse.task_suggestion_save(uuid,jsonb),pulse.task_credit_follow(),pulse.work_link_suggest(),pulse.work_link_decide(uuid,text),
 pulse.work_link_set(uuid,uuid,boolean),pulse.work_link_capture(jsonb) from public;
grant execute on function pulse.work_settings_get(),pulse.work_settings_set(jsonb),pulse.work_category_guess(text),pulse.work_category_save(jsonb),pulse.task_category_backfill(),
 pulse.work_domain_company(uuid),pulse.work_domain_match(uuid,uuid,text,text[]),pulse.work_domain_propose(uuid,jsonb),pulse.work_domain_answer(uuid,boolean,text),pulse.work_domain_withdraw(uuid),
 pulse.work_domain_end(uuid,text),pulse.work_assign_mode(uuid,uuid,text,text[]),pulse.work_can_pool(text,text),pulse.work_pool_eligible(text,text),pulse.work_pool_claim(uuid),
 pulse.work_pool_release(uuid,text),pulse.work_can_value(uuid),pulse.task_value_set(uuid,jsonb),pulse.task_suggestion_save(uuid,jsonb),pulse.work_link_suggest(),pulse.work_link_decide(uuid,text),
 pulse.work_link_set(uuid,uuid,boolean),pulse.work_link_capture(jsonb) to pulse_api;
grant execute on function pulse.work_settings_get(),pulse.work_category_seed(),pulse.work_category_guess(text),pulse.task_category_backfill(),pulse.work_domain_match(uuid,uuid,text,text[]),
 pulse.work_pool_eligible_for(uuid,text,text),pulse.work_link_suggest(),pulse.work_link_capture(jsonb) to pulse_worker;
-- migrate:down
-- Forward-only: domains, credits, links and settings are company records and are never dropped.

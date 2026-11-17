-- migrate:up
-- PROFILE-2 (owner, 17 Nov 2026): "My profile looks extremely idiotic" ... "EA Sales Test, Savuzo HQ, Pulse Demo and
-- Pulse should not be on my profile; I want them deleted and wiped" ... "a skills database (like LinkedIn's)".
--
--  1. A profile names real, active companies only. account_career_of (the roles, career and resume) and the
--     profile's "What each company sees" list leave out archived, merged, suspended, test and demo organisations and
--     personal spaces (a test company still lists itself while it is the one open, so it can be managed there).
--  2. pulse.platform_org_retire(org, accounts, reason): a platform admin retires a test, demo or suspended company:
--     status archived, purpose test, its sign-ins ended, and the named accounts' seats ended the way leaving a company
--     ends one (person inactive, a person-record change, an alumni row, an account_leave note in its Audit), without
--     the "last admin" stop (nobody runs a retired company). A real, active company, the install's own, a personal
--     space and a merged organisation (undone with org_merge_undo) are refused. What it changed is kept in
--     pulse.org_retired (forced RLS, the company's own rows) so pulse.platform_org_restore(org, reason) puts it back:
--     the status and purpose it had, every ended seat. Both write the platform log and the company's Audit.
--     Nothing is deleted here: the hard wipe waits for the owner's final yes (orchestrator.from-profile-2.md).
--  3. The skills library: one install-wide list to pick skills from (type-ahead), with suggestions from the person's
--     role and the company's industry, and custom skills still allowed. pulse_priv.skill_library_source records each
--     list's licence and attribution; pulse_priv.skill_library holds the skills (Pulse's own starting list below;
--     O*NET 30.0's technology skills, skills and knowledge areas by the import tool, CC BY 4.0);
--     skill_library_role holds job titles that point at an occupation and skill_library_link what that occupation
--     uses. Reference data, the same for every company: owner-only like the account tables (no runtime grants,
--     reached only through the SECURITY DEFINER functions below; listed in the isolation test's reviewed list).
--     A person's skills stay their own words (account_profile.skills, people_profile.skills) and now also carry
--     skill_refs: each label's library id where it is one (null for a custom skill), kept by a trigger on every
--     write, so resumes and matching can use them.

-- 1 -----------------------------------------------------------------------------------------------------------------
create or replace function pulse.account_career_of(p_account uuid, p_public boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o text := coalesce(current_setting('pulse.org_id', true), ''); vw text := coalesce(current_setting('pulse.viewer_id', true), '');
  s record; r record; out jsonb := '[]'::jsonb; item jsonb; seen uuid[] := '{}';
begin
  for s in
    select am.member_org org, am.person_id person, am.kind, am.joined_at, null::timestamptz left_at, null::text how, null::uuid moved_to, true current
      from pulse_priv.account_member am join org g0 on g0.id = am.member_org and g0.status = 'active' and g0.purpose = 'work' and g0.kind = 'company' where am.account_id = p_account
    union all
    select al.org_id, al.person_id, al.kind, al.joined_at, al.left_at, al.how, al.moved_to, false
      from pulse.account_alumni al join org g1 on g1.id = al.org_id and g1.status = 'active' and g1.purpose = 'work' and g1.kind = 'company' where al.account_id = p_account
    limit 40
  loop
    if s.person = any(seen) then continue; end if;
    seen := seen || s.person;
    perform set_config('pulse.org_id', s.org::text, true);
    perform set_config('pulse.viewer_id', '', true);
    select g.name, coalesce(g.handle, g.slug) handle, p.status, p.active_from, p.active_to, pp.role, pp.department, pp.joined_on, pp.employment_type
      into r from org g join person p on p.id = s.person left join people_profile pp on pp.person_id = p.id where g.id = s.org;
    item := jsonb_build_object('org', s.org, 'company', r.name, 'handle', r.handle, 'kind', s.kind, 'role', r.role,
      'from', coalesce(r.joined_on, r.active_from, s.joined_at::date),
      'to', case when s.current and r.status = 'active' then null else coalesce(r.active_to, s.left_at::date) end,
      'current', s.current and r.status = 'active', 'how', s.how,
      'movedTo', (select name from org where id = s.moved_to));
    if not p_public then
      item := item || jsonb_build_object('team', r.department, 'employment', r.employment_type,
        'tasksDone', (select count(*) from task t where t.org_id = s.org and t.assignee_person_id = s.person and t.status in ('done', 'accepted') and t.deleted_at is null),
        'projects', (select count(distinct t.project_id) from task t where t.org_id = s.org and t.assignee_person_id = s.person and t.project_id is not null and t.deleted_at is null),
        'deliveries', (select count(*) from delivery d where d.org_id = s.org and d.uploader_account in (select ac.handle from account ac where ac.org_id = s.org and ac.holder_person_id = s.person)),
        'highlights', coalesce((select jsonb_agg(jsonb_build_object('title', h.title, 'detail', h.detail, 'on', h.on_date) order by coalesce(h.on_date, h.created_at::date) desc)
          from pulse_priv.account_highlight h where h.account_id = p_account and h.from_org = s.org), '[]'::jsonb),
        'badges', coalesce((select jsonb_agg(jsonb_build_object('title', b.title, 'note', b.note, 'by', b.given_by_name, 'on', b.earned_on) order by b.earned_on desc)
          from pulse_priv.account_badge b where b.account_id = p_account and b.from_org = s.org), '[]'::jsonb),
        'contracts', coalesce((select jsonb_agg(jsonb_build_object('key', c.contract_key, 'title', c.title, 'kind', c.kind, 'status', c.status, 'role', cp.role,
            'startsOn', c.starts_on, 'endsOn', coalesce(c.ended_on, c.ends_on)) order by c.updated_at desc)
          from contract c join contract_party cp on cp.org_id = c.org_id and cp.contract_id = c.id
          where c.org_id = s.org and c.status <> 'draft' and (cp.party_person_id = s.person or cp.party_account = p_account)), '[]'::jsonb));
    end if;
    out := out || jsonb_build_array(item);
  end loop;
  perform set_config('pulse.org_id', o, true);
  perform set_config('pulse.viewer_id', vw, true);
  return (select coalesce(jsonb_agg(x order by (x ->> 'current')::boolean desc, x ->> 'from' desc nulls last), '[]'::jsonb) from jsonb_array_elements(out) x);
end $$;


-- 3 (first: account_profile_get below reads skill_refs_of) -----------------------------------------------------------
create table pulse_priv.skill_library_source (
  id           text primary key check (id ~ '^[a-z0-9][a-z0-9._-]{1,40}$'),
  name         text not null check (length(btrim(name)) between 2 and 120),
  version      text not null check (length(btrim(version)) between 1 and 40),
  licence      text not null check (length(btrim(licence)) between 3 and 300),
  attribution  text not null check (length(btrim(attribution)) between 10 and 600),
  adapted      text not null check (length(btrim(adapted)) between 10 and 600),
  source_url   text check (source_url ~ '^https://\S+$' and length(source_url) <= 300),
  file_sha256  text check (file_sha256 ~ '^[0-9a-f]{64}$'),
  counts       jsonb not null default '{}' check (jsonb_typeof(counts) = 'object'),
  imported_by  text,
  imported_at  timestamptz not null default now()
);
create table pulse_priv.skill_library (
  id          text primary key check (length(id) between 3 and 200),
  source      text not null references pulse_priv.skill_library_source(id),
  kind        text not null check (kind in ('skill', 'software', 'knowledge')),
  label       text not null check (length(btrim(label)) between 1 and 120),
  label_key   text not null check (length(label_key) between 1 and 120),
  code        text check (length(code) <= 60),           -- the source's own code (O*NET element or commodity)
  category    text check (length(category) <= 120),      -- e.g. O*NET's commodity title ("Video creation and editing software")
  industries  text[] not null default '{}',
  roles       text[] not null default '{}',               -- words in a job title that suggest it (Pulse's own list)
  weight      real not null default 0,                  -- how widely it is used (occupations that list it)
  hot         boolean not null default false,
  retired_at  timestamptz
);
create unique index skill_library_label on pulse_priv.skill_library(label_key) where retired_at is null;
create index skill_library_label_trgm on pulse_priv.skill_library using gin (label_key public.gin_trgm_ops);
create table pulse_priv.skill_library_role (
  occupation  text not null check (length(occupation) between 2 and 20),
  title       text not null check (length(btrim(title)) between 1 and 160),
  title_key   text not null check (length(title_key) between 1 and 160),
  source      text not null references pulse_priv.skill_library_source(id),
  primary key (occupation, title_key)
);
create index skill_library_role_trgm on pulse_priv.skill_library_role using gin (title_key public.gin_trgm_ops);
create index skill_library_role_key on pulse_priv.skill_library_role(title_key);
create table pulse_priv.skill_library_link (
  occupation  text not null check (length(occupation) between 2 and 20),
  skill_id    text not null references pulse_priv.skill_library(id) on delete cascade,
  weight      real not null default 1,
  primary key (occupation, skill_id)
);
create index skill_library_link_skill on pulse_priv.skill_library_link(skill_id);
revoke all on pulse_priv.skill_library_source, pulse_priv.skill_library, pulse_priv.skill_library_role, pulse_priv.skill_library_link from public;

-- A skill's comparison key: lower case, single spaces, no surrounding punctuation.
create function pulse.skill_library_key(p text) returns text language sql immutable parallel safe set search_path = pulse, pg_temp as $$
  select left(lower(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'), ' .,;:-')), 120)
$$;
grant execute on function pulse.skill_library_key(text) to pulse_api;

insert into pulse_priv.skill_library_source(id, name, version, licence, attribution, adapted, imported_by)
values ('pulse-1', 'Pulse starting skills', '1', 'Pulse''s own list, written for Pulse (no third-party source)',
  'Pulse''s own starting list of skills, written by the Pulse team.', 'Written for Pulse: short names a person would put on a profile, each with the industries and job words that suggest it.', 'migration 2205');
insert into pulse_priv.skill_library(id, source, kind, label, label_key, industries, roles, weight)
select 'pulse:' || regexp_replace(pulse.skill_library_key(l), '[^a-z0-9]+', '-', 'g'), 'pulse-1',
       case when l in ('Adobe Photoshop', 'Adobe Illustrator', 'Adobe Premiere Pro', 'Adobe After Effects', 'DaVinci Resolve', 'Final Cut Pro', 'CapCut',
         'Canva', 'Figma', 'TypeScript', 'React', 'Node.js', 'Python', 'SQL', 'PostgreSQL', 'Tally', 'Microsoft Excel', 'Google Sheets', 'Shopify', 'Meta ads', 'Google Ads')
            then 'software' else 'skill' end,
       l, pulse.skill_library_key(l), i, r, 50
  from (values
  ('Video editing', '{media,marketing,real_estate}'::text[], '{editor,video,creative,content,reel}'::text[]),
  ('Motion graphics', '{media,marketing,design}'::text[], '{editor,motion,animator,video,creative,designer}'::text[]),
  ('Colour grading', '{media}'::text[], '{editor,video,colour,color}'::text[]),
  ('Sound design', '{media}'::text[], '{editor,sound,audio,video}'::text[]),
  ('Videography', '{media,marketing,real_estate}'::text[], '{video,camera,shoot,photograph,creative}'::text[]),
  ('Photography', '{media,marketing,real_estate}'::text[], '{photograph,camera,shoot,creative}'::text[]),
  ('Drone shooting', '{media,real_estate}'::text[], '{drone,video,camera,shoot}'::text[]),
  ('Property walkthrough videos', '{real_estate,media}'::text[], '{video,editor,shoot,camera,property}'::text[]),
  ('Reels and short videos', '{media,marketing}'::text[], '{editor,video,social,content,reel}'::text[]),
  ('YouTube channel growth', '{media,marketing}'::text[], '{youtube,video,content,social,growth}'::text[]),
  ('Script writing', '{media,marketing}'::text[], '{writer,script,content,video,creative}'::text[]),
  ('Storyboarding', '{media,design}'::text[], '{editor,video,script,creative,designer}'::text[]),
  ('Copywriting', '{marketing,media}'::text[], '{writer,copy,content,marketing}'::text[]),
  ('Content writing', '{marketing,media}'::text[], '{writer,content,blog,marketing}'::text[]),
  ('Content strategy', '{marketing,media}'::text[], '{content,marketing,strategy,social}'::text[]),
  ('Social media marketing', '{marketing,media,real_estate}'::text[], '{social,marketing,content,growth}'::text[]),
  ('Social media management', '{marketing,media}'::text[], '{social,content,community,marketing}'::text[]),
  ('Community management', '{marketing,media}'::text[], '{community,social,support}'::text[]),
  ('Influencer marketing', '{marketing,media}'::text[], '{influencer,marketing,social,brand}'::text[]),
  ('Performance marketing', '{marketing,ecommerce,real_estate}'::text[], '{performance,ads,marketing,growth}'::text[]),
  ('Meta ads', '{marketing,ecommerce,real_estate}'::text[], '{ads,performance,marketing,growth}'::text[]),
  ('Google Ads', '{marketing,ecommerce,real_estate}'::text[], '{ads,performance,marketing,growth,sem}'::text[]),
  ('Search engine optimisation (SEO)', '{marketing,ecommerce,software}'::text[], '{seo,marketing,content,growth,web}'::text[]),
  ('Email marketing', '{marketing,ecommerce}'::text[], '{email,marketing,crm,growth}'::text[]),
  ('Marketing analytics', '{marketing,ecommerce}'::text[], '{analyst,marketing,growth,data}'::text[]),
  ('Brand strategy', '{marketing,design}'::text[], '{brand,marketing,strategy,creative}'::text[]),
  ('Lead generation', '{sales,marketing,real_estate}'::text[], '{sales,lead,growth,marketing,business}'::text[]),
  ('Cold calling', '{sales,real_estate}'::text[], '{sales,calling,telecaller,caller,business}'::text[]),
  ('Telecalling', '{sales,real_estate}'::text[], '{telecaller,caller,calling,sales,support}'::text[]),
  ('Sales pitching', '{sales,real_estate}'::text[], '{sales,business,closer,account}'::text[]),
  ('Closing deals', '{sales,real_estate}'::text[], '{sales,closer,business,account,broker}'::text[]),
  ('Negotiation', '{sales,real_estate,finance,legal}'::text[], '{sales,closer,broker,business,founder,buyer}'::text[]),
  ('Client relationship management', '{sales,consulting,real_estate}'::text[], '{account,client,relationship,sales,manager}'::text[]),
  ('CRM upkeep', '{sales,real_estate,marketing}'::text[], '{sales,crm,operations,coordinator}'::text[]),
  ('Follow-ups and pipeline hygiene', '{sales,real_estate}'::text[], '{sales,crm,closer,business}'::text[]),
  ('Site visits', '{real_estate}'::text[], '{sales,site,property,broker,agent}'::text[]),
  ('Property listing', '{real_estate}'::text[], '{property,listing,broker,agent,sales}'::text[]),
  ('Real estate sales', '{real_estate}'::text[], '{sales,broker,agent,property,closer}'::text[]),
  ('Channel partner management', '{real_estate,sales}'::text[], '{channel,partner,sales,business}'::text[]),
  ('Real estate marketing', '{real_estate,marketing}'::text[], '{marketing,property,brand,growth}'::text[]),
  ('Project launches', '{real_estate,marketing}'::text[], '{launch,marketing,project,manager}'::text[]),
  ('Market research', '{marketing,consulting,real_estate}'::text[], '{research,analyst,marketing,strategy}'::text[]),
  ('Customer support', '{software,ecommerce,any}'::text[], '{support,customer,service,helpdesk}'::text[]),
  ('Customer success', '{software,consulting}'::text[], '{success,customer,account,support}'::text[]),
  ('Graphic design', '{design,marketing,media}'::text[], '{designer,graphic,creative,brand}'::text[]),
  ('Brand identity design', '{design,marketing}'::text[], '{designer,brand,logo,creative}'::text[]),
  ('UI design', '{design,software}'::text[], '{designer,ui,product,web,app}'::text[]),
  ('UX research', '{design,software}'::text[], '{designer,ux,research,product}'::text[]),
  ('Figma', '{design,software}'::text[], '{designer,ui,ux,product}'::text[]),
  ('Adobe Photoshop', '{design,media,marketing}'::text[], '{designer,graphic,photograph,creative,editor}'::text[]),
  ('Adobe Illustrator', '{design,marketing}'::text[], '{designer,graphic,illustrator,creative}'::text[]),
  ('Adobe Premiere Pro', '{media,marketing}'::text[], '{editor,video,creative}'::text[]),
  ('Adobe After Effects', '{media,marketing}'::text[], '{editor,motion,video,creative,animator}'::text[]),
  ('DaVinci Resolve', '{media}'::text[], '{editor,video,colour,color}'::text[]),
  ('Final Cut Pro', '{media}'::text[], '{editor,video}'::text[]),
  ('CapCut', '{media,marketing}'::text[], '{editor,video,social,reel}'::text[]),
  ('Canva', '{marketing,design,media}'::text[], '{designer,social,content,marketing}'::text[]),
  ('Presentation design', '{design,consulting,any}'::text[], '{designer,presentation,deck,consultant}'::text[]),
  ('Web design', '{design,software}'::text[], '{designer,web,developer}'::text[]),
  ('3D rendering', '{design,real_estate}'::text[], '{3d,render,designer,architect,visualiser}'::text[]),
  ('Interior design', '{design,real_estate}'::text[], '{interior,designer,architect}'::text[]),
  ('Architectural visualisation', '{real_estate,design}'::text[], '{3d,render,architect,visualiser}'::text[]),
  ('Software development', '{software}'::text[], '{developer,engineer,programmer,software}'::text[]),
  ('Web development', '{software}'::text[], '{developer,engineer,web,frontend,backend}'::text[]),
  ('Front-end development', '{software}'::text[], '{developer,frontend,engineer,web,ui}'::text[]),
  ('Back-end development', '{software}'::text[], '{developer,backend,engineer,api}'::text[]),
  ('Mobile app development', '{software}'::text[], '{developer,mobile,app,android,ios,engineer}'::text[]),
  ('TypeScript', '{software}'::text[], '{developer,engineer,frontend,backend}'::text[]),
  ('React', '{software}'::text[], '{developer,frontend,engineer,web}'::text[]),
  ('Node.js', '{software}'::text[], '{developer,backend,engineer}'::text[]),
  ('Python', '{software,finance}'::text[], '{developer,engineer,data,analyst,scientist}'::text[]),
  ('SQL', '{software,finance}'::text[], '{developer,engineer,data,analyst}'::text[]),
  ('PostgreSQL', '{software}'::text[], '{developer,backend,engineer,database}'::text[]),
  ('API design', '{software}'::text[], '{developer,backend,engineer,architect}'::text[]),
  ('Cloud infrastructure', '{software}'::text[], '{devops,engineer,cloud,infrastructure,sre}'::text[]),
  ('DevOps', '{software}'::text[], '{devops,engineer,sre,infrastructure}'::text[]),
  ('Automated testing', '{software}'::text[], '{qa,tester,engineer,developer,quality}'::text[]),
  ('Quality assurance', '{software,any}'::text[], '{qa,tester,quality}'::text[]),
  ('Data analysis', '{software,finance,marketing,any}'::text[], '{analyst,data,scientist,research}'::text[]),
  ('Data visualisation', '{software,finance,marketing}'::text[], '{analyst,data,dashboard}'::text[]),
  ('Machine learning', '{software}'::text[], '{data,scientist,engineer,ml,ai}'::text[]),
  ('AI prompt writing', '{software,marketing,media,any}'::text[], '{ai,prompt,content,automation,developer}'::text[]),
  ('Workflow automation', '{software,operations,any}'::text[], '{automation,operations,developer,ops}'::text[]),
  ('No-code tools', '{software,operations}'::text[], '{automation,operations,product,ops}'::text[]),
  ('Product management', '{software}'::text[], '{product,manager,owner,pm}'::text[]),
  ('Project management', '{any}'::text[], '{project,manager,coordinator,pm,lead}'::text[]),
  ('Agile and Scrum', '{software}'::text[], '{scrum,product,project,manager,developer}'::text[]),
  ('Team leadership', '{any}'::text[], '{lead,manager,head,director,founder,ceo}'::text[]),
  ('People management', '{any}'::text[], '{manager,head,lead,director,hr}'::text[]),
  ('Hiring and interviewing', '{hr,any}'::text[], '{hr,recruit,talent,manager,founder,head}'::text[]),
  ('Recruitment', '{hr}'::text[], '{hr,recruit,talent,hiring}'::text[]),
  ('Onboarding new joiners', '{hr}'::text[], '{hr,people,onboarding,operations}'::text[]),
  ('Payroll', '{hr,finance}'::text[], '{hr,payroll,finance,account}'::text[]),
  ('HR policies', '{hr}'::text[], '{hr,people,policy}'::text[]),
  ('Employee engagement', '{hr}'::text[], '{hr,people,culture}'::text[]),
  ('Performance reviews', '{hr,any}'::text[], '{hr,manager,head,lead}'::text[]),
  ('Training and coaching', '{any}'::text[], '{trainer,coach,manager,lead,hr}'::text[]),
  ('Bookkeeping', '{finance}'::text[], '{account,bookkeeper,finance}'::text[]),
  ('Accounting', '{finance}'::text[], '{account,finance,ca,chartered}'::text[]),
  ('GST filing', '{finance}'::text[], '{account,finance,tax,gst,ca}'::text[]),
  ('Taxation', '{finance}'::text[], '{tax,account,finance,ca}'::text[]),
  ('Invoicing and collections', '{finance,any}'::text[], '{account,finance,billing,collections}'::text[]),
  ('Financial planning and analysis', '{finance}'::text[], '{finance,analyst,fp&a,cfo}'::text[]),
  ('Budgeting', '{finance,any}'::text[], '{finance,manager,founder,cfo,operations}'::text[]),
  ('Tally', '{finance}'::text[], '{account,finance,tally}'::text[]),
  ('Microsoft Excel', '{any}'::text[], '{analyst,account,finance,operations,coordinator,manager}'::text[]),
  ('Google Sheets', '{any}'::text[], '{analyst,operations,coordinator,account,manager}'::text[]),
  ('Reporting and dashboards', '{any}'::text[], '{analyst,operations,manager,data}'::text[]),
  ('Operations management', '{operations,any}'::text[], '{operations,ops,manager,coordinator}'::text[]),
  ('Process improvement', '{operations,any}'::text[], '{operations,process,manager,analyst}'::text[]),
  ('Vendor management', '{operations,any}'::text[], '{operations,vendor,procurement,purchase}'::text[]),
  ('Procurement', '{operations}'::text[], '{procurement,purchase,buyer,operations}'::text[]),
  ('Logistics', '{operations,ecommerce}'::text[], '{logistics,operations,supply,warehouse}'::text[]),
  ('Inventory management', '{operations,ecommerce}'::text[], '{inventory,warehouse,operations,store}'::text[]),
  ('Office administration', '{operations,any}'::text[], '{admin,office,executive,assistant}'::text[]),
  ('Executive assistance', '{any}'::text[], '{assistant,executive,ea,secretary}'::text[]),
  ('Calendar and travel planning', '{any}'::text[], '{assistant,executive,ea,coordinator}'::text[]),
  ('Event management', '{marketing,operations}'::text[], '{event,coordinator,marketing}'::text[]),
  ('Public speaking', '{any}'::text[], '{founder,ceo,sales,trainer,manager,head}'::text[]),
  ('Business development', '{sales,consulting,any}'::text[], '{business,development,bd,sales,founder}'::text[]),
  ('Partnerships', '{sales,consulting,any}'::text[], '{partner,business,alliances,founder}'::text[]),
  ('Fundraising', '{finance,any}'::text[], '{founder,ceo,cfo,investor}'::text[]),
  ('Strategy', '{consulting,any}'::text[], '{strategy,consultant,founder,ceo,director,head}'::text[]),
  ('Consulting', '{consulting}'::text[], '{consultant,advisor,strategy}'::text[]),
  ('Contract drafting', '{legal,any}'::text[], '{legal,lawyer,counsel,contract}'::text[]),
  ('Legal research', '{legal}'::text[], '{legal,lawyer,counsel,paralegal}'::text[]),
  ('Compliance', '{legal,finance}'::text[], '{compliance,legal,risk,finance}'::text[]),
  ('E-commerce operations', '{ecommerce}'::text[], '{ecommerce,operations,catalog,marketplace}'::text[]),
  ('Shopify', '{ecommerce}'::text[], '{ecommerce,shopify,store,developer}'::text[]),
  ('Marketplace listings', '{ecommerce}'::text[], '{catalog,listing,ecommerce,marketplace}'::text[]),
  ('Teaching', '{education}'::text[], '{teacher,tutor,trainer,faculty}'::text[]),
  ('Curriculum design', '{education}'::text[], '{teacher,curriculum,instructional,trainer}'::text[]),
  ('Patient care', '{health}'::text[], '{nurse,doctor,care,clinic}'::text[]),
  ('Written communication', '{any}'::text[], '{writer,manager,support,assistant,coordinator,any}'::text[]),
  ('Spoken English', '{any}'::text[], '{sales,support,caller,telecaller,any}'::text[]),
  ('Hindi', '{any}'::text[], '{sales,support,caller,telecaller}'::text[]),
  ('Marathi', '{any}'::text[], '{sales,support,caller,telecaller}'::text[]),
  ('Time management', '{any}'::text[], '{any}'::text[]),
  ('Problem solving', '{any}'::text[], '{any}'::text[]),
  ('Attention to detail', '{any}'::text[], '{any}'::text[])) v(l, i, r);

-- {label: library id or null} for a person's own skill labels (null: a custom skill).
create function pulse.skill_refs_of(p_labels text[]) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_object_agg(x.label, (select l.id from pulse_priv.skill_library l where l.label_key = pulse.skill_library_key(x.label) and l.retired_at is null)), '{}'::jsonb)
    from (select distinct btrim(u) label from unnest(coalesce(p_labels, '{}')) u where btrim(u) <> '') x
$$;
revoke all on function pulse.skill_refs_of(text[]) from public;
grant execute on function pulse.skill_refs_of(text[]) to pulse_api;

alter table pulse_priv.account_profile add column skill_refs jsonb not null default '{}' check (jsonb_typeof(skill_refs) = 'object');
alter table pulse.people_profile add column skill_refs jsonb not null default '{}' check (jsonb_typeof(skill_refs) = 'object');
create function pulse.skill_refs_keep() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  new.skill_refs := skill_refs_of(new.skills);
  return new;
end $$;
revoke all on function pulse.skill_refs_keep() from public;
create trigger account_profile_skill_refs before insert or update of skills on pulse_priv.account_profile for each row execute function pulse.skill_refs_keep();
create trigger people_profile_skill_refs before insert or update of skills on pulse.people_profile for each row execute function pulse.skill_refs_keep();
-- The account rows are owner-only (no row security): their links are made now. A company's people_profile rows get
-- theirs on their next save; reads use skill_refs_of meanwhile.
update pulse_priv.account_profile set skill_refs = pulse.skill_refs_of(skills) where cardinality(coalesce(skills, '{}')) > 0;

-- Type-ahead: the library's skills that start with, contain or are close to what was typed.
create function pulse.skill_library_search(p_q text, p_limit int default 12) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp set pg_trgm.similarity_threshold = 0.35 as $$
  with q as (select pulse.skill_library_key(p_q) k)
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'label', x.label, 'kind', x.kind, 'category', x.category) order by x.rank, x.own desc, x.weight desc, length(x.label), x.label), '[]'::jsonb)
    from (select l.id, l.label, l.kind, l.category, l.weight, l.source = 'pulse-1' own,
                 case when l.label_key = q.k then 0 when l.label_key like q.k || '%' then 1 when l.label_key like '% ' || q.k || '%' then 2 when l.label_key like '%' || q.k || '%' then 3 else 4 end rank
            from pulse_priv.skill_library l, q
           where l.retired_at is null and length(q.k) >= 1
             and (l.label_key like '%' || q.k || '%' or (length(q.k) >= 4 and l.label_key operator(public.%) q.k))
           order by rank, own desc, l.weight desc, length(l.label), l.label
           limit least(greatest(coalesce(p_limit, 12), 1), 30)) x
$$;

-- Suggestions for a role in the open company: Pulse's own list by the role's words and the company's industry, then
-- what the closest occupations (by job title) use. Skills the person has (p_have) are left out.
create function pulse.skill_library_suggest(p_role text, p_have text[], p_limit int default 12) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp set pg_trgm.similarity_threshold = 0.45 as $$
declare k text := skill_library_key(p_role); words text[]; ind text; tags text[] := '{}'; have text[]; occ text[]; n int := least(greatest(coalesce(p_limit, 12), 1), 30);
begin
  select coalesce(array_agg(skill_library_key(h)), '{}') into have from unnest(coalesce(p_have, '{}')) h;
  words := array(select w from unnest(regexp_split_to_array(k, '[^a-z0-9&]+')) w where length(w) >= 2);
  select lower(coalesce(c.industry, '')) into ind from org_public_card c where c.org_id = current_org();
  ind := coalesce(ind, '');
  tags := array_remove(array[
    case when ind ~ '(real ?estate|property|realty|builder|developer)' then 'real_estate' end,
    case when ind ~ '(market|advertis|agency|brand|pr\b)' then 'marketing' end,
    case when ind ~ '(media|film|video|production|content|creative)' then 'media' end,
    case when ind ~ '(software|saas|tech|it\b|ai\b|app)' then 'software' end,
    case when ind ~ '(design|architect|interior)' then 'design' end,
    case when ind ~ '(financ|account|bank|tax|audit)' then 'finance' end,
    case when ind ~ '(sales|lead|telecall|call cent)' then 'sales' end,
    case when ind ~ '(consult|advis)' then 'consulting' end,
    case when ind ~ '(e-?commerce|retail|d2c|store)' then 'ecommerce' end,
    case when ind ~ '(school|educat|training|edtech)' then 'education' end,
    case when ind ~ '(health|clinic|hospital|pharma)' then 'health' end,
    case when ind ~ '(legal|law)' then 'legal' end], null);
  if length(k) >= 3 then
    select coalesce(array_agg(o), '{}') into occ from (
      select r.occupation o from pulse_priv.skill_library_role r
       where r.title_key = k or r.title_key operator(public.%) k
       group by r.occupation order by max(case when r.title_key = k then 2 else public.similarity(r.title_key, k) end) desc limit 4) t;
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label, 'kind', s.kind, 'why', s.why) order by s.ord, s.score desc, s.label), '[]'::jsonb)
    from (select d.* from (select distinct on (x.label_key) x.* from (
        select l.id, l.label, l.label_key, l.kind, 'role'::text why, 0 ord,
               (select count(*) from unnest(l.roles) r where r = any(words))::real * 10 + case when l.industries && tags then 3 else 0 end score
          from pulse_priv.skill_library l
         where l.retired_at is null and l.source = 'pulse-1' and l.roles && words and not (l.label_key = any(have))
        union all
        select l.id, l.label, l.label_key, l.kind, 'industry', 1, l.weight
          from pulse_priv.skill_library l
         where l.retired_at is null and l.source = 'pulse-1' and l.industries && tags and not (l.label_key = any(have)) and not (l.roles && words)
        union all
        select l.id, l.label, l.label_key, l.kind, 'occupation', 2, sum(lk.weight)
          from pulse_priv.skill_library_link lk join pulse_priv.skill_library l on l.id = lk.skill_id
         where lk.occupation = any(occ) and l.retired_at is null and not (l.label_key = any(have))
         group by l.id
        union all
        select l.id, l.label, l.label_key, l.kind, 'common', 3, l.weight
          from pulse_priv.skill_library l
         where l.retired_at is null and l.source = 'pulse-1' and 'any' = any(l.roles) and not (l.label_key = any(have))
      ) x order by x.label_key, x.ord, x.score desc) d
      order by d.ord, d.score desc, d.label limit n) s);
end $$;

-- Each list's licence and the words it asks to be shown with.
create function pulse.skill_library_about() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'version', s.version, 'licence', s.licence, 'attribution', s.attribution,
      'adapted', s.adapted, 'url', s.source_url, 'skills', (select count(*) from pulse_priv.skill_library l where l.source = s.id and l.retired_at is null)) order by s.imported_at), '[]'::jsonb)
    from pulse_priv.skill_library_source s
$$;
revoke all on function pulse.skill_library_search(text, int), pulse.skill_library_suggest(text, text[], int), pulse.skill_library_about() from public;
grant execute on function pulse.skill_library_search(text, int), pulse.skill_library_suggest(text, text[], int), pulse.skill_library_about() to pulse_api;

-- 1 (profile) -------------------------------------------------------------------------------------------------------
create or replace function pulse.account_profile_get() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); a pulse_priv.pulse_account%rowtype; ap pulse_priv.account_profile%rowtype;
begin
  if v is null then return null; end if;
  select * into a from pulse_priv.pulse_account where id = v;
  select * into ap from pulse_priv.account_profile where account_id = v;
  return jsonb_build_object(
    'name', a.display_name, 'handle', a.handle, 'me', current_viewer(), 'photoAt', ap.photo_at, 'hasPhoto', ap.photo_bytes is not null,
    'profile', jsonb_build_object('headline', ap.headline, 'about', ap.about, 'skills', to_jsonb(coalesce(ap.skills, '{}')), 'links', coalesce(ap.links, '[]'::jsonb),
      'pronouns', ap.pronouns, 'location', ap.location, 'languages', to_jsonb(coalesce(ap.languages, '{}')), 'skillLevels', coalesce(ap.skill_levels, '{}'::jsonb),
      'education', coalesce(ap.education, '[]'::jsonb), 'certifications', coalesce(ap.certifications, '[]'::jsonb),
      'contactEmail', ap.contact_email, 'contactPhone', ap.contact_phone,
      'skillRefs', skill_refs_of(coalesce(ap.skills, '{}'))),
    'orgSkills', coalesce((select to_jsonb(skills) from people_profile where person_id = current_viewer()), '[]'::jsonb),
    'badges', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'note', note, 'from', from_org_name, 'by', given_by_name, 'on', earned_on, 'carried', carried, 'here', from_org = current_org()) order by earned_on desc) from pulse_priv.account_badge where account_id = v), '[]'::jsonb),
    'highlights', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'detail', detail, 'from', from_org_name, 'on', on_date) order by coalesce(on_date, created_at::date) desc) from pulse_priv.account_highlight where account_id = v), '[]'::jsonb),
    'shares', coalesce((select jsonb_agg(jsonb_build_object('org', o.id, 'name', o.name, 'current', o.id = current_org(),
        'profile', coalesce(s.profile, true), 'skills', coalesce(s.skills, true), 'badges', coalesce(s.badges, true), 'highlights', coalesce(s.highlights, true),
        'contact', coalesce(s.contact, false), 'career', coalesce(s.career, false)) order by o.name)
      from pulse_priv.account_member m join org o on o.id = m.member_org left join pulse_priv.account_share s on s.account_id = v and s.member_org = m.member_org
      where m.account_id = v and o.status = 'active' and o.kind = 'company' and (o.purpose = 'work' or o.id = current_org())), '[]'::jsonb));
end $$;


-- 2 -----------------------------------------------------------------------------------------------------------------
create table pulse.org_retired (
  org_id          uuid not null references pulse.org(id),
  id              uuid primary key default gen_random_uuid(),
  before_status   text not null check (before_status in ('active', 'suspended')),
  before_purpose  text not null check (before_purpose in ('work', 'test', 'demo')),
  seats           jsonb not null default '[]' check (jsonb_typeof(seats) = 'array'),
  sessions_ended  int not null default 0,
  reason          text not null check (length(btrim(reason)) between 4 and 400),
  retired_at      timestamptz not null default now(),
  restored_at     timestamptz,
  restored_reason text check (restored_reason is null or length(btrim(restored_reason)) between 4 and 400)
);
create index org_retired_org on pulse.org_retired(org_id, retired_at desc);
alter table pulse.org_retired enable row level security;
alter table pulse.org_retired force row level security;
create policy tenant_isolation on pulse.org_retired using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse.org_retired from public;

create function pulse.platform_org_retire(p_org uuid, p_accounts text[], p_reason text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o org; v_reason text := platform_reason(p_reason); v_ended int := 0; v_seats jsonb := '[]'::jsonb; m record; v_id uuid;
begin
  perform platform_guard();
  select * into o from org where id = p_org;
  if not found then raise exception 'Organisation not found' using errcode = 'P0002'; end if;
  if p_org = install_org() then raise exception 'The install''s own organisation cannot be retired' using errcode = '22023'; end if;
  if o.kind <> 'company' then raise exception 'Only a company is retired here: a personal space stays' using errcode = '22023'; end if;
  if o.merged_into is not null then raise exception 'A merged organisation is put back with its merge''s undo, not retired' using errcode = '22023'; end if;
  if o.status = 'archived' then raise exception 'That organisation is already archived' using errcode = '22023'; end if;
  if o.status not in ('active', 'suspended') then raise exception 'Only an active or suspended company is retired' using errcode = '22023'; end if;
  if o.purpose = 'work' and o.status = 'active' then
    raise exception 'This is a real, active company: mark it test or suspend it first' using errcode = '22023'; end if;
  perform platform_enter(p_org);
  update org set status = 'archived', purpose = 'test' where id = p_org;
  update login_session set revoked_at = now() where org_id = p_org and revoked_at is null;
  get diagnostics v_ended = row_count;
  for m in select am.account_id, am.person_id, am.kind, am.joined_at, am.last_used_at, pa.handle
             from pulse_priv.account_member am join pulse_priv.pulse_account pa on pa.id = am.account_id
            where am.member_org = p_org and pa.handle = any(coalesce(p_accounts, '{}')) order by pa.handle loop
    update person set status = 'inactive', active_to = coalesce(active_to, current_date) where id = m.person_id and status = 'active';
    insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
    values (p_org, 'person', m.person_id, 'status', 'active', 'Seat ended: the company was retired as a test company (@' || m.handle || ')', null);
    insert into account_alumni(org_id, account_id, person_id, kind, joined_at, how, moved_to) values (p_org, m.account_id, m.person_id, m.kind, m.joined_at, 'left', null)
    on conflict (org_id, person_id) do update set left_at = now(), how = 'left', moved_to = null, account_id = excluded.account_id;
    perform audit_write('account_leave', 'person', m.person_id::text);
    delete from pulse_priv.account_member where account_id = m.account_id and member_org = p_org;
    update pulse_priv.pulse_account set last_org = null where id = m.account_id and last_org = p_org;
    v_seats := v_seats || jsonb_build_array(jsonb_build_object('account', m.account_id, 'handle', m.handle, 'person', m.person_id, 'kind', m.kind,
      'joinedAt', m.joined_at, 'lastUsedAt', m.last_used_at));
  end loop;
  insert into org_retired(org_id, before_status, before_purpose, seats, sessions_ended, reason)
  values (p_org, o.status, o.purpose, v_seats, v_ended, v_reason) returning id into v_id;
  perform platform_leave();
  perform platform_log('org.retired', p_org, 'org', p_org::text, o.name, v_reason,
    jsonb_build_object('retire', v_id, 'status', jsonb_build_array(o.status, 'archived'), 'purpose', jsonb_build_array(o.purpose, 'test'),
      'sessionsEnded', v_ended, 'seatsEnded', (select coalesce(jsonb_agg(s ->> 'handle'), '[]'::jsonb) from jsonb_array_elements(v_seats) s)));
  return jsonb_build_object('retire', v_id, 'org', p_org, 'name', o.name, 'status', jsonb_build_array(o.status, 'archived'),
    'purpose', jsonb_build_array(o.purpose, 'test'), 'sessionsEnded', v_ended, 'seatsEnded', v_seats);
end $$;

create function pulse.platform_org_restore(p_org uuid, p_reason text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o org; r org_retired; v_reason text := platform_reason(p_reason); s jsonb; n int := 0;
begin
  perform platform_guard();
  select * into o from org where id = p_org;
  if not found then raise exception 'Organisation not found' using errcode = 'P0002'; end if;
  perform platform_enter(p_org);
  select * into r from org_retired where org_id = p_org and restored_at is null order by retired_at desc limit 1;
  if not found then perform platform_leave(); raise exception 'That organisation was not retired' using errcode = 'P0002'; end if;
  update org set status = r.before_status, purpose = r.before_purpose where id = p_org;
  for s in select x from jsonb_array_elements(r.seats) x loop
    insert into pulse_priv.account_member(account_id, member_org, person_id, kind, joined_at, last_used_at)
    values ((s ->> 'account')::uuid, p_org, (s ->> 'person')::uuid, s ->> 'kind', (s ->> 'joinedAt')::timestamptz, nullif(s ->> 'lastUsedAt', '')::timestamptz)
    on conflict do nothing;
    update person set status = 'active', active_to = null where id = (s ->> 'person')::uuid and status = 'inactive';
    delete from account_alumni where org_id = p_org and person_id = (s ->> 'person')::uuid;
    insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
    values (p_org, 'person', (s ->> 'person')::uuid, 'status', 'inactive', 'Seat given back: the company was restored (@' || (s ->> 'handle') || ')', null);
    n := n + 1;
  end loop;
  update org_retired set restored_at = now(), restored_reason = v_reason where id = r.id;
  perform platform_leave();
  perform platform_log('org.restored', p_org, 'org', p_org::text, o.name, v_reason,
    jsonb_build_object('retire', r.id, 'status', jsonb_build_array('archived', r.before_status), 'purpose', jsonb_build_array('test', r.before_purpose), 'seatsBack', n));
  return jsonb_build_object('retire', r.id, 'org', p_org, 'status', r.before_status, 'purpose', r.before_purpose, 'seatsBack', n);
end $$;
revoke all on function pulse.platform_org_retire(uuid, text[], text), pulse.platform_org_restore(uuid, text) from public;
grant execute on function pulse.platform_org_retire(uuid, text[], text), pulse.platform_org_restore(uuid, text) to pulse_api;

-- migrate:down
drop function if exists pulse.platform_org_restore(uuid, text);
drop function if exists pulse.platform_org_retire(uuid, text[], text);
drop table if exists pulse.org_retired;
drop trigger if exists people_profile_skill_refs on pulse.people_profile;
drop trigger if exists account_profile_skill_refs on pulse_priv.account_profile;
drop function if exists pulse.skill_refs_keep();
alter table pulse.people_profile drop column if exists skill_refs;
alter table pulse_priv.account_profile drop column if exists skill_refs;
-- account_profile_get and account_career_of: their previous bodies are 1683_profile_unify.sql (this one only adds the
-- filters and skillRefs); re-run those definitions to go back.
drop function if exists pulse.skill_library_about();
drop function if exists pulse.skill_library_suggest(text, text[], int);
drop function if exists pulse.skill_library_search(text, int);
drop function if exists pulse.skill_refs_of(text[]);
drop function if exists pulse.skill_library_key(text);
drop table if exists pulse_priv.skill_library_link;
drop table if exists pulse_priv.skill_library_role;
drop table if exists pulse_priv.skill_library;
drop table if exists pulse_priv.skill_library_source;

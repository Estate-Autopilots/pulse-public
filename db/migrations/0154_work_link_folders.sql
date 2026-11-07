-- migrate:up
-- UX-TASKS-2: what a client project includes, read from EA's own folders. EA files a package that covers two
-- real-estate projects as one client folder that says "2 Projects" and files the next project as its own folder
-- ("Project 2", "2nd Project") under the same client, often a month later. A link may now place such a client project
-- under the package (one level: a package inside another holds nothing itself), detected from those folder names with
-- the evidence shown. A name alone no longer suggests a link (it needs a second signal). Machine suggestions that no
-- source supports any more are retired (kept, and brought back if a source supports them again).
alter table pulse.work_project_link add column retired_at timestamptz;
drop index pulse.work_project_link_review;
create index work_project_link_review on pulse.work_project_link(org_id,status,confidence desc) where status='suggested' and retired_at is null;

-- Null when the link keeps the shape (a package and the work under it, one level deep); otherwise why not.
create function pulse.work_link_shape(p_pkg uuid,p_prj uuid) returns text language sql stable security definer set search_path=pulse,pg_temp as $$
 select case
  when p_pkg is null or p_prj is null or p_pkg=p_prj then 'Choose two different projects'
  when not exists(select 1 from project where org_id=current_org() and id=p_pkg and kind='client_work') then 'Choose a client project to place it under'
  when not exists(select 1 from project where org_id=current_org() and id=p_prj and kind in ('internal','client_work')) then 'Choose a project'
  when exists(select 1 from project where id=p_prj and kind='client_work') and exists(select 1 from work_project_link where org_id=current_org() and client_project_id=p_prj and status='linked')
   then 'That client project already holds projects of its own: place those under this one instead'
  when exists(select 1 from project where id=p_prj and kind='client_work') and exists(select 1 from work_project_link where org_id=current_org() and project_id=p_pkg and status='linked'
   and exists(select 1 from project where id=client_project_id and kind='client_work')) then 'This client project sits inside another: place it under that one'
  when exists(select 1 from project where id=p_prj and kind='client_work') and exists(select 1 from work_project_link where org_id=current_org() and project_id=p_prj and status='linked' and client_project_id<>p_pkg)
   then 'That client project is already part of another package'
  end
$$;

create or replace function pulse.work_link_suggest() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n_new int;n_upd int;n_retired int;
begin
 if current_viewer() is not null and not viewer_is('admin','leadership') then raise exception 'Leadership and admins look for links' using errcode='42501';end if;
 with internal as (select p.id,coalesce(p.title,p.name) t,nullif(p.storage_root,'') root from project p where p.org_id=current_org() and p.kind='internal' and p.status<>'cancelled'
   and not exists(select 1 from record_merge rm where rm.org_id=p.org_id and rm.entity_type='project' and rm.gone_id=p.id and rm.undone_at is null)),
 pkg as (select p.id,coalesce(p.title,p.name) t,nullif(p.storage_root,'') root,nullif(btrim(c.display_name),'') client,p.start_month from project p left join client c on c.id=p.client_id and c.client_type<>'internal'
   where p.org_id=current_org() and p.kind='client_work' and p.status<>'cancelled'
   and not exists(select 1 from record_merge rm where rm.org_id=p.org_id and rm.entity_type='project' and rm.gone_id=p.id and rm.undone_at is null)),
 -- The company's own projects that deliver a package: Drive folder inside it, name and trackers, people (support only).
 ev as (
  select pk.id pkg,i.id prj,0.9::numeric w,jsonb_build_object('kind','drive','text','Its Drive folder sits inside this client project’s folder','detail',substr(i.root,length(pk.root)+2)) e
   from internal i join pkg pk on pk.root is not null and i.root is not null and length(pk.root)>=12 and starts_with(i.root,pk.root||'/')
  union all
  select pk.id,i.id,0.45,jsonb_build_object('kind','name','text','Its name carries “'||pk.t||'”')
   from internal i join pkg pk on length(btrim(pk.t))>=5 and lower(i.t)<>lower(btrim(pk.t)) and lower(i.t) ~ ('\m'||work_re_escape(lower(btrim(pk.t)))||'\M')
  union all
  select pk.id,i.id,0.4,jsonb_build_object('kind','name','text','Its name carries the client “'||pk.client||'”')
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
 iscored as (select pkg,prj,least(0.99,1-exp(sum(ln(1-w))))::numeric(3,2) conf,jsonb_agg(e order by w desc) evidence,(array_agg(e->>'kind' order by w desc))[1] src
   from ev group by pkg,prj having 1-exp(sum(ln(1-w)))>=0.55),
 iranked as (select s.*,row_number() over(partition by s.prj order by s.conf desc,pk.start_month desc nulls last,s.pkg) r from iscored s join pkg pk on pk.id=s.pkg),
 -- Client folders under one package: "2 Projects" on the package, "Project 2" / "2nd Project" on the next, same client,
 -- within two months. Each folder joins one package; a "2 Projects" package takes one more.
 f as (select p.id,p.client_id,nullif(btrim(c.display_name),'') client,p.start_month m,(extract(year from p.start_month)*12+extract(month from p.start_month))::int mi,
   regexp_replace(p.storage_root,'^.*/','') seg,coalesce(substring(regexp_replace(p.storage_root,'^.*/','') from '^\s*#\s*(\d+)')::int,p.registry_no) fno
  from project p left join client c on c.id=p.client_id and c.client_type<>'internal'
  where p.org_id=current_org() and p.kind='client_work' and p.status<>'cancelled' and p.start_month is not null and p.storage_root like 'index-path:%'
   and not exists(select 1 from record_merge rm where rm.org_id=p.org_id and rm.entity_type='project' and rm.gone_id=p.id and rm.undone_at is null)),
 marked as (select f.*,substring(lower(seg) from '(project\s*[2-9]|[2-9](?:nd|rd|th)\s*project)') part,
   substring(lower(seg) from '((?:\m[2-9]|\mtwo|\mthree|\mfour)\s*projects)') multi,substring(lower(seg) from '(project\s*1\M|\m1st\s*project)') first,
   coalesce(substring(lower(seg) from '\m([2-9])\s*projects')::int,case when lower(seg) ~ '\mthree\s*projects' then 3 when lower(seg) ~ '\mfour\s*projects' then 4 else 2 end) n from f),
 pairs as (select a.id pkg,b.id prj,a.n,a.multi is not null amulti,abs(b.mi-a.mi) gap,a.fno,
   jsonb_build_array(
    case when a.client_id=b.client_id then jsonb_build_object('w',0.3,'kind','drive','text','Same client: '||a.client)
     when a.client is not null and length(a.client)>=5 and public.word_similarity(lower(a.client),lower(b.seg))>=0.7 then jsonb_build_object('w',0.25,'kind','drive','text','“'||a.client||'” is named in its folder')
     when b.client is not null and length(b.client)>=5 and public.word_similarity(lower(b.client),lower(a.seg))>=0.7 then jsonb_build_object('w',0.25,'kind','drive','text','“'||b.client||'” is named in the package’s folder') end,
    case abs(b.mi-a.mi) when 0 then jsonb_build_object('w',0.25,'kind','drive','text','Same month: '||to_char(a.m,'FMMonth YYYY'))
     when 1 then jsonb_build_object('w',0.15,'kind','drive','text','A month apart: '||to_char(a.m,'FMMon YYYY')||' and '||to_char(b.m,'FMMon YYYY'))
     else jsonb_build_object('w',0.05,'kind','drive','text','Two months apart: '||to_char(a.m,'FMMon YYYY')||' and '||to_char(b.m,'FMMon YYYY')) end,
    case when b.part is not null then jsonb_build_object('w',0.35,'kind','drive','text','Its folder says “'||initcap(b.part)||'”','detail',b.seg) end,
    case when a.multi is not null then jsonb_build_object('w',0.3,'kind','drive','text','The package’s folder says “'||initcap(a.multi)||'”','detail',a.seg)
     when a.first is not null then jsonb_build_object('w',0.3,'kind','drive','text','The package’s folder says “'||initcap(a.first)||'”','detail',a.seg) end,
    case when a.multi is not null and b.multi is not null then jsonb_build_object('w',0.2,'kind','drive','text','Both folders say “'||initcap(b.multi)||'”') end) e
  from marked a join marked b on a.id<>b.id and abs(b.mi-a.mi)<=2
   and (a.client_id=b.client_id or (a.client is not null and length(a.client)>=5 and public.word_similarity(lower(a.client),lower(b.seg))>=0.7)
    or (b.client is not null and length(b.client)>=5 and public.word_similarity(lower(b.client),lower(a.seg))>=0.7))
  where a.part is null and (b.part is not null or (a.multi is not null and b.multi is null and b.first is null) or (a.multi is not null and b.multi is not null and b.mi=a.mi and a.fno<b.fno))),
 fscored as (select pkg,prj,n,amulti,gap,fno,least(0.99,1-exp(sum(ln(1-(x->>'w')::numeric))))::numeric(3,2) conf,
   jsonb_agg(x-'w' order by (x->>'w')::numeric desc) evidence from pairs cross join jsonb_array_elements(e) x where jsonb_typeof(x)='object' group by pkg,prj,n,amulti,gap,fno),
 one_package as (select s.*,row_number() over(partition by prj order by conf desc,gap,amulti desc,fno) r from fscored s where conf>=0.55),
 capped as (select o.*,row_number() over(partition by pkg order by conf desc,gap,prj) k from one_package o where r=1),
 found as (select pkg,prj,src,conf,evidence from iranked where r<=3
  union all select pkg,prj,'drive',conf,evidence from capped where k<=case when amulti then greatest(n-1,1) else 9 end),
 saved as (insert into work_project_link(org_id,client_project_id,project_id,status,source,confidence,evidence)
  select current_org(),pkg,prj,'suggested',src,conf,evidence from found
  on conflict(org_id,client_project_id,project_id) do update set confidence=excluded.confidence,evidence=excluded.evidence,source=excluded.source,retired_at=null,updated_at=now()
   where work_project_link.status='suggested' and (work_project_link.evidence is distinct from excluded.evidence or work_project_link.confidence is distinct from excluded.confidence or work_project_link.retired_at is not null)
  returning (xmax=0) fresh),
 -- Machine suggestions no source supports any more are retired (they return if one does).
 retired as (update work_project_link l set retired_at=now(),updated_at=now() where l.org_id=current_org() and l.status='suggested' and l.retired_at is null and l.source in ('drive','name','tracker','people')
  and not exists(select 1 from found x where x.pkg=l.client_project_id and x.prj=l.project_id) returning 1)
 select (select count(*) from saved where fresh),(select count(*) from saved where not fresh),(select count(*) from retired) into n_new,n_upd,n_retired;
 return jsonb_build_object('suggested',n_new,'refreshed',n_upd,'retired',n_retired,
  'pending',(select count(*) from work_project_link where org_id=current_org() and status='suggested' and retired_at is null));
end $$;
create or replace function pulse.work_link_decide(p_id uuid,p_decision text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare l work_project_link;why text;
begin
 if current_viewer() is null or not viewer_is('admin','leadership') then raise exception 'Leadership decides what a client project includes' using errcode='42501';end if;
 if p_decision not in ('link','dismiss') then raise exception 'Choose link or not related' using errcode='22023';end if;
 select * into l from work_project_link where org_id=current_org() and id=p_id for update;
 if not found then raise exception 'Suggestion not found' using errcode='P0002';end if;
 if p_decision='link' then
  why:=work_link_shape(l.client_project_id,l.project_id);
  if why is not null then raise exception '%',why using errcode='22023';end if;
 end if;
 update work_project_link set status=case when p_decision='link' then 'linked' else 'dismissed' end,retired_at=null,decided_by=current_viewer(),decided_at=now(),updated_at=now() where id=p_id;
 perform audit_write('work_link_'||p_decision,'project',l.client_project_id::text);
 return jsonb_build_object('status',case when p_decision='link' then 'linked' else 'dismissed' end);
end $$;
-- By hand: leadership places any project (a client folder too); a project's owner places the company's own project.
create or replace function pulse.work_link_set(p_client_project uuid,p_project uuid,p_on boolean) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();lid uuid;why text;
begin
 if not exists(select 1 from project where org_id=current_org() and id=p_client_project and kind='client_work') then raise exception 'Choose a client project' using errcode='22023';end if;
 if not exists(select 1 from work_project where org_id=current_org() and project_id=p_project) or p_project=p_client_project then raise exception 'Choose a project to place under it' using errcode='22023';end if;
 if exists(select 1 from project where id=p_project and kind='client_work') then
  if not viewer_is('admin','leadership') then raise exception 'Leadership places one client project under another' using errcode='42501';end if;
 elsif not (viewer_is('admin','leadership') or work_project_can_manage(p_project)) then raise exception 'Leadership or the project’s owner places it under a client project' using errcode='42501';end if;
 if p_on then why:=work_link_shape(p_client_project,p_project);if why is not null then raise exception '%',why using errcode='22023';end if;end if;
 insert into work_project_link(org_id,client_project_id,project_id,status,source,confidence,created_by,decided_by,decided_at)
 values(current_org(),p_client_project,p_project,case when p_on then 'linked' else 'dismissed' end,'manual',1,me,me,now())
 on conflict(org_id,client_project_id,project_id) do update set status=excluded.status,retired_at=null,decided_by=me,decided_at=now(),updated_at=now() returning id into lid;
 perform audit_write(case when p_on then 'work_link_add' else 'work_link_remove' end,'project',p_client_project::text);
 return lid;
end $$;
create or replace function pulse.work_link_capture(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_pkg uuid;v_prj uuid;v_conf numeric;v_ev jsonb;lid uuid;
begin
 if current_viewer() is not null and not viewer_is('admin') then raise exception 'Admins or the Google collector capture links' using errcode='42501';end if;
 begin v_pkg:=(p->>'clientProjectId')::uuid;v_prj:=(p->>'projectId')::uuid;v_conf:=least(0.95,greatest(0.05,coalesce((p->>'confidence')::numeric,0.6)));
 exception when others then raise exception 'Name the client project and the project' using errcode='22023';end;
 if not exists(select 1 from project where org_id=current_org() and id=v_pkg and kind='client_work') or not exists(select 1 from project where org_id=current_org() and id=v_prj and kind in ('internal','client_work'))
  or v_pkg=v_prj then raise exception 'Name a client project and a project to place under it' using errcode='22023';end if;
 v_ev:=coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('kind','google','text',left(e->>'text',300),'ref',left(e->>'ref',300)))) from jsonb_array_elements(coalesce(p->'evidence','[]')) e
  where jsonb_typeof(e)='object' and length(btrim(coalesce(e->>'text','')))>0),'[]');
 if jsonb_array_length(v_ev) not between 1 and 10 then raise exception 'Give one to ten pieces of evidence' using errcode='22023';end if;
 insert into work_project_link(org_id,client_project_id,project_id,status,source,confidence,evidence,created_by) values(current_org(),v_pkg,v_prj,'suggested','google',v_conf,v_ev,current_viewer())
 on conflict(org_id,client_project_id,project_id) do update set evidence=excluded.evidence,confidence=greatest(work_project_link.confidence,excluded.confidence),retired_at=null,updated_at=now()
  where work_project_link.status='suggested' returning id into lid;
 return coalesce(lid,(select id from work_project_link where org_id=current_org() and client_project_id=v_pkg and project_id=v_prj));
end $$;

do $$ declare o uuid;previous_org text:=current_setting('pulse.org_id',true);begin
 for o in select id from pulse.org loop
  perform set_config('pulse.org_id',o::text,true);
  perform pulse.work_link_suggest();
 end loop;
 perform set_config('pulse.org_id',coalesce(previous_org,''),true);
end $$;
revoke all on function pulse.work_link_shape(uuid,uuid) from public;
grant execute on function pulse.work_link_shape(uuid,uuid) to pulse_api,pulse_worker;
-- migrate:down
-- Forward-only.

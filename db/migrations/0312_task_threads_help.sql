-- migrate:up
-- TASKS-4B (owner, 12 Oct 2026): discussion and help.
--  * Replies thread under the comment they answer (like Reddit); a thread can be resolved and reopened.
--  * "Ask for help" posts a help request to the task's thread and tells the right people: the reviewer, the doer's head,
--    collaborators and people whose domains the work fits (who can then see the task), and anyone mentioned.
--  * After a help thread is resolved, the person who asked rates each helper: Helpful, Somewhat or Not helpful. The
--    ratings are private: the asker sees their own; the helper, their head, HR and leadership see totals only; leaders
--    see who helps how much, by name, never ranked.
--  * Helping earns small credit in the value system (the policy's help_points for Helpful, half for Somewhat).

alter table pulse.work_comment
 add column parent_id uuid references pulse.work_comment(id),
 add column kind text not null default 'comment' check(kind in ('comment','help')),
 add column resolved_at timestamptz,add column resolved_by uuid references pulse.person(id);
create index work_comment_parent on pulse.work_comment(org_id,parent_id) where parent_id is not null;
create index work_comment_help on pulse.work_comment(org_id,task_id) where kind='help';

create table pulse.help_rating (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 root_id uuid not null references pulse.work_comment(id),task_id uuid not null references pulse.task(id),
 helper_id uuid not null references pulse.person(id),rater_id uuid not null references pulse.person(id),
 rating smallint not null check(rating between 0 and 2),                     -- 0 not helpful, 1 somewhat, 2 helpful
 at timestamptz not null default now(),unique(org_id,root_id,helper_id)
);
alter table pulse.help_rating enable row level security;
alter table pulse.help_rating force row level security;
create policy tenant on pulse.help_rating using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
-- Private: only whoever rated reads a rating; everyone else reads totals through the functions below.
create policy own on pulse.help_rating as restrictive for select to pulse_api using(rater_id=pulse.current_viewer());
grant select on pulse.help_rating to pulse_api;
grant select,insert,update on pulse.help_rating to pulse_worker;
create trigger audit_mutation after insert or update on pulse.help_rating for each row execute function pulse.audit_mutation();

select pulse.check_values_add('pulse.notification','notification_event_type_check','event_type',array['task.help','task.reply']);
do $$
declare definition text;changed text;
begin
 definition:=pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
 changed:=replace(definition,' elsif p_type=''policy.published'' then',
 ' elsif p_type in (''task.help'',''task.reply'') then
  return p_subject=''comment'' and exists(select 1 from work_comment c where c.org_id=current_org() and c.id=p_id and c.removed_at is null and c.author_id<>p_person
   and c.task_id is not null and work_task_person(c.task_id,p_person) and (p_type<>''task.help'' or (c.kind=''help'' and c.resolved_at is null)));
 elsif p_type=''policy.published'' then');
 if changed=definition then raise exception 'notification_recipient_allowed changed shape';end if;
 execute changed;
end $$;

/** The first comment of a thread. */
create function pulse.work_comment_root(p_id uuid) returns uuid language sql stable security definer set search_path=pulse,pg_temp as $$
 with recursive up(id,parent,depth) as (select id,parent_id,0 from work_comment where org_id=current_org() and id=p_id
  union all select c.id,c.parent_id,u.depth+1 from work_comment c join up u on c.id=u.parent where u.depth<50)
 select id from up where parent is null limit 1
$$;

/** Who "Ask for help" tells: the reviewer, the doer's head, collaborators and up to five people whose active domains the
 *  work fits; never the asker. */
create function pulse.work_help_people(p_task uuid) returns table(person_id uuid,why text) language sql stable security definer set search_path=pulse,pg_temp as $$
 with t as (select * from task where org_id=current_org() and id=p_task and deleted_at is null),
 c as (select t.review_owner_id p,'reviews it' why,1 o from t union all
  select hr_head(coalesce(t.assignee_person_id,t.owner_id)),'their head',2 from t union all
  select m.person_id,'works on it',3 from task_member m,t where m.org_id=current_org() and m.task_id=t.id and m.role='collaborator' and m.removed_at is null union all
  (select d.person_id,'it fits their domain',4 from work_domain d,t where d.org_id=current_org() and d.status='active'
    and work_domain_match(d.person_id,t.project_id,t.category,t.tags) is not null group by d.person_id limit 5))
 select distinct on (c.p) c.p,c.why from c,t where c.p is not null and c.p<>current_viewer() and c.p is distinct from coalesce(t.assignee_person_id,t.owner_id)
  and task_person_ok(c.p) order by c.p,c.o
$$;

/** Post a comment, a reply under one (parentId) or a help request (kind help, on a task). A plain comment keeps the
 *  older path (everyone on the work hears once); a reply tells whoever it answers and who started the thread; a help
 *  request tells the right people and lets them see the task. */
create function pulse.work_comment_post(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();v_parent uuid:=nullif(p->>'parentId','')::uuid;v_kind text:=coalesce(nullif(p->>'kind',''),'comment');par work_comment;
 v_task uuid:=nullif(p->>'taskId','')::uuid;v_project uuid:=nullif(p->>'projectId','')::uuid;v_body text:=btrim(coalesce(p->>'body',''));cid uuid;m uuid;
 v_mentions uuid[];heard uuid[]:='{}';r record;what text;href text;snippet text;root uuid;depth int;
begin
 if v_kind not in ('comment','help') then raise exception 'Choose a comment or a request for help' using errcode='22023';end if;
 begin v_mentions:=array(select distinct x::uuid from jsonb_array_elements_text(coalesce(p->'mentions','[]')) x);
 exception when others then raise exception 'Mention people from the list' using errcode='22023';end;
 if v_parent is not null then
  select * into par from work_comment where org_id=current_org() and id=v_parent and removed_at is null;
  if not found then raise exception 'That comment was removed' using errcode='P0002';end if;
  if v_kind='help' then raise exception 'Ask for help as a new thread' using errcode='22023';end if;
  v_task:=par.task_id;v_project:=par.project_id;
  select count(*) into depth from (with recursive up(id,parent) as (select id,parent_id from work_comment where id=v_parent union all select c.id,c.parent_id from work_comment c join up u on c.id=u.parent) select 1 from up) x;
  if depth>=8 then raise exception 'This thread is deep enough: reply higher up' using errcode='22023';end if;
 elsif v_kind='comment' then
  return work_comment_add(v_task,v_project,v_body,v_mentions);
 end if;
 if v_kind='help' and v_task is null then raise exception 'Ask for help on a task' using errcode='22023';end if;
 if (v_task is null)=(v_project is null) then raise exception 'Choose a task or a project' using errcode='22023';end if;
 if length(v_body) not between 1 and 4000 then raise exception 'Write up to 4,000 characters' using errcode='22023';end if;
 if cardinality(v_mentions)>20 then raise exception 'Mention up to 20 people' using errcode='22023';end if;
 if v_task is not null then
  if not task_visible(v_task) then raise exception 'Task not found' using errcode='P0002';end if;
  what:='“'||left((select title from task where id=v_task),70)||'”';href:='/tasks/'||v_task;
 else
  if not work_project_in(v_project) then raise exception 'Join the project to comment on it' using errcode='42501';end if;
  what:=(select left(coalesce(title,name),70) from project where id=v_project);href:='/tasks/projects/'||v_project;
 end if;
 insert into work_comment(org_id,task_id,project_id,author_id,body,mentions,parent_id,kind)
 values(current_org(),v_task,v_project,me,v_body,array(select x from unnest(v_mentions) x where x<>me),v_parent,v_kind) returning id into cid;
 snippet:=left(regexp_replace(v_body,'\s+',' ','g'),70);
 -- Mentions: as for any comment (they may see and follow the work, and are told).
 foreach m in array (select mentions from work_comment where id=cid) loop
  if not task_person_ok(m) then raise exception 'Mention active team members' using errcode='22023';end if;
  if v_task is not null and not work_task_person(v_task,m) then insert into task_member(org_id,task_id,person_id,role,added_by) values(current_org(),v_task,m,'watcher',me);
  elsif v_project is not null and not exists(select 1 from project_member where org_id=current_org() and project_id=v_project and person_id=m and left_at is null)
   and not work_project_person(v_project,m) then insert into project_member(org_id,project_id,person_id,role,added_by) values(current_org(),v_project,m,'watcher',me);
  end if;
  perform work_notify(m,case when v_task is not null then 'task.mention' else 'project.mention' end,'comment',cid,cid::text,work_first_name(me)||' mentioned you on '||what||': '||snippet,href,'mention');
  heard:=heard||m;
 end loop;
 if v_kind='help' then
  -- The right people: they may see the task (as watchers) and are asked.
  for r in select * from work_help_people(v_task) loop
   if not r.person_id=any(heard) then
    if not work_task_person(v_task,r.person_id) then insert into task_member(org_id,task_id,person_id,role,added_by) values(current_org(),v_task,r.person_id,'watcher',me) on conflict do nothing;end if;
    perform work_notify(r.person_id,'task.help','comment',cid,cid::text,work_first_name(me)||' asks for help on '||what||': '||snippet,href||'?thread='||cid,'task');
    heard:=heard||r.person_id;
   end if;
  end loop;
  perform task_event_add(v_task,'help',null,null,left(snippet,200));
 else
  -- A reply: whoever it answers and whoever started the thread.
  root:=work_comment_root(cid);
  for r in select distinct x.a from (select par.author_id a union select author_id from work_comment where id=root) x where x.a<>me and not x.a=any(heard) loop
   if v_task is not null then perform work_notify(r.a,'task.reply','comment',cid,cid::text,work_first_name(me)||' replied on '||what||': '||snippet,href||'?thread='||root,'task');
   else perform work_notify(r.a,'project.comment','comment',cid,cid::text,work_first_name(me)||' replied on '||what||': '||snippet,href,'task');end if;
  end loop;
 end if;
 return cid;
end $$;

/** Resolve (or reopen) a thread: whoever started it, or the people on the task (its doer, reviewer, creator, editors). */
create function pulse.work_thread_resolve(p_root uuid,p_on boolean) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();c work_comment;
begin
 select * into c from work_comment where org_id=current_org() and id=p_root and removed_at is null for update;
 if not found then raise exception 'That comment was removed' using errcode='P0002';end if;
 if c.parent_id is not null then raise exception 'Resolve the thread from its first comment' using errcode='22023';end if;
 if not (me=c.author_id or (c.task_id is not null and task_visible(c.task_id) and task_can_edit(c.task_id)) or (c.project_id is not null and work_project_can_manage(c.project_id))) then
  raise exception 'Whoever started the thread or the people on the work resolve it' using errcode='42501';end if;
 update work_comment set resolved_at=case when p_on then now() end,resolved_by=case when p_on then me end where id=p_root;
 if c.task_id is not null then perform task_event_add(c.task_id,'resolved',null,case when c.kind='help' then 'the request for help' else 'a thread' end,case when not p_on then 'reopened' end);end if;
 -- Helpers to rate: everyone who replied in a resolved help thread, except the asker.
 return jsonb_build_object('resolved',p_on,'helpers',case when p_on and c.kind='help' then (select coalesce(jsonb_agg(distinct jsonb_build_object('id',p.id,'name',p.display_name)),'[]')
  from work_comment x join person p on p.id=x.author_id where x.org_id=current_org() and x.removed_at is null and x.author_id<>c.author_id and work_comment_root(x.id)=p_root) else '[]'::jsonb end);
end $$;

/** The asker rates a helper once the help thread is resolved: helpful, somewhat or not. Helping earns credit. */
create function pulse.work_help_rate(p_root uuid,p_helper uuid,p_rating text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();c work_comment;v int;pts int;hp int;
begin
 select * into c from work_comment where org_id=current_org() and id=p_root and removed_at is null;
 if not found or c.kind<>'help' or c.parent_id is not null then raise exception 'Choose a request for help' using errcode='22023';end if;
 if c.author_id<>me then raise exception 'Whoever asked for help rates the helpers' using errcode='42501';end if;
 if c.resolved_at is null then raise exception 'Resolve the thread first' using errcode='22023';end if;
 if p_helper=me or not exists(select 1 from work_comment x where x.org_id=current_org() and x.author_id=p_helper and x.removed_at is null and x.id<>p_root and work_comment_root(x.id)=p_root) then
  raise exception 'Rate someone who answered in this thread' using errcode='22023';end if;
 v:=case p_rating when 'helpful' then 2 when 'somewhat' then 1 when 'not' then 0 end;
 if v is null then raise exception 'Choose Helpful, Somewhat or Not helpful' using errcode='22023';end if;
 insert into help_rating(org_id,root_id,task_id,helper_id,rater_id,rating) values(current_org(),p_root,c.task_id,p_helper,me,v)
 on conflict(org_id,root_id,helper_id) do update set rating=excluded.rating,at=now();
 hp:=coalesce((select help_points from work_settings where org_id=current_org()),2);
 pts:=case v when 2 then hp when 1 then ceil(hp/2.0)::int else 0 end;
 update work_credit set reversed_at=now() where org_id=current_org() and help_root=p_root and person_id=p_helper and basis='help' and reversed_at is null and points<>pts;
 if pts>0 then
  insert into work_credit(org_id,task_id,person_id,points,basis,via,work_day,help_root)
  values(current_org(),c.task_id,p_helper,pts,'help','assigned',(now() at time zone org_time_zone())::date,p_root)
  on conflict(org_id,help_root,person_id) where reversed_at is null and basis='help' do nothing;
 end if;
 return jsonb_build_object('rating',p_rating,'points',pts);
end $$;

/** A person's help, in totals (them, their head, HR, leadership): requests answered, how they were rated, points. */
create function pulse.help_totals(p_person uuid,p_days int default 90) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare since timestamptz:=now()-make_interval(days=>greatest(7,least(400,p_days)));out jsonb;
begin
 if current_viewer() is null or not (p_person=current_viewer() or viewer_is('admin','leadership','hr') or coalesce(manages(p_person),false)) then
  raise exception 'A person''s help is for them, their head, HR and leadership' using errcode='42501';end if;
 select jsonb_build_object('days',p_days,
  'answered',(select count(distinct work_comment_root(x.id))::int from work_comment x where x.org_id=current_org() and x.author_id=p_person and x.removed_at is null and x.parent_id is not null
    and x.created_at>=since and exists(select 1 from work_comment r where r.id=work_comment_root(x.id) and r.kind='help' and r.author_id<>p_person)),
  'helpful',(select count(*)::int from help_rating where org_id=current_org() and helper_id=p_person and rating=2 and at>=since),
  'somewhat',(select count(*)::int from help_rating where org_id=current_org() and helper_id=p_person and rating=1 and at>=since),
  'notHelpful',(select count(*)::int from help_rating where org_id=current_org() and helper_id=p_person and rating=0 and at>=since),
  'points',(select coalesce(sum(points),0)::int from work_credit where org_id=current_org() and person_id=p_person and basis='help' and reversed_at is null and credited_at>=since),
  'asked',(select count(*)::int from work_comment where org_id=current_org() and author_id=p_person and kind='help' and created_at>=since)) into out;
 return out;
end $$;

/** Leaders: who helps how much, everyone in view (leadership and HR: everyone; heads and managers: their people), by name. */
create function pulse.help_team(p_days int default 90) returns table(person_id uuid,name text,answered int,helpful int,somewhat int,not_helpful int,points int)
 language sql stable security definer set search_path=pulse,pg_temp as $$
 with since as (select now()-make_interval(days=>greatest(7,least(400,p_days))) t),
 people as (select p.id,p.display_name from person p join people_profile pp on pp.person_id=p.id where p.org_id=current_org() and p.side='staff' and p.status='active'
  and current_viewer() is not null and p.id<>current_viewer() and (viewer_is('admin','leadership','hr') or coalesce(manages(p.id),false)))
 select pe.id,pe.display_name,
  (select count(distinct work_comment_root(x.id))::int from work_comment x,since where x.org_id=current_org() and x.author_id=pe.id and x.removed_at is null and x.parent_id is not null and x.created_at>=since.t
    and exists(select 1 from work_comment r where r.id=work_comment_root(x.id) and r.kind='help' and r.author_id<>pe.id)),
  (select count(*)::int from help_rating h,since where h.org_id=current_org() and h.helper_id=pe.id and h.rating=2 and h.at>=since.t),
  (select count(*)::int from help_rating h,since where h.org_id=current_org() and h.helper_id=pe.id and h.rating=1 and h.at>=since.t),
  (select count(*)::int from help_rating h,since where h.org_id=current_org() and h.helper_id=pe.id and h.rating=0 and h.at>=since.t),
  (select coalesce(sum(k.points),0)::int from work_credit k,since where k.org_id=current_org() and k.person_id=pe.id and k.basis='help' and k.reversed_at is null and k.credited_at>=since.t)
 from people pe order by pe.display_name
$$;

revoke all on function pulse.work_comment_root(uuid),pulse.work_help_people(uuid),pulse.work_comment_post(jsonb),pulse.work_thread_resolve(uuid,boolean),pulse.work_help_rate(uuid,uuid,text),
 pulse.help_totals(uuid,int),pulse.help_team(int) from public;
grant execute on function pulse.work_comment_root(uuid),pulse.work_help_people(uuid),pulse.work_comment_post(jsonb),pulse.work_thread_resolve(uuid,boolean),pulse.work_help_rate(uuid,uuid,text),
 pulse.help_totals(uuid,int),pulse.help_team(int) to pulse_api;

-- migrate:down
-- Forward-only: threads, ratings and help credits are kept.

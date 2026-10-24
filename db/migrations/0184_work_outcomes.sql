-- migrate:up
-- TASKS-3 (owner, 11 Oct 2026: "Points for extra work don't work. If I have done extra, I should be able to see that.")
--  * Each credit remembers why it counts as extra, decided when the work is accepted (so later domain changes do not
--    rewrite history): done outside the person's agreed domains, claimed from the pool, or taken on by the person
--    themselves when someone else had made it. "Above plan" (more value in a week than the person's usual week) is
--    worked out per week in the outcome view.
--  * Each credit also remembers the domain it fell in, so value can be split by domain over time.

alter table pulse.work_credit add column extra text[] not null default '{}' check(extra <@ array['outside_domains','pool','volunteered']::text[]),
 add column domain_id uuid references pulse.work_domain(id);

/** Why a credit for this task to this person is extra work, and the domain it falls in. */
create function pulse.work_credit_kind(p_task uuid,p_person uuid) returns table(extra text[],domain_id uuid) language sql stable security definer set search_path=pulse,pg_temp as $$
 with t as (select * from task where org_id=current_org() and id=p_task),
 d as (select work_domain_match(p_person,t.project_id,t.category,t.tags) id from t),
 has as (select exists(select 1 from work_domain w where w.org_id=current_org() and w.person_id=p_person and w.status='active') any_domain)
 select array_remove(array[
   case when (select any_domain from has) and (select id from d) is null then 'outside_domains' end,
   case when (select claimed_by from t)=p_person then 'pool' end,
   case when (select claimed_by from t) is distinct from p_person and (select created_by from t) is distinct from p_person
     and exists(select 1 from task_event e where e.task_id=p_task and e.kind='assigned' and e.actor_id=p_person) then 'volunteered' end],null),
  (select id from d)
$$;

-- Credit follows acceptance (UX-TASKS-2), now with why it is extra and its domain.
create or replace function pulse.task_credit_follow() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare who uuid:=coalesce(new.assignee_person_id,new.owner_id);pts int:=least(100,coalesce(new.value_points,new.effort*new.impact,0));k record;
begin
 if new.status='accepted' and old.status is distinct from 'accepted' and who is not null then
  select * into k from work_credit_kind(new.id,who);
  insert into work_credit(org_id,task_id,person_id,points,basis,via,work_day,extra,domain_id)
  values(new.org_id,new.id,who,pts,case when new.value_points is not null then 'value' else 'rating' end,case when new.claimed_by=who then 'pool' else 'assigned' end,
   (coalesce(new.accepted_at,now()) at time zone 'Asia/Kolkata')::date,coalesce(k.extra,'{}'),k.domain_id)
  on conflict(org_id,task_id) where reversed_at is null do update set points=excluded.points,basis=excluded.basis,person_id=excluded.person_id,via=excluded.via,extra=excluded.extra,domain_id=excluded.domain_id;
 elsif old.status='accepted' and new.status<>'accepted' then
  update work_credit set reversed_at=now() where org_id=new.org_id and task_id=new.id and reversed_at is null;
 elsif new.status='accepted' then
  update work_credit set points=pts,basis=case when new.value_points is not null then 'value' else 'rating' end where org_id=new.org_id and task_id=new.id and reversed_at is null and points<>pts;
 end if;
 return null;
end $$;

-- Credits already given: the same reasons, read with today's domains.
do $$ declare o uuid;begin
 for o in select id from pulse.org loop
  perform set_config('pulse.org_id',o::text,true);
  update pulse.work_credit c set (extra,domain_id)=(select coalesce(k.extra,'{}'),k.domain_id from pulse.work_credit_kind(c.task_id,c.person_id) k) where c.org_id=o and c.reversed_at is null;
 end loop;
end $$;

revoke all on function pulse.work_credit_kind(uuid,uuid) from public;
grant execute on function pulse.work_credit_kind(uuid,uuid) to pulse_api,pulse_worker;

-- migrate:down
-- Forward-only.

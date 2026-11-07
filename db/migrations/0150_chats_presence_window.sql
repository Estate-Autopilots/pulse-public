-- migrate:up
-- CHATS-2: a check-in nobody closed (a missed check-out) no longer reads as "in the office" the next day. An open entry
-- counts for today, or for yesterday's date when it began within the last 16 hours (a night shift still running).
create or replace function pulse.presence_of(p_people uuid[] default null) returns table(person_id uuid,state text,active_at timestamptz,status_text text,status_emoji text,status_until timestamptz,dnd boolean)
 language sql stable security definer set search_path=pulse,pg_temp as $$
 with ppl as (select p.id from person p where p.org_id=current_org() and p.side='staff' and p.status='active' and (p_people is null or p.id=any(p_people))),
 d as (select (now() at time zone 'Asia/Kolkata')::date today),
 open_entry as (select distinct on (e.person_id) e.person_id,e.id,e.mode from attendance_effective e join ppl on ppl.id=e.person_id, d
  where e.org_id=current_org() and e.checked_out_at is null and (e.work_date=d.today or e.work_date=d.today-1 and e.checked_in_at>now()-interval '16 hours')
  order by e.person_id,e.checked_in_at desc),
 on_break as (select b.person_id from attendance_break b join open_entry o on o.id=b.entry_id where b.ended_at is null),
 on_leave as (select distinct l.person_id from leave_request l join ppl on ppl.id=l.person_id, d where l.org_id=current_org() and l.status='approved' and d.today between l.from_date and l.to_date),
 shoot as (select distinct coalesce(t.assignee_person_id,t.owner_id) person_id from task t, d where t.org_id=current_org() and t.deliverable_type='Video shoot'
  and t.status not in('done','cancelled') and (t.work_on=d.today or (t.due_at at time zone 'Asia/Kolkata')::date=d.today)),
 dnd as (select s.person_id,coalesce((s.settings->>'dnd')::boolean,false) or coalesce((s.settings->>'snoozedUntil')::timestamptz,'-infinity')>now() on_dnd
  from companion_notification_settings s join ppl on ppl.id=s.person_id where s.org_id=current_org())
 select ppl.id,
  case when b.person_id is not null then 'break'
   when o.mode='field' and sh.person_id is not null then 'shoot' when o.mode='field' then 'outside' when o.mode='wfh' then 'wfh' when o.mode='office' then 'office'
   when lv.person_id is not null then 'leave'
   when st.last_active_at>now()-interval '5 minutes' then 'active' when st.last_active_at>now()-interval '60 minutes' then 'away' else 'offline' end,
  st.last_active_at,
  case when st.status_until is null or st.status_until>now() then st.status_text end,
  case when st.status_until is null or st.status_until>now() then st.status_emoji end,
  case when st.status_until>now() then st.status_until end,
  coalesce(dn.on_dnd,false)
 from ppl left join open_entry o on o.person_id=ppl.id left join on_break b on b.person_id=ppl.id left join on_leave lv on lv.person_id=ppl.id
 left join shoot sh on sh.person_id=ppl.id left join person_status st on st.org_id=current_org() and st.person_id=ppl.id left join dnd dn on dn.person_id=ppl.id
$$;
-- migrate:down

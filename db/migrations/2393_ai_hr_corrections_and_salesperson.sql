-- migrate:up
-- WL-RESCUE-2 (owner, 18 Nov 2026: "If Bharata does not work for Akabod we lose him as a client"). Two things Willow Lane
-- asked of its AI employee bhrātā that Pulse refused or left out:
--
-- 1. Sakobe (admin and HR) sent Megud's details to bhrātā on 18 Nov (role, phone, joining date). It answered "no change
--    made": an AI employee may not correct a staff record (hr_profile_correct, 1412: HR or admin only). Now it may, inside
--    a run that an admin, leadership or HR started with a message (the who-asked rule of the catalogue keeper, 2367), for
--    the fields HR corrects there: joinedOn, department, managerId, phone, role, pod, employmentType, workLocation. Never
--    workEmail: the sign-in address stays a person's. Each change keeps its reason, the AI's name and the app in the
--    record's history and is undoable by HR or an admin for 7 days (app_change_undo, unchanged).
--    Asked by anyone else (a seller), from a task, a schedule, or with its key outside a run: refused, with a sentence
--    that says who can ask.
--
-- 2. A quotation an AI employee drafts for a seller recorded no salesperson (QT/26-27/0002, made by bhrātā for Adunor):
--    the seat rule (1671) fills it only for a seller's own seat. Now the seller who asked (the staff author of the message
--    that started the run, holding the sales or sales_head role) is the quotation's salesperson.

-- The staff author of the message that started this AI employee's run in progress (30 minutes at most): one person, or
-- null (no run, a run for no message or for a client, or runs for several people at once).
create function pulse.agent_run_asker() returns uuid language sql stable security definer set search_path = pulse, pg_temp as $$
  with runs as (
    select cm.author_id
      from agent_run r join agent_event ev on ev.id = r.event_id
      left join chat_message cm on ev.subject_type = 'message' and cm.id = ev.subject_id and cm.org_id = r.org_id
     where agent_session() is not null and r.org_id = current_org() and r.agent_id = agent_session() and r.state = 'dispatching'
       and r.started_at > now() - interval '30 minutes')
  select p.id from person p
   where p.org_id = current_org() and p.status = 'active' and p.side = 'staff'
     and (select count(*) from runs) > 0 and not exists(select 1 from runs where author_id is null)
     and (select count(distinct author_id) from runs) = 1 and p.id = (select author_id from runs limit 1)
$$;

-- Whether that person may correct staff records themself (an admin, leadership or HR).
create function pulse.agent_hr_asked() returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists(select 1 from role_assignment ra
     where ra.person_id = agent_run_asker() and ra.org_id = current_org() and ra.role_key in ('admin', 'leadership', 'hr')
       and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity'))
$$;

-- 1412's correction with the AI employee's path. A person's path is unchanged, word for word.
create or replace function pulse.hr_profile_correct(p_person uuid, p_field text, p_value text, p_reason text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r jsonb; why text := btrim(coalesce(p_reason, ''));
begin
 if current_viewer() is null then raise exception 'HR or admin required' using errcode='42501'; end if;
 if agent_session() is not null then
  if p_field = 'workEmail' then
   raise exception 'The sign-in e-mail stays a person''s: HR or an admin changes it in People' using errcode='42501'; end if;
  if not agent_hr_asked() then
   raise exception 'An AI employee corrects a staff record only when an admin, leadership or HR asks it in a message: ask one of them' using errcode='42501'; end if;
 elsif not viewer_is('admin', 'hr') then raise exception 'HR or admin required' using errcode='42501'; end if;
 if length(why) not between 5 and 300 then raise exception 'Give the reason for the correction (5 to 300 characters)' using errcode='22023'; end if;
 if not exists(select 1 from person where org_id = current_org() and id = p_person and side = 'staff') then raise exception 'No staff record for that person' using errcode='P0002'; end if;
 r := hr_profile_set(p_person, p_field, p_value, why);
 if (r->>'changed')::boolean then
  r := r || jsonb_build_object('changeId', app_change_add('profile.correct', p_person, r - 'changed' || jsonb_build_object('reason', why)), 'undoUntil', now() + interval '7 days');
 end if;
 return r;
end $$;

-- 1671's new-document rule with the AI employee's seller. The rest is unchanged, word for word.
create or replace function pulse.erp_sales_seat_insert() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare b jsonb;
begin
 if new.source_id is not null and new.salesperson_id is null then
  new.salesperson_id := (select d.salesperson_id from erp_document d where d.id = new.source_id);
 end if;
 if new.salesperson_id is null and new.service_key_id is null and pulse.current_viewer() is not null and pulse.viewer_is('sales','sales_head')
    and new.created_by is not distinct from pulse.current_viewer() then
  new.salesperson_id := pulse.current_viewer();
 end if;
 -- WL-RESCUE-2: a quotation an AI employee drafts because a seller asked it is that seller's.
 if new.salesperson_id is null and new.service_key_id is null and new.doc_type = 'quotation' and pulse.agent_session() is not null then
  new.salesperson_id := (select ra.person_id from role_assignment ra
    where ra.person_id = pulse.agent_run_asker() and ra.org_id = pulse.current_org() and ra.role_key in ('sales', 'sales_head')
      and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity') limit 1);
 end if;
 if new.doc_type <> 'quotation' and new.source_id is null and pulse.current_viewer() is not null then
  b := pulse.erp_flow_block('invoice');
  if b is not null then raise exception '%: open the quotation and choose Create invoice', b->>'why' using errcode = '42501'; end if;
 end if;
 return new;
end $$;

revoke all on function pulse.agent_run_asker(), pulse.agent_hr_asked() from public;
grant execute on function pulse.agent_run_asker(), pulse.agent_hr_asked() to pulse_api, pulse_worker;

-- migrate:down
-- Forward-only: restore 1412's hr_profile_correct and 1671's erp_sales_seat_insert by hand.

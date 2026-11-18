-- migrate:up
-- DATUP-TASKS (Datup, 26 Oct 2026): a complaint about a colleague, written in Pulse. A grievance raised with HR can name
-- the colleague it is about, when it happened and how often it happens, so HR sees the pattern per employee over time.
-- It stays an HR request: only the person who raised it, HR and admins read it (the existing row security); the
-- colleague it is about is never told and cannot read it.
alter table pulse.hr_ticket
  add column about_person_id uuid references pulse.person(id),
  add column happened_on date,
  add column frequency text check (frequency in ('once','sometimes','often','always')),
  add constraint hr_ticket_about_check check (about_person_id is null or (category = 'grievance' and about_person_id <> person_id));
create index hr_ticket_about on pulse.hr_ticket (org_id, about_person_id) where about_person_id is not null;

create function pulse.hr_complaint_open(p_subject text, p_body text, p_priority text, p_about uuid, p_happened date, p_frequency text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare new_id uuid;
begin
  if pulse.current_viewer() is null then raise exception 'a person is required' using errcode = '42501'; end if;
  if p_about is null or not exists (select 1 from person where id = p_about and org_id = pulse.current_org() and side = 'staff') then
    raise exception 'Choose the colleague this is about' using errcode = '22023'; end if;
  if p_about = pulse.current_viewer() then raise exception 'A complaint is about someone else' using errcode = '22023'; end if;
  if p_happened is not null and p_happened > current_date + 1 then raise exception 'When it happened cannot be in the future' using errcode = '22023'; end if;
  if p_frequency is not null and p_frequency not in ('once','sometimes','often','always') then raise exception 'Unknown frequency' using errcode = '22023'; end if;
  new_id := pulse.hr_ticket_open('grievance', p_subject, p_body, p_priority);
  update hr_ticket set about_person_id = p_about, happened_on = p_happened, frequency = p_frequency where id = new_id;
  return new_id;
end $$;
revoke all on function pulse.hr_complaint_open(text, text, text, uuid, date, text) from public;
grant execute on function pulse.hr_complaint_open(text, text, text, uuid, date, text) to pulse_api;

-- migrate:down
drop function pulse.hr_complaint_open(text, text, text, uuid, date, text);
drop index pulse.hr_ticket_about;
alter table pulse.hr_ticket drop constraint hr_ticket_about_check, drop column frequency, drop column happened_on, drop column about_person_id;

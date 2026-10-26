-- migrate:up
-- Data gaps as Review data items (kind 'data_gap'): one per current person missing a joining date, employment type
-- or work e-mail, and one per client-work project with no client or no location. Pods and reporting lines already
-- have their own suggestions. Re-running is safe: an item keeps its stable key, its text follows the record, and an
-- item whose gap has been filled is closed as accepted. Admins and the worker run it; nobody else.
create function pulse.review_flag_gaps() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n int;
begin
 if not viewer_is('admin') and not (current_setting('role', true) = 'pulse_worker') then raise exception 'denied' using errcode = '42501'; end if;
 with gaps as (
  select 'gap:person:' || p.id source_key, 'person' entity_type, p.id entity_id, p.display_name title,
   array_remove(array[case when pp.joined_on is null then 'joining date' end, case when pp.employment_type is null then 'employment type' end,
    case when pp.email is null then 'work e-mail' end], null) missing
  from person p join people_profile pp on pp.person_id = p.id where p.status = 'active' and p.side = 'staff'
  union all
  select 'gap:project:' || p.id, 'project', p.id, coalesce(p.title, p.name),
   array_remove(array[case when p.client_id is null then 'client' end, case when coalesce(btrim(p.location), '') = '' then 'location' end], null)
  from project p where p.kind = 'client_work' and not exists (select 1 from record_merge r where r.entity_type = 'project' and r.gone_id = p.id and r.undone_at is null)
 ), upserted as (
  insert into review_item(org_id, source_key, kind, entity_type, entity_id, title, proposed, evidence)
  select current_org(), g.source_key, 'data_gap', g.entity_type, g.entity_id, g.title, jsonb_build_object('missing', to_jsonb(g.missing)), jsonb_build_object('checkedAt', now())
  from gaps g where cardinality(g.missing) > 0
  on conflict (org_id, source_key) do update set title = excluded.title, proposed = excluded.proposed, evidence = excluded.evidence
   where review_item.status = 'pending'
  returning 1)
 select count(*) into n from upserted;
 update review_item r set status = 'accepted', decided_at = now()
 where r.kind = 'data_gap' and r.status = 'pending' and not exists (
  select 1 from person p join people_profile pp on pp.person_id = p.id where r.source_key = 'gap:person:' || p.id and p.status = 'active'
   and (pp.joined_on is null or pp.employment_type is null or pp.email is null)
  union all select 1 from project p where r.source_key = 'gap:project:' || p.id and (p.client_id is null or coalesce(btrim(p.location), '') = ''));
 return n;
end $$;
revoke all on function pulse.review_flag_gaps() from public;
grant execute on function pulse.review_flag_gaps() to pulse_api, pulse_worker;
-- migrate:down

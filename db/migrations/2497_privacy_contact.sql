-- migrate:up
-- NO-DATA-LOSS-5 (owner, 20 Nov 2026, 18:15 UTC): the privacy contact named in the approved notice texts (2494's
-- "ask your company's privacy contact"). "Use admin@org-9912dc.example for Vitals Technology"; every other company defaults to
-- its owner's or admin's e-mail, editable in Settings → Privacy.
--   privacy_contact            one row per company that chose its own e-mail (none, or a null e-mail = the default)
--   privacy_contact_of_org()   {email, chosen}: the chosen e-mail, else the owner's (the first admin still holding the
--                              role, as org_owner_or_superadmin), else the next admin's who has one; the People e-mail,
--                              then the private work e-mail, then the sign-in e-mail. Anyone signed in reads it; only an admin changes it (the API).
-- Additive. Undo: the down section (the notices then name no e-mail again).

create table pulse.privacy_contact (
  org_id     uuid primary key references pulse.org(id),
  email      text check (email is null or (length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default now()
);
alter table pulse.privacy_contact enable row level security;
alter table pulse.privacy_contact force row level security;
create policy tenant on pulse.privacy_contact using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select, insert, update on pulse.privacy_contact to pulse_api;

create function pulse.privacy_contact_of_org() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  with chosen as (select nullif(btrim(c.email), '') e from privacy_contact c where c.org_id = current_org()),
  admins as (
    select coalesce(nullif(btrim(pr.email), ''), nullif(btrim(pp.work_email), ''), a.email) e
      from role_assignment ra
      join person p on p.id = ra.person_id and p.side = 'staff' and p.status = 'active'
      left join people_profile pr on pr.person_id = p.id and pr.org_id = ra.org_id
      left join pulse_priv.person_private pp on pp.person_id = p.id and pp.org_id = ra.org_id
      left join pulse_priv.account_member m on m.person_id = p.id
      left join pulse_priv.pulse_account a on a.id = m.account_id
     where ra.org_id = current_org() and ra.role_key = 'admin' and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity')
       and coalesce(nullif(btrim(pr.email), ''), nullif(btrim(pp.work_email), ''), a.email) is not null
     order by ra.valid_from, ra.id limit 1)
  select jsonb_build_object('email', coalesce((select e from chosen), (select e from admins)), 'chosen', exists(select 1 from chosen where e is not null))
$$;
revoke all on function pulse.privacy_contact_of_org() from public;
grant execute on function pulse.privacy_contact_of_org() to pulse_api;

-- Vitals Technology (the platform's own company): admin@org-9912dc.example, as the owner said. Each company is written as itself
-- (row security is forced). tenant-neutral: platform data in a migration, not a code default.
do $$ declare was text := current_setting('pulse.org_id', true); o uuid; begin
  for o in select x.id from pulse.org x where x.kind = 'company' and x.merged_into is null and x.name ilike 'Vitals Technology%' loop
    perform set_config('pulse.org_id', o::text, true);
    insert into pulse.privacy_contact (org_id, email) values (o, 'admin@org-9912dc.example') on conflict (org_id) do nothing;
  end loop;
  perform set_config('pulse.org_id', coalesce(was, ''), true);
end $$;

-- migrate:down
drop function if exists pulse.privacy_contact_of_org();
drop table if exists pulse.privacy_contact;

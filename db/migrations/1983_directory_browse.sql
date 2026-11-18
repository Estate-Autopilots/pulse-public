-- migrate:up
-- UI-SWEEP (owner, 10 Nov 2026: "The empty page should show something to browse: featured or verified companies,
-- recently joined companies, people you work with"). Find companies and people, before anything is typed.
-- Read from the same public index as search (pulse.directory_entry, 1891: only listed companies, and only people who
-- turned on "Let people find me") with the same explicit columns as directory_company / directory_person, so nothing
-- comes back that a search could not already find. The viewer's own company is left out of the company lists, and the
-- viewer out of the people list.
--   directory_browse_companies('verified', n)  companies with a checked GSTIN or CIN, by name;
--   directory_browse_companies('recent', n)    the companies that joined Pulse most recently;
--   directory_browse_people(n)                 people of the viewer's company who chose to be found, by name.
-- No new table; read only through these SECURITY DEFINER functions (the API role has no grant on the index).

create function pulse.directory_browse_companies(p_kind text, p_limit int default 6)
returns table (id uuid, handle text, name text, legal_name text, city text, industry text, website text,
  logo_version int, verified_by text, ids jsonb)
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare lim int := least(greatest(coalesce(p_limit, 6), 1), 12); own uuid := current_org();
begin
  if current_viewer() is null then raise exception 'Sign in to see companies' using errcode = '42501'; end if;
  if p_kind = 'verified' then
    return query select e.ref, e.handle, e.name, e.legal_name, e.city, e.industry, e.website, e.picture_version, e.verified_by, e.ids
      from directory_entry e
     where e.kind = 'company' and e.verified_by is not null and e.ref is distinct from own
     order by e.name, e.ref limit lim;
  elsif p_kind = 'recent' then
    return query select e.ref, e.handle, e.name, e.legal_name, e.city, e.industry, e.website, e.picture_version, e.verified_by, e.ids
      from directory_entry e join org g on g.id = e.ref
     where e.kind = 'company' and e.ref is distinct from own
     order by g.created_at desc, e.ref limit lim;
  else
    raise exception 'Choose verified or recent' using errcode = '22023';
  end if;
end $$;

create function pulse.directory_browse_people(p_limit int default 8)
returns table (handle text, name text, headline text, photo_version int, company_handle text, company_name text, email text, phone text)
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare lim int := least(greatest(coalesce(p_limit, 8), 1), 24); own uuid := current_org(); me uuid := current_viewer();
begin
  if me is null then raise exception 'Sign in to see people' using errcode = '42501'; end if;
  return query select e.handle, e.name, e.headline, e.picture_version, e.company_handle, e.company_name, e.email, e.phone
    from directory_entry e
   where e.kind = 'person' and e.company_ref = own
     and not exists (select 1 from pulse_priv.account_member am where am.account_id = e.ref and am.person_id = me)
   order by e.name, e.handle limit lim;
end $$;

revoke all on function pulse.directory_browse_companies(text, int), pulse.directory_browse_people(int) from public;
grant execute on function pulse.directory_browse_companies(text, int), pulse.directory_browse_people(int) to pulse_api;

-- migrate:down
drop function if exists pulse.directory_browse_people(int);
drop function if exists pulse.directory_browse_companies(text, int);

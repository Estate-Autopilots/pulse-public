-- migrate:up
-- LICENCES (owner, 23 Oct 2026): the central register of every organisation licensed to run Pulse. This Pulse (Estate
-- Autopilots' install) is the original; each licensed organisation gets one global handle, one licence key and one
-- record here. Its data stays where it is hosted: on this install ("central") or on the organisation's own server
-- ("self-hosted", e.g. Atlas Crest). Only the identity, the address and the licence live here.
-- Global and owner-only like the account tables (0920): no grants to any runtime role; read through
-- pulse.licence_list(), which answers only inside the platform's own organisation (@estateautopilots).
-- Safe on a live install: additive (a new table, one function, three rows).

create table pulse_priv.pulse_licence (
  id uuid primary key default gen_random_uuid(),
  licence_key text not null unique check (licence_key ~ '^PL-[A-Z0-9]{2,6}-[0-9]{4}$'),
  org_name text not null check (length(org_name) between 2 and 120),
  org_handle text not null unique check (org_handle ~ '^[a-z0-9][a-z0-9._]{2,29}$'),
  org_id uuid,
  hosting text not null check (hosting in ('central', 'self-hosted')),
  address text check (address is null or address ~ '^https://[a-z0-9.-]+$'),
  plan text not null default 'Standard' check (length(plan) <= 40),
  seats int check (seats is null or seats > 0),
  status text not null default 'active' check (status in ('active', 'pending', 'suspended', 'ended')),
  issued_on date not null default current_date,
  renews_on date,
  note text check (note is null or length(note) <= 400),
  created_at timestamptz not null default now()
);

create function pulse.licence_list() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if not exists (select 1 from pulse.org o where o.id = current_org() and o.handle = 'estateautopilots') then
    raise exception 'Licences are kept by the platform organisation' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'key', l.licence_key, 'name', l.org_name, 'handle', l.org_handle, 'orgId', l.org_id, 'hosting', l.hosting,
      'address', l.address, 'plan', l.plan, 'seats', l.seats, 'status', l.status, 'issuedOn', l.issued_on,
      'renewsOn', l.renews_on, 'note', l.note,
      'people', case when l.hosting = 'central' and l.org_id is not null
        then (select count(*) from pulse.person p where p.org_id = l.org_id and p.status = 'active') end)
    order by (l.hosting = 'central' and l.org_handle = 'estateautopilots') desc, l.issued_on, l.org_name)
    from pulse_priv.pulse_licence l), '[]'::jsonb);
end $$;
revoke all on function pulse.licence_list() from public;
grant execute on function pulse.licence_list() to pulse_api;

insert into pulse_priv.pulse_licence (licence_key, org_name, org_handle, org_id, hosting, address, plan, seats, status, issued_on, note)
select 'PL-EA-0001', 'Estate Autopilots', 'estateautopilots', o.id, 'central', 'https://pulse.estateautopilots.com', 'Platform owner', null, 'active', date '2026-10-01',
  'The original Pulse. Holds the register, the accounts and the update channel for every licensed install.'
from pulse.org o where o.handle = 'estateautopilots'
on conflict do nothing;
insert into pulse_priv.pulse_licence (licence_key, org_name, org_handle, org_id, hosting, address, plan, seats, status, issued_on, note) values
  ('PL-AC-0002', 'Atlas Crest', 'atlascrest', '350ce338-d796-4de2-b17b-07cbc337f27a', 'self-hosted', 'https://pulse.atlascrest.example',
   'Self-hosted', 25, 'active', date '2026-10-16', 'Runs on Atlas Crest'' own server; their data stays there. Updates from this Pulse''s channel.'),
  ('PL-WL-0003', 'Willow Lane Enterprises', 'willowlane', null, 'central', null, 'Hosted', 25, 'pending', date '2026-10-22',
   'Solar installer pack. Opens on the shared Pulse; organisation not opened yet.')
on conflict do nothing;

-- migrate:down
drop function if exists pulse.licence_list();
drop table if exists pulse_priv.pulse_licence;

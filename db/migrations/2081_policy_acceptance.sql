-- migrate:up
-- AGREEMENTS (owner, 13 Nov 2026, P1.2 / T1.2.1: "every time there is a policy change by HR, pay, every kind of thing …
-- a full screen or seventy to eighty percent … progressively they are clicking on terms, agreeing on that, and then they
-- have a nice animation that they have accepted and they can go back to work"; T1.2.3: "an audit trail per person per
-- version"). A published policy version (pay, leave, conduct …: pulse.policy_document, 0029/0127/2041) is accepted
-- term by term in the acceptance view the app opens on the person's next visit. It is the same acceptance as My desk →
-- Policies (one pulse.policy_ack row per person per exact version, so GET /api/v0/hr/policies' ackCount and HR-PEOPLE's
-- "N of M accepted" count both), now also keeping:
--   * terms: the key terms the person ticked, in order ([{key,title}], split by @pulse/invoice-doc policyTerms; the API
--     checks the ticks against the version's own terms before it calls policy_accept);
--   * body_sha256: the SHA-256 of the exact text accepted, taken here from the stored version, never from the browser;
--   * via: 'steps' (the acceptance view) or 'desk' (the older one-button acknowledgement).
-- An acceptance never changes afterwards (policy_ack_guard). Managers see who in their team has not accepted the current
-- versions (policy_team_status; HR, leadership and admins see everyone), never the words of anyone's answers.
alter table pulse.policy_ack
  add column terms jsonb not null default '[]'::jsonb,
  add column body_sha256 text,
  add column via text not null default 'desk';
alter table pulse.policy_ack
  add constraint policy_ack_terms_check check (jsonb_typeof(terms) = 'array' and jsonb_array_length(terms) <= 60),
  add constraint policy_ack_body_sha256_check check (body_sha256 is null or body_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint policy_ack_via_check check (via in ('desk', 'steps'));

create function pulse.policy_ack_guard() returns trigger language plpgsql set search_path = pulse, pg_temp as $$
begin
  raise exception 'an acceptance is kept as it was made' using errcode = '42501';
end $$;
create trigger policy_ack_guard before update on pulse.policy_ack for each row execute function pulse.policy_ack_guard();

-- The current published version of a policy kind: no newer published version of the same kind (a newer draft does not count).
create function pulse.policy_is_current(p_document uuid) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from policy_document d where d.id = p_document and d.org_id = current_org() and d.status = 'published'
    and not exists (select 1 from policy_document n where n.org_id = d.org_id and n.kind = d.kind and n.status = 'published' and n.version > d.version))
$$;

/** The person accepts the current published version, term by term. Idempotent: a second press returns the first acceptance. */
create function pulse.policy_accept(p_document uuid, p_terms jsonb) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare d policy_document; a policy_ack;
begin
  if current_viewer() is null or not exists (select 1 from person where id = current_viewer() and org_id = current_org() and side = 'staff' and status = 'active') then
    raise exception 'employee required' using errcode = '42501';
  end if;
  select * into d from policy_document where id = p_document and org_id = current_org() and status = 'published';
  if not found then raise exception 'choose a published policy' using errcode = 'P0002'; end if;
  if not policy_is_current(d.id) then raise exception 'a newer version of this policy is published' using errcode = '40001'; end if;
  -- Each check only sees the shape it expects (SQL does not promise to stop at the first true "or").
  if jsonb_typeof(p_terms) is distinct from 'array' then raise exception 'tick every term before accepting' using errcode = '22023'; end if;
  if jsonb_array_length(p_terms) not between 1 and 60
     or exists (select 1 from jsonb_array_elements(p_terms) t where case when jsonb_typeof(t) <> 'object' then true
       else jsonb_typeof(t -> 'key') is distinct from 'string' or jsonb_typeof(t -> 'title') is distinct from 'string'
         or length(t ->> 'key') not between 2 and 64 or length(t ->> 'title') > 200 or (select count(*) from jsonb_object_keys(t)) <> 2 end) then
    raise exception 'tick every term before accepting' using errcode = '22023';
  end if;
  insert into policy_ack (org_id, document_id, person_id, terms, body_sha256, via)
    values (current_org(), d.id, current_viewer(), p_terms, encode(sha256(convert_to(d.body, 'UTF8')), 'hex'), 'steps')
    on conflict (org_id, document_id, person_id) do nothing;
  select * into a from policy_ack where org_id = current_org() and document_id = d.id and person_id = current_viewer();
  return jsonb_build_object('documentId', d.id, 'kind', d.kind, 'version', d.version, 'at', a.at, 'via', a.via);
end $$;

-- My desk → Policies' one-button acknowledgement keeps working, and now also keeps the text it acknowledged.
create or replace function pulse.policy_acknowledge(p_document uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is null or not exists (select 1 from person where id = current_viewer() and side = 'staff' and status = 'active') then raise exception 'employee required' using errcode = '42501'; end if;
  if not policy_is_current(p_document) then raise exception 'choose current published policy' using errcode = '22023'; end if;
  insert into policy_ack (org_id, document_id, person_id, body_sha256, via)
    select current_org(), d.id, current_viewer(), encode(sha256(convert_to(d.body, 'UTF8')), 'hex'), 'desk' from policy_document d where d.id = p_document and d.org_id = current_org()
    on conflict do nothing;
end $$;

/** Who has accepted the current version of each published policy: HR, leadership and admins see every active employee,
 *  a manager the people they manage (pulse.manages). Names, dates and when HR last reminded them; never more. */
create function pulse.policy_team_status() returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare everyone boolean;
begin
  if current_viewer() is null then raise exception 'sign in as a person' using errcode = '42501'; end if;
  everyone := viewer_is('admin', 'hr', 'leadership');
  return (with docs as (
      select d.id, d.kind, d.title, d.version, d.published_at from policy_document d
      where d.org_id = current_org() and d.status = 'published' and policy_is_current(d.id)),
    people as (
      select p.id, p.display_name from person p
      where p.org_id = current_org() and p.side = 'staff' and p.status = 'active' and (everyone or manages(p.id)))
    select jsonb_build_object('scope', case when everyone then 'company' else 'team' end, 'people', (select count(*) from people),
      'policies', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'title', d.title, 'version', d.version, 'publishedAt', d.published_at,
          'accepted', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'at', a.at, 'via', a.via) order by a.at desc), '[]')
             from people p join policy_ack a on a.org_id = current_org() and a.document_id = d.id and a.person_id = p.id),
          'pending', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'remindedAt', x.at) order by p.display_name), '[]')
             from people p left join policy_ack_nudge x on x.org_id = current_org() and x.document_id = d.id and x.person_id = p.id
             where not exists (select 1 from policy_ack a where a.org_id = current_org() and a.document_id = d.id and a.person_id = p.id)))
        order by d.kind) from docs d), '[]')));
end $$;

revoke all on function pulse.policy_ack_guard(), pulse.policy_is_current(uuid), pulse.policy_accept(uuid, jsonb), pulse.policy_acknowledge(uuid), pulse.policy_team_status() from public;
grant execute on function pulse.policy_is_current(uuid), pulse.policy_accept(uuid, jsonb), pulse.policy_acknowledge(uuid), pulse.policy_team_status() to pulse_api;

-- migrate:down
-- Forward-only: acceptances people made, with the terms they ticked, are kept.

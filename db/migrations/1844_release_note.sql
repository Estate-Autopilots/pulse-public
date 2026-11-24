-- migrate:up
-- RELEASE-COMMS (owner, 7 Nov 2026): what each production release of the product changed, in plain words for each kind
-- of person: the /whats-new page, the "was updated" note after an update, and a share card per audience to send on
-- WhatsApp. Install-level and global (no org_id), like pulse.model_registry: the release-notes generator on the server
-- writes one row per production release as the database's superuser. No runtime role reads or writes the table itself
-- (no grants; row security on with no policy, so a grant added by mistake still shows nothing). Signed-in people read
-- it only through pulse.release_notes() and pulse.release_note_card() below (SECURITY DEFINER), which hand out only the
-- audiences the API names for the viewer, and never the card pictures in the list. On the global allow-list of
-- tests/core/test_acceptance_isolation.py with this reason.
--   items         {"owner":[{"text","href"}], "managers":[…], "salespeople":[…], "hr":[…], "clients":[…], "everyone":[…]}
--   please_check  [{"text","href","audience"}]          known_issues  ["…"]
--   share         {"<audience>": {"text": "WhatsApp text", "image": "data:image/jpeg;base64,…"}}
create table pulse.release_note(
  id bigserial primary key,
  product text not null default 'vitals',
  sha text not null unique,
  version text,
  released_at timestamptz not null,
  headline text not null,
  items jsonb not null default '{}'::jsonb check (jsonb_typeof(items) = 'object'),
  please_check jsonb not null default '[]'::jsonb check (jsonb_typeof(please_check) = 'array'),
  known_issues jsonb not null default '[]'::jsonb check (jsonb_typeof(known_issues) = 'array'),
  share jsonb not null default '{}'::jsonb check (jsonb_typeof(share) = 'object'),
  created_at timestamptz not null default now());
create index release_note_latest on pulse.release_note(product, released_at desc, id desc);
alter table pulse.release_note enable row level security;
revoke all on pulse.release_note from public;
revoke all on sequence pulse.release_note_id_seq from public;

-- The latest releases of a product for a signed-in person: only the parts for p_audiences (the API decides them from
-- the person's roles, whats-new.ts). A share card is named by a short tag of its picture (for the address), never inlined.
create function pulse.release_notes(p_product text, p_audiences text[], p_limit int) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', n.id, 'sha', n.sha, 'version', n.version, 'releasedAt', n.released_at, 'headline', n.headline,
      'items', (select coalesce(jsonb_object_agg(e.k, e.v), '{}'::jsonb) from jsonb_each(n.items) e(k, v)
                 where e.k = any(p_audiences) and jsonb_typeof(e.v) = 'array'),
      'pleaseCheck', (select coalesce(jsonb_agg(a.x order by a.o), '[]'::jsonb) from jsonb_array_elements(n.please_check) with ordinality a(x, o)
                       where jsonb_typeof(a.x) = 'object' and coalesce(nullif(a.x ->> 'audience', ''), 'everyone') = any(p_audiences)),
      'knownIssues', (select coalesce(jsonb_agg(a.x order by a.o), '[]'::jsonb) from jsonb_array_elements(n.known_issues) with ordinality a(x, o)
                       where jsonb_typeof(a.x) = 'string'),
      'share', (select coalesce(jsonb_object_agg(e.k, jsonb_build_object(
                    'text', left(coalesce(e.v ->> 'text', ''), 1500),
                    'image', case when coalesce(e.v ->> 'image', '') ~ '^data:image/(jpeg|png|webp);base64,'
                                  then substr(md5(right(e.v ->> 'image', 4096) || length(e.v ->> 'image')::text), 1, 12) end)), '{}'::jsonb)
                  from jsonb_each(n.share) e(k, v) where e.k = any(p_audiences) and jsonb_typeof(e.v) = 'object'))
    order by n.released_at desc, n.id desc), '[]'::jsonb)
    from (select * from release_note
           where current_viewer() is not null and product = coalesce(nullif(p_product, ''), 'vitals')
           order by released_at desc, id desc limit least(greatest(coalesce(p_limit, 20), 1), 50)) n
$$;
revoke all on function pulse.release_notes(text, text[], int) from public;
grant execute on function pulse.release_notes(text, text[], int) to pulse_api;

-- One release's share card picture (a data: address) for one audience; the API checks the audience is the person's.
create function pulse.release_note_card(p_id bigint, p_audience text) returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select n.share -> p_audience ->> 'image' from release_note n
   where current_viewer() is not null and n.id = p_id and jsonb_typeof(n.share -> p_audience) = 'object'
$$;
revoke all on function pulse.release_note_card(bigint, text) from public;
grant execute on function pulse.release_note_card(bigint, text) to pulse_api;

-- migrate:down
drop function pulse.release_note_card(bigint, text);
drop function pulse.release_notes(text, text[], int);
drop table pulse.release_note;

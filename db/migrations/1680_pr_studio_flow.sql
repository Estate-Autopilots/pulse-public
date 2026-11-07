-- migrate:up
-- PR-STUDIO-2 (owner, 7 Nov 2026: "there is no flow, it is cluttered, I can't see what to post where and when, I can't
-- manage the creatives"). One path through PR Studio, left to right: Strategy -> Calendar -> Board -> Library -> Post kit
-- -> Insights, per brand (pulse.pr_brand, 1620). Goals stay in Goals; PR Studio links there.
--   pr_strategy  a brand's plan: positioning, audiences, 3-5 content pillars, channels with their cadence and best times,
--                content KPIs, and the plan laid out month -> week -> day -> hourly slot. A brand starts as a draft and
--                is switched on with one click by a person who manages it (pulse.pr_brand_switch).
--   pr_file      the brand's files kept in Pulse itself (images and PDFs, up to 15 MB each).
--   pr_asset     the creative library: one item per creative (a carousel is one item with its slides), its caption (and
--                the version that names nobody), alt text per slide, why it works, A/B hooks, and the "needs an OK" flag.
--                An item that needs someone's OK is never marked posted before that OK is recorded (pulse.pr_asset_ok).
--   pr_post      what goes out: one card on the board and one slot on the calendar (a channel, a pillar, a format, a day
--                and time). Idea -> Draft -> Design -> Review -> Approved -> Scheduled -> Posted -> Measured.
--                Stages move through pulse.pr_post_move (who may do which step); a trigger keeps the gates whichever way
--                a row is written. Nothing is posted or sent from Pulse: people copy, download and post themselves.
-- Who sees and changes a brand is 1620's rule (pulse.pr_brand_see / pr_brand_edit / pr_brand_role) under forced row
-- security with the tenant policy on every table. Additive.

create table pulse.pr_strategy (
  org_id uuid not null references pulse.org(id),
  brand_id uuid primary key references pulse.pr_brand(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'on')),
  positioning text not null default '' check (length(positioning) <= 1200),
  audiences jsonb not null default '[]' check (jsonb_typeof(audiences) = 'array' and jsonb_array_length(audiences) <= 8 and length(audiences::text) <= 4000),
  pillars jsonb not null default '[]' check (jsonb_typeof(pillars) = 'array' and jsonb_array_length(pillars) <= 5 and length(pillars::text) <= 4000),
  channels jsonb not null default '[]' check (jsonb_typeof(channels) = 'array' and jsonb_array_length(channels) <= 5 and length(channels::text) <= 4000),
  kpis jsonb not null default '[]' check (jsonb_typeof(kpis) = 'array' and jsonb_array_length(kpis) <= 8 and length(kpis::text) <= 3000),
  months jsonb not null default '[]' check (jsonb_typeof(months) = 'array' and jsonb_array_length(months) <= 12 and length(months::text) <= 6000),
  weeks jsonb not null default '[]' check (jsonb_typeof(weeks) = 'array' and jsonb_array_length(weeks) <= 26 and length(weeks::text) <= 8000),
  rules jsonb not null default '[]' check (jsonb_typeof(rules) = 'array' and jsonb_array_length(rules) <= 12 and length(rules::text) <= 4000),
  time_zone text check (time_zone is null or length(time_zone) between 1 and 60),  -- null: the company's zone (R51)
  switched_by uuid references pulse.person(id),
  switched_at timestamptz,
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default now()
);

create table pulse.pr_file (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references pulse.pr_brand(id),
  name text not null check (length(btrim(name)) between 1 and 200 and name !~ '[[:cntrl:]/\\]'),
  mime text not null check (mime in ('image/png', 'image/jpeg', 'image/webp', 'application/pdf')),
  bytes bytea not null check (octet_length(bytes) between 1 and 15728640),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  width int check (width between 1 and 20000),
  height int check (height between 1 and 20000),
  added_by uuid references pulse.person(id),
  added_at timestamptz not null default now()
);
create unique index pr_file_sha on pulse.pr_file (org_id, brand_id, sha256);

create table pulse.pr_asset (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references pulse.pr_brand(id),
  source_key text check (source_key is null or (length(source_key) between 1 and 80 and source_key !~ '\s')),
  title text not null check (length(btrim(title)) between 1 and 200 and title !~ '[[:cntrl:]]'),
  collection text not null default '' check (length(collection) <= 80),
  kind text not null default 'single' check (kind in ('single', 'carousel', 'story', 'header', 'card')),
  size text not null default '' check (length(size) <= 40),
  pillar text not null default '' check (length(pillar) <= 40),
  channel text check (channel is null or channel in ('linkedin', 'x', 'instagram', 'whatsapp_status', 'newsletter')),
  format text not null default '' check (length(format) <= 60),
  caption text not null default '' check (length(caption) <= 6000),
  caption_safe text not null default '' check (length(caption_safe) <= 6000),
  hashtags text[] not null default '{}' check (cardinality(hashtags) <= 30),
  why text not null default '' check (length(why) <= 4000),
  hooks jsonb not null default '{}' check (jsonb_typeof(hooks) = 'object' and length(hooks::text) <= 3000),
  brief jsonb not null default '{}' check (jsonb_typeof(brief) = 'object' and length(brief::text) <= 2000),
  slides jsonb not null default '[]' check (jsonb_typeof(slides) = 'array' and jsonb_array_length(slides) <= 24 and length(slides::text) <= 40000),
  pdf_file_id uuid references pulse.pr_file(id),
  pdf_safe_file_id uuid references pulse.pr_file(id),
  ok_state text not null default 'ready' check (ok_state in ('ready', 'check', 'needs_ok')),
  ok_who text not null default '' check (length(ok_who) <= 120),
  ok_note text not null default '' check (length(ok_note) <= 800),
  ok_given_at timestamptz,
  ok_given_by uuid references pulse.person(id),
  ok_given_note text not null default '' check (length(ok_given_note) <= 500),
  archived boolean not null default false,
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index pr_asset_key on pulse.pr_asset (org_id, brand_id, source_key) where source_key is not null;
create index pr_asset_brand on pulse.pr_asset (org_id, brand_id, created_at);

create table pulse.pr_post (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references pulse.pr_brand(id),
  asset_id uuid references pulse.pr_asset(id),
  source_key text check (source_key is null or (length(source_key) between 1 and 80 and source_key !~ '\s')),
  title text not null check (length(btrim(title)) between 1 and 200 and title !~ '[[:cntrl:]]'),
  stage text not null default 'idea' check (stage in ('idea', 'draft', 'design', 'review', 'approved', 'scheduled', 'posted', 'measured')),
  channel text not null default 'linkedin' check (channel in ('linkedin', 'x', 'instagram', 'whatsapp_status', 'newsletter')),
  pillar text not null default '' check (length(pillar) <= 40),
  format text not null default '' check (length(format) <= 60),
  slot_at timestamptz,
  caption text not null default '' check (length(caption) <= 6000),
  note text not null default '' check (length(note) <= 1000),
  posted_at timestamptz,
  posted_url text check (posted_url is null or (length(posted_url) <= 500 and posted_url ~ '^https://\S+$')),
  posted_by uuid references pulse.person(id),
  metrics jsonb not null default '{}' check (jsonb_typeof(metrics) = 'object' and length(metrics::text) <= 1000),
  measured_at timestamptz,
  moved_by uuid references pulse.person(id),
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pr_post_measured check (stage <> 'measured' or posted_at is not null),
  constraint pr_post_scheduled check (stage <> 'scheduled' or slot_at is not null)
);
create unique index pr_post_key on pulse.pr_post (org_id, brand_id, source_key) where source_key is not null;
create index pr_post_slot on pulse.pr_post (org_id, brand_id, slot_at);
create index pr_post_stage on pulse.pr_post (org_id, brand_id, stage);

create trigger pr_strategy_touch before update on pulse.pr_strategy for each row execute function pulse.pr_touch();
create trigger pr_asset_touch before update on pulse.pr_asset for each row execute function pulse.pr_touch();
create trigger pr_post_touch before update on pulse.pr_post for each row execute function pulse.pr_touch();

-- ------------------------------------------------------------------------------------------------ the gates
-- Every row belongs to a brand of its own company (a brand id from another company is refused, whoever writes).
create function pulse.pr_brand_same_org() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not exists (select 1 from pr_brand b where b.id = new.brand_id and b.org_id = new.org_id) then
   raise exception 'That brand is not this company''s' using errcode = '42501';
 end if;
 return new;
end $$;
create trigger pr_strategy_brand before insert or update on pulse.pr_strategy for each row execute function pulse.pr_brand_same_org();
create trigger pr_file_brand before insert or update on pulse.pr_file for each row execute function pulse.pr_brand_same_org();
create trigger pr_asset_brand before insert or update on pulse.pr_asset for each row execute function pulse.pr_brand_same_org();
create trigger pr_post_brand before insert or update on pulse.pr_post for each row execute function pulse.pr_brand_same_org();

-- Whichever way a post is written (the screens, a script, a future API): nothing is posted before it was approved or
-- scheduled, nothing that needs someone's OK is posted before that OK is recorded, a posted item stays posted, and the
-- API's own writes cannot create an already-approved item unless the writer manages the brand.
create function pulse.pr_post_gate() returns trigger language plpgsql set search_path=pulse,pg_temp as $$
declare a pr_asset; was text := case when tg_op = 'UPDATE' then old.stage end;
begin
 if new.asset_id is not null then
   select * into a from pr_asset where id = new.asset_id;
   if a.id is null or a.brand_id <> new.brand_id then raise exception 'That creative is not in this brand''s library' using errcode = '22023'; end if;
 end if;
 if tg_op = 'INSERT' and pg_has_role(session_user, 'pulse_api', 'member') and new.stage not in ('idea', 'draft', 'design', 'review')
    and coalesce(pr_brand_role(new.brand_id), '') <> 'manager' then
   raise exception 'Only a person who manages the brand adds an item already approved or scheduled' using errcode = '42501';
 end if;
 if new.stage in ('posted', 'measured') and coalesce(was, '') not in ('approved', 'scheduled', 'posted', 'measured') then
   raise exception 'Approve it before posting' using errcode = '22023';
 end if;
 if new.stage in ('posted', 'measured') and coalesce(was, '') not in ('posted', 'measured') then
   if a.id is not null and a.ok_state = 'needs_ok' and a.ok_given_at is null then
     raise exception 'It needs %''s OK first: record it on the creative', coalesce(nullif(a.ok_who, ''), 'their') using errcode = '22023';
   end if;
   new.posted_at := coalesce(new.posted_at, now());
 end if;
 if was in ('posted', 'measured') then
   if new.stage not in ('posted', 'measured') then raise exception 'It is posted already' using errcode = '22023'; end if;
   if new.slot_at is distinct from old.slot_at or new.channel <> old.channel then raise exception 'It is posted already' using errcode = '22023'; end if;
 end if;
 return new;
end $$;
create trigger pr_post_gate before insert or update on pulse.pr_post for each row execute function pulse.pr_post_gate();

-- Move a post along the board. Who may: the brand's managers and editors move ideas to review and schedule what was
-- approved; a manager or an approver (never an AI employee) approves; a person (staff) on the brand marks it posted with
-- its link; numbers are logged once it is posted (stage measured). Back to draft from review or approved.
create function pulse.pr_post_move(p_post uuid, p_to text, p_url text default null, p_metrics jsonb default null) returns text
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare p pr_post; role text; side text := (select side from person where id = current_viewer()); m jsonb := '{}'; k text;
begin
 select * into p from pr_post where id = p_post and org_id = current_org();
 if p.id is null then raise exception 'Post not found' using errcode = 'P0002'; end if;
 role := pr_brand_role(p.brand_id);
 if role is null then raise exception 'Not your brand' using errcode = '42501'; end if;
 if p_to not in ('idea', 'draft', 'design', 'review', 'approved', 'scheduled', 'posted', 'measured') then
   raise exception 'Move it to idea, draft, design, review, approved, scheduled, posted or measured' using errcode = '22023'; end if;
 if p_to in ('idea', 'draft', 'design', 'review') then
   if role = 'approver' and p_to <> 'draft' then raise exception 'An approver approves or sends it back to draft' using errcode = '42501'; end if;
 elsif p_to = 'approved' then
   if side = 'agent' or role = 'editor' then raise exception 'A person who manages or approves the brand approves it' using errcode = '42501'; end if;
   if p.stage not in ('review', 'approved') and role <> 'manager' then raise exception 'Send it to review first' using errcode = '22023'; end if;
 elsif p_to = 'scheduled' then
   if role = 'approver' then raise exception 'The brand''s managers and editors schedule it' using errcode = '42501'; end if;
   if p.stage not in ('approved', 'scheduled') and role <> 'manager' then raise exception 'Approve it before scheduling' using errcode = '22023'; end if;
   if p.slot_at is null then raise exception 'Pick a day and time first' using errcode = '22023'; end if;
 elsif p_to = 'posted' then
   if coalesce(side, '') <> 'staff' then raise exception 'A person posts it' using errcode = '42501'; end if;
   if p_url is not null and (p_url !~ '^https://\S+$' or length(p_url) > 500) then raise exception 'The post link starts with https://' using errcode = '22023'; end if;
 elsif p_to = 'measured' then
   if p.stage not in ('posted', 'measured') then raise exception 'Log numbers once it is posted' using errcode = '22023'; end if;
   if p_metrics is null or jsonb_typeof(p_metrics) <> 'object' then raise exception 'Send the numbers' using errcode = '22023'; end if;
   foreach k in array array['impressions', 'reactions', 'comments', 'shares', 'saves', 'clicks', 'followers'] loop
     if p_metrics ? k and nullif(p_metrics->>k, '') is not null then
       if p_metrics->>k !~ '^\d{1,10}$' then raise exception 'Numbers are whole numbers' using errcode = '22023'; end if;
       m := m || jsonb_build_object(k, (p_metrics->>k)::bigint);
     end if;
   end loop;
   if m = '{}' then raise exception 'Enter at least one number' using errcode = '22023'; end if;
 end if;
 if p.stage in ('posted', 'measured') and p_to not in ('posted', 'measured') then raise exception 'It is posted already' using errcode = '22023'; end if;
 update pr_post set stage = p_to, moved_by = current_viewer(),
   posted_url = case when p_to = 'posted' then coalesce(nullif(btrim(p_url), ''), posted_url) else posted_url end,
   posted_by = case when p_to = 'posted' then current_viewer() else posted_by end,
   metrics = case when p_to = 'measured' then metrics || m else metrics end,
   measured_at = case when p_to = 'measured' then now() else measured_at end
 where id = p.id;
 return p_to;
end $$;

-- Record that the person a creative names said OK (or the client themselves, from their side). Managers and approvers,
-- never an AI employee; a colleague says how the OK was given ("by e-mail on 6 Nov").
create function pulse.pr_asset_ok(p_asset uuid, p_note text) returns timestamptz
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a pr_asset; role text; side text := (select side from person where id = current_viewer());
begin
 select * into a from pr_asset where id = p_asset and org_id = current_org();
 if a.id is null then raise exception 'Creative not found' using errcode = 'P0002'; end if;
 role := pr_brand_role(a.brand_id);
 if role is null or role = 'editor' or side = 'agent' then raise exception 'A person who manages or approves the brand records the OK' using errcode = '42501'; end if;
 if side <> 'client' and length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'Say how they gave their OK (for example "by e-mail on 6 Nov")' using errcode = '22023'; end if;
 update pr_asset set ok_given_at = now(), ok_given_by = current_viewer(), ok_given_note = left(btrim(coalesce(p_note, '')), 500) where id = a.id;
 return now();
end $$;

-- Switch a brand on (or back to a draft) with one click: a person (staff) who manages it.
create function pulse.pr_brand_switch(p_brand uuid, p_on boolean) returns text
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not exists (select 1 from pr_brand where id = p_brand and org_id = current_org()) then raise exception 'Brand not found' using errcode = 'P0002'; end if;
 if coalesce(pr_brand_role(p_brand), '') <> 'manager' or coalesce((select side from person where id = current_viewer()), '') <> 'staff' then
   raise exception 'A person who manages the brand switches it on' using errcode = '42501'; end if;
 insert into pr_strategy (org_id, brand_id, updated_by) values (current_org(), p_brand, current_viewer()) on conflict (brand_id) do nothing;
 update pr_strategy set status = case when p_on then 'on' else 'draft' end, switched_by = current_viewer(), switched_at = now()
  where brand_id = p_brand and org_id = current_org();
 return case when p_on then 'on' else 'draft' end;
end $$;

-- ------------------------------------------------------------------------------------------------ row security
alter table pulse.pr_strategy enable row level security;
alter table pulse.pr_strategy force row level security;
create policy tenant_isolation on pulse.pr_strategy using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy pr_strategy_use on pulse.pr_strategy as restrictive to pulse_api using (pulse.pr_brand_see(brand_id)) with check (pulse.pr_brand_edit(brand_id));

alter table pulse.pr_file enable row level security;
alter table pulse.pr_file force row level security;
create policy tenant_isolation on pulse.pr_file using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy pr_file_use on pulse.pr_file as restrictive to pulse_api using (pulse.pr_brand_see(brand_id)) with check (pulse.pr_brand_edit(brand_id));

alter table pulse.pr_asset enable row level security;
alter table pulse.pr_asset force row level security;
create policy tenant_isolation on pulse.pr_asset using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy pr_asset_use on pulse.pr_asset as restrictive to pulse_api using (pulse.pr_brand_see(brand_id)) with check (pulse.pr_brand_edit(brand_id));

alter table pulse.pr_post enable row level security;
alter table pulse.pr_post force row level security;
create policy tenant_isolation on pulse.pr_post using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy pr_post_use on pulse.pr_post as restrictive to pulse_api using (pulse.pr_brand_see(brand_id)) with check (pulse.pr_brand_edit(brand_id));
-- A posted item is part of the record: it is never removed.
create policy pr_post_keep on pulse.pr_post as restrictive for delete to pulse_api using (stage not in ('posted', 'measured') and pulse.pr_brand_edit(brand_id));

grant select on pulse.pr_strategy to pulse_api;
grant insert (org_id, brand_id, positioning, audiences, pillars, channels, kpis, months, weeks, rules, time_zone, updated_by) on pulse.pr_strategy to pulse_api;
grant update (positioning, audiences, pillars, channels, kpis, months, weeks, rules, time_zone, updated_by, updated_at) on pulse.pr_strategy to pulse_api;
grant select, insert on pulse.pr_file to pulse_api;
grant select on pulse.pr_asset to pulse_api;
grant insert (org_id, brand_id, source_key, title, collection, kind, size, pillar, channel, format, caption, caption_safe, hashtags, why, hooks, brief,
  slides, pdf_file_id, pdf_safe_file_id, ok_state, ok_who, ok_note, created_by) on pulse.pr_asset to pulse_api;
grant update (title, collection, pillar, channel, format, caption, caption_safe, hashtags, why, hooks, slides, ok_state, ok_who, ok_note, archived, updated_at) on pulse.pr_asset to pulse_api;
grant select, delete on pulse.pr_post to pulse_api;
grant insert (org_id, brand_id, asset_id, source_key, title, stage, channel, pillar, format, slot_at, caption, note, created_by) on pulse.pr_post to pulse_api;
grant update (asset_id, title, channel, pillar, format, slot_at, caption, note, updated_at) on pulse.pr_post to pulse_api;

revoke execute on function pulse.pr_post_move(uuid, text, text, jsonb), pulse.pr_asset_ok(uuid, text), pulse.pr_brand_switch(uuid, boolean) from public;
grant execute on function pulse.pr_post_move(uuid, text, text, jsonb), pulse.pr_asset_ok(uuid, text), pulse.pr_brand_switch(uuid, boolean) to pulse_api;

-- migrate:down
-- Forward-only.

-- migrate:up
-- WA-REPORT (owner, 26 Oct 2026: "a 500–1000 page detailed report: pod-wise, single person-wise, each employee, company
-- level, client analysis … keep filling Pulse with that data"): the company's analysis book, loaded edition by edition.
--  * pulse_priv.report_edition: one loaded edition of the book (its version, when it was built, how many printed pages).
--    Exactly one edition is `current`; a load writes a new edition and switches over in one transaction.
--  * pulse_priv.report_page: one page of the book (company chapters, pods / segments / services, a colleague, a client, a
--    project, a group): typed blocks the web draws (key numbers, charts, tables, evidence), its Markdown for export, where
--    it sits in the printed book, the evidence it cites (message ids resolved to this database's chats and messages)
--    and a search vector. A page about a colleague names them by Pulse person id (`subject_id`).
--  * pulse_priv.report_file / report_file_part: the printed book (PDF), its Markdown, and one PDF per colleague, client,
--    pod and company chapter, in 1 MiB parts.
-- Read rules (all through security-definer functions; the tables are closed to the API roles):
--  * admins and leadership read every page and file;
--  * a colleague reads their own page (`person/<their id>`) and its PDF, nothing else;
--  * evidence excerpts come only from imported chats the viewer may read (pulse.wa_reader), so a page never shows a
--    message its reader could not open in Chats.
-- Every page read and download is audited (restricted_read, report_page / report_file). Loading is the owner's job
-- (the loader runs as the database owner); nothing here is granted to write. Additive: new tables and functions only.

create table pulse_priv.report_edition (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 version text not null check (length(version) between 1 and 60),
 title text not null check (length(title) between 1 and 200),
 built_at timestamptz not null,
 loaded_at timestamptz not null default now(),
 pages_printed int,
 chapters int not null default 0,
 stats jsonb not null default '{}' check (jsonb_typeof(stats) = 'object'),
 status text not null default 'loading' check (status in ('loading', 'current', 'old')),
 unique (org_id, version)
);
create unique index report_edition_current on pulse_priv.report_edition (org_id) where status = 'current';

create table pulse_priv.report_page (
 org_id uuid not null references pulse.org(id),
 edition_id uuid not null references pulse_priv.report_edition(id) on delete cascade,
 key text not null check (key ~ '^[a-z]+/[A-Za-z0-9_-]{1,80}$'),
 part text not null check (part in ('company', 'pods', 'people', 'clients', 'projects', 'groups')),
 level smallint not null default 2 check (level between 1 and 4),
 sort int not null,
 title text not null check (length(title) between 1 and 300),
 subtitle text,
 summary text,
 subject_kind text check (subject_kind in ('person', 'client', 'project', 'group')),
 subject_id text,
 blocks jsonb not null check (jsonb_typeof(blocks) = 'array'),
 md text not null,
 evidence jsonb not null default '{}' check (jsonb_typeof(evidence) = 'object'),   -- message id -> [chat id, message id]
 links jsonb not null default '{}' check (jsonb_typeof(links) = 'object'),         -- group key -> chat id
 printed jsonb,                                                                      -- {start, pages} in the printed book
 search tsvector,
 primary key (edition_id, key)
);
create index report_page_subject on pulse_priv.report_page (org_id, subject_kind, subject_id);
create index report_page_sort on pulse_priv.report_page (edition_id, part, sort);
create index report_page_search on pulse_priv.report_page using gin (search);

create table pulse_priv.report_file (
 org_id uuid not null references pulse.org(id),
 edition_id uuid not null references pulse_priv.report_edition(id) on delete cascade,
 key text not null check (key ~ '^(book\.(pdf|md)|slice:[a-z]+/[A-Za-z0-9_-]{1,80})$'),
 mime text not null check (mime in ('application/pdf', 'text/markdown')),
 size bigint not null check (size >= 0),
 sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
 parts int not null check (parts >= 0),
 primary key (edition_id, key)
);
create table pulse_priv.report_file_part (
 edition_id uuid not null,
 key text not null,
 n int not null check (n >= 0),
 data bytea not null,
 primary key (edition_id, key, n),
 foreign key (edition_id, key) references pulse_priv.report_file (edition_id, key) on delete cascade
);

alter table pulse_priv.report_edition enable row level security;
alter table pulse_priv.report_edition force row level security;
create policy tenant on pulse_priv.report_edition using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
alter table pulse_priv.report_page enable row level security;
alter table pulse_priv.report_page force row level security;
create policy tenant on pulse_priv.report_page using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
alter table pulse_priv.report_file enable row level security;
alter table pulse_priv.report_file force row level security;
create policy tenant on pulse_priv.report_file using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
alter table pulse_priv.report_file_part enable row level security;
alter table pulse_priv.report_file_part force row level security;
create policy tenant on pulse_priv.report_file_part using (exists (select 1 from pulse_priv.report_file f where f.edition_id = report_file_part.edition_id
  and f.key = report_file_part.key and f.org_id = pulse.current_org()));
revoke all on pulse_priv.report_edition, pulse_priv.report_page, pulse_priv.report_file, pulse_priv.report_file_part
  from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy;

-- Who may read a page: admins and leadership everything; a colleague their own page.
create function pulse.report_can(p_key text) returns boolean
language sql stable security definer set search_path = pulse, pg_temp as $$
 select viewer_is('admin', 'leadership') or (current_viewer() is not null and p_key = 'person/' || current_viewer()::text)
$$;

create function pulse.report_current() returns uuid
language sql stable security definer set search_path = pulse, pg_temp as $$
 select id from pulse_priv.report_edition where org_id = current_org() and status = 'current'
$$;

-- The editions (leadership and admins): version, when built and loaded, size; the current one first.
create function pulse.report_editions() returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select case when viewer_is('admin', 'leadership') then coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'version', e.version, 'title', e.title,
   'builtAt', e.built_at, 'loadedAt', e.loaded_at, 'pagesPrinted', e.pages_printed, 'chapters', e.chapters, 'status', e.status, 'stats', e.stats)
   order by (e.status = 'current') desc, e.loaded_at desc) from pulse_priv.report_edition e where e.org_id = current_org() and e.status <> 'loading'), '[]') end
$$;

-- The contents, filtered (all optional): part, q (words, searched in titles and text), limit (≤ 500), offset.
-- A colleague who is not a leader sees only their own page.
create function pulse.report_index(p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare ed uuid := coalesce(nullif(p->>'edition', '')::uuid, report_current()); lead boolean := viewer_is('admin', 'leadership');
 q text := nullif(btrim(coalesce(p->>'q', '')), ''); lim int := greatest(1, least(coalesce((p->>'limit')::int, 200), 500)); off int := greatest(0, coalesce((p->>'offset')::int, 0));
 v_part text := nullif(p->>'part', ''); r jsonb;
begin
 if ed is null then return jsonb_build_object('edition', null, 'items', '[]'::jsonb, 'total', 0, 'parts', '{}'::jsonb); end if;
 with base as (
   select pg.* from pulse_priv.report_page pg where pg.org_id = current_org() and pg.edition_id = ed
     and (lead or pg.key = 'person/' || coalesce(current_viewer()::text, '-'))),
 hits as (
   select b.*, case when q is null then 0 else ts_rank(b.search, websearch_to_tsquery('simple', q)) + case when b.title ilike '%' || q || '%' then 1 else 0 end end rank
   from base b where (v_part is null or b.part = v_part)
     and (q is null or b.search @@ websearch_to_tsquery('simple', q) or b.title ilike '%' || q || '%')),
 page as (select * from hits order by case when q is null then 0 else -rank end, sort limit lim offset off)
 select jsonb_build_object(
   'edition', (select jsonb_build_object('id', e.id, 'version', e.version, 'title', e.title, 'builtAt', e.built_at, 'pagesPrinted', e.pages_printed, 'chapters', e.chapters, 'stats', e.stats)
               from pulse_priv.report_edition e where e.id = ed),
   'total', (select count(*) from hits),
   'parts', coalesce((select jsonb_object_agg(x.part, x.n) from (select b.part, count(*) n from base b group by 1) x), '{}'),
   'items', coalesce((select jsonb_agg(jsonb_build_object('key', g.key, 'part', g.part, 'level', g.level, 'title', g.title, 'subtitle', g.subtitle, 'summary', g.summary,
       'subject', case when g.subject_kind is null then null else jsonb_build_object('kind', g.subject_kind, 'id', g.subject_id) end, 'printed', g.printed,
       'snippet', case when q is null then null else ts_headline('simple', left(g.md, 20000), websearch_to_tsquery('simple', q), 'MaxWords=24, MinWords=10, MaxFragments=1, StartSel=«, StopSel=»') end)
     order by case when q is null then 0 else -g.rank end, g.sort) from page g), '[]'))
 into r;
 return r;
end $$;

-- One page: its blocks, where it is printed, the chats and messages its evidence opens, and the pages before and after
-- it in the same part. Null when the viewer may not read it. Audited.
create function pulse.report_page(p_key text, p_edition uuid default null) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare ed uuid := coalesce(p_edition, report_current()); g pulse_priv.report_page%rowtype; r jsonb;
begin
 if ed is null or not report_can(p_key) then return null; end if;
 select * into g from pulse_priv.report_page where org_id = current_org() and edition_id = ed and key = p_key;
 if not found then return null; end if;
 perform audit_write('restricted_read', 'report_page', p_key, '{}');
 select jsonb_build_object('key', g.key, 'part', g.part, 'level', g.level, 'title', g.title, 'subtitle', g.subtitle, 'summary', g.summary, 'blocks', g.blocks,
   'subject', case when g.subject_kind is null then null else jsonb_build_object('kind', g.subject_kind, 'id', g.subject_id) end,
   'printed', g.printed, 'evidence', g.evidence, 'links', g.links,
   'hasPdf', exists (select 1 from pulse_priv.report_file f where f.edition_id = ed and f.key = 'slice:' || g.key),
   'edition', (select jsonb_build_object('id', e.id, 'version', e.version, 'builtAt', e.built_at, 'pagesPrinted', e.pages_printed) from pulse_priv.report_edition e where e.id = ed),
   'prev', case when viewer_is('admin', 'leadership') then (select jsonb_build_object('key', x.key, 'title', x.title) from pulse_priv.report_page x
            where x.edition_id = ed and x.org_id = current_org() and x.part = g.part and x.sort < g.sort order by x.sort desc limit 1) end,
   'next', case when viewer_is('admin', 'leadership') then (select jsonb_build_object('key', x.key, 'title', x.title) from pulse_priv.report_page x
            where x.edition_id = ed and x.org_id = current_org() and x.part = g.part and x.sort > g.sort order by x.sort limit 1) end)
 into r;
 return r;
end $$;

-- The page's Markdown (for export). Same rule, audited.
create function pulse.report_page_md(p_key text) returns text
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare ed uuid := report_current(); t text;
begin
 if ed is null or not report_can(p_key) then return null; end if;
 select md into t from pulse_priv.report_page where org_id = current_org() and edition_id = ed and key = p_key;
 if t is not null then perform audit_write('restricted_read', 'report_page', p_key, array['markdown']); end if;
 return t;
end $$;

-- The report page about a subject (a colleague, a client, a project, a group), for their own page in Pulse: key, title,
-- summary and where it is printed. Same rule.
create function pulse.report_subject(p_kind text, p_id text) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object('key', g.key, 'title', g.title, 'summary', g.summary, 'printed', g.printed)
 from pulse_priv.report_page g where g.org_id = current_org() and g.edition_id = report_current() and g.subject_kind = p_kind and g.subject_id = p_id
   and report_can(g.key) limit 1
$$;

-- Short excerpts of the messages a page cites, only from imported chats the viewer may read (wa_reader).
create function pulse.report_excerpts(p_key text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare ed uuid := report_current(); ev jsonb; r jsonb;
begin
 if ed is null or not report_can(p_key) then return '{}'; end if;
 select evidence into ev from pulse_priv.report_page where org_id = current_org() and edition_id = ed and key = p_key;
 if ev is null or ev = '{}' then return '{}'; end if;
 select coalesce(jsonb_object_agg(k.key, left(regexp_replace(coalesce(m.body, ''), '\s+', ' ', 'g'), 220)), '{}') into r
 from jsonb_each(ev) k join pulse_priv.wa_message m on m.org_id = current_org() and m.id = (k.value->>1)::uuid
 where wa_reader((k.value->>0)::uuid) and m.body is not null;
 return r;
end $$;

-- A file of the current edition: the book (leadership and admins) or one page's PDF (whoever may read the page).
create function pulse.report_file_open(p_key text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare ed uuid := report_current(); f pulse_priv.report_file%rowtype;
begin
 if ed is null then return null; end if;
 if p_key like 'slice:%' then
   if not report_can(substr(p_key, 7)) then return null; end if;
 elsif not viewer_is('admin', 'leadership') then return null; end if;
 select * into f from pulse_priv.report_file where org_id = current_org() and edition_id = ed and key = p_key;
 if not found then return null; end if;
 perform audit_write('restricted_read', 'report_file', p_key, '{}');
 return jsonb_build_object('mime', f.mime, 'size', f.size, 'sha256', f.sha256, 'parts', f.parts,
   'version', (select version from pulse_priv.report_edition where id = ed));
end $$;

create function pulse.report_file_parts(p_key text, p_from int, p_to int) returns table (part int, data bytea)
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare ed uuid := report_current();
begin
 if ed is null then return; end if;
 if p_key like 'slice:%' then
   if not report_can(substr(p_key, 7)) then return; end if;
 elsif not viewer_is('admin', 'leadership') then return; end if;
 return query select x.n, x.data from pulse_priv.report_file_part x join pulse_priv.report_file f on f.edition_id = x.edition_id and f.key = x.key
   where f.org_id = current_org() and x.edition_id = ed and x.key = p_key and x.n between p_from and p_to order by x.n;
end $$;

revoke all on function pulse.report_can(text), pulse.report_current(), pulse.report_editions(), pulse.report_index(jsonb), pulse.report_page(text, uuid),
 pulse.report_page_md(text), pulse.report_subject(text, text), pulse.report_excerpts(text), pulse.report_file_open(text), pulse.report_file_parts(text, int, int) from public;
grant execute on function pulse.report_can(text), pulse.report_current(), pulse.report_editions(), pulse.report_index(jsonb), pulse.report_page(text, uuid),
 pulse.report_page_md(text), pulse.report_subject(text, text), pulse.report_excerpts(text), pulse.report_file_open(text), pulse.report_file_parts(text, int, int) to pulse_api;

-- migrate:down
-- Forward-only.

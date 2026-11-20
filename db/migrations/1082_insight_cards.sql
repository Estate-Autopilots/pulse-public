-- migrate:up
-- INSIGHTS-2 (owner, 26 Oct 2026: "Insights is good but it's ugly … every number a better visualisation … and insights
-- should reach production directly, without waiting for code ships"): data-driven insight cards and the pattern library.
--  * pulse_priv.insight_card: one card on an Insights tab (or a colleague's / client's page): the question it answers,
--    the "so what", the action, key numbers, a chart spec from the vocabulary the web draws (`chart.kind`), its data
--    rows, the evidence it rests on, who may read it (audience) and how fresh it is.
--  * pulse_priv.insight_pattern: the pattern registry PATTERNS mines (statement, family, unit, effect with its interval,
--    support, p / q, replication, stability, value with its arithmetic, action, evidence, an optional chart), searchable.
--  * pulse_priv.insight_run: each mining round or load (counts, the saturation curve), for "How we know".
--  Loaders write these three straight into a running database (data only), so new insights need no code ship.
--  * pulse.insight_ops(filters): the live client-operations facts the Insights tabs draw (stage timings with their
--    spread, where groups stop, answer-time distributions by side and stage, hour x weekday activity by side, colleague
--    load against responsiveness, pods side by side, what clients ask, signals by month), filtered by period, pod,
--    segment and client, cached for six hours per filter. Counts, percentiles and names only, never message text.
-- Read rules (security-definer functions; the tables are closed to the API roles): admins and leadership read every
-- card and pattern; a colleague reads only those whose audience is {"rule": "person", "person_id": <them>}.
-- Additive: new tables and functions only; nothing names a company.

create table pulse_priv.insight_run (
 org_id uuid not null references pulse.org(id),
 id text not null check (id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{1,79}$'),
 source text not null default 'patterns' check (source ~ '^[A-Za-z0-9_-]{2,30}$'),
 kind text not null default 'round' check (kind in ('round', 'load')),
 round int,
 version text check (length(version) <= 60),
 started_at timestamptz not null default now(),
 finished_at timestamptz,
 counts jsonb not null default '{}' check (jsonb_typeof(counts) = 'object'),
 saturation jsonb not null default '[]' check (jsonb_typeof(saturation) = 'array'),
 stats jsonb not null default '{}' check (jsonb_typeof(stats) = 'object'),
 note text check (length(note) <= 2000),
 primary key (org_id, id)
);

create table pulse_priv.insight_pattern (
 org_id uuid not null references pulse.org(id),
 id text not null check (id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{1,79}$'),
 run_id text,
 version int not null default 1 check (version > 0),
 status text not null default 'candidate' check (status in ('confirmed', 'candidate', 'retired')),
 family text not null check (family ~ '^[a-z0-9_]{2,40}$'),
 area text not null check (area ~ '^[a-z_]{2,30}$'),
 unit text check (length(unit) <= 40),
 statement text not null check (length(statement) between 3 and 600),
 detail text check (length(detail) <= 4000),
 outcome text check (length(outcome) <= 200),
 feature text check (length(feature) <= 300),
 segment jsonb not null default '{}' check (jsonb_typeof(segment) = 'object'),
 direction smallint check (direction in (-1, 0, 1)),
 effect_kind text check (length(effect_kind) <= 40),
 effect numeric,
 ci_low numeric,
 ci_high numeric,
 support int check (support >= 0),
 exposed int check (exposed >= 0),
 p_value double precision check (p_value between 0 and 1),
 q_value double precision check (q_value between 0 and 1),
 replication jsonb check (replication is null or jsonb_typeof(replication) = 'object'),
 stability jsonb check (stability is null or jsonb_typeof(stability) = 'object'),
 novelty_key text check (length(novelty_key) <= 200),
 value_inr numeric,
 value_days numeric,
 value_basis text check (length(value_basis) <= 1000),
 action text check (length(action) <= 1000),
 evidence jsonb not null default '{}' check (jsonb_typeof(evidence) = 'object'),
 chart jsonb check (chart is null or (jsonb_typeof(chart) = 'object' and chart ? 'kind')),
 data jsonb not null default '[]' check (jsonb_typeof(data) = 'array'),
 scope jsonb not null default '{}' check (jsonb_typeof(scope) = 'object'),
 audience jsonb not null default '{"rule": "leadership"}' check (jsonb_typeof(audience) = 'object'),
 tags text[] not null default '{}',
 rank int,
 refreshed_at timestamptz not null default now(),
 search tsvector generated always as (to_tsvector('simple', statement || ' ' || coalesce(action, '') || ' ' || family || ' ' || area
   || ' ' || coalesce(outcome, '') || ' ' || coalesce(feature, '') || ' ' || coalesce(unit, ''))) stored,
 primary key (org_id, id)
);
create index insight_pattern_rank on pulse_priv.insight_pattern (org_id, status, rank);
create index insight_pattern_scope on pulse_priv.insight_pattern using gin (scope jsonb_path_ops);
create index insight_pattern_search on pulse_priv.insight_pattern using gin (search);

create table pulse_priv.insight_card (
 org_id uuid not null references pulse.org(id),
 id text not null check (id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{1,79}$'),
 area text not null check (area ~ '^[a-z_]{2,30}$'),
 tab text check (tab ~ '^[a-z_]{2,30}$'),
 ord int not null default 100,
 title text not null check (length(title) between 2 and 200),
 so_what text check (length(so_what) <= 400),
 action text check (length(action) <= 400),
 kpis jsonb not null default '[]' check (jsonb_typeof(kpis) = 'array'),
 chart jsonb not null check (jsonb_typeof(chart) = 'object' and chart ? 'kind'),
 data jsonb not null default '[]' check (jsonb_typeof(data) = 'array'),
 evidence jsonb not null default '{}' check (jsonb_typeof(evidence) = 'object'),
 pattern_ids text[] not null default '{}',
 scope jsonb not null default '{}' check (jsonb_typeof(scope) = 'object'),
 audience jsonb not null default '{"rule": "leadership"}' check (jsonb_typeof(audience) = 'object'),
 source text not null default 'patterns' check (source ~ '^[A-Za-z0-9_-]{2,30}$'),
 version int not null default 1 check (version > 0),
 run_id text,
 refreshed_at timestamptz not null default now(),
 retired_at timestamptz,
 primary key (org_id, id)
);
create index insight_card_area on pulse_priv.insight_card (org_id, area, ord) where retired_at is null;
create index insight_card_scope on pulse_priv.insight_card using gin (scope jsonb_path_ops) where retired_at is null;

create table pulse_priv.insight_ops_cache (
 org_id uuid not null references pulse.org(id),
 key text not null,
 computed_at timestamptz not null default now(),
 data jsonb not null check (jsonb_typeof(data) = 'object'),
 primary key (org_id, key)
);

alter table pulse_priv.insight_run enable row level security;
alter table pulse_priv.insight_run force row level security;
create policy tenant on pulse_priv.insight_run using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
alter table pulse_priv.insight_pattern enable row level security;
alter table pulse_priv.insight_pattern force row level security;
create policy tenant on pulse_priv.insight_pattern using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
alter table pulse_priv.insight_card enable row level security;
alter table pulse_priv.insight_card force row level security;
create policy tenant on pulse_priv.insight_card using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
alter table pulse_priv.insight_ops_cache enable row level security;
alter table pulse_priv.insight_ops_cache force row level security;
create policy tenant on pulse_priv.insight_ops_cache using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse_priv.insight_run, pulse_priv.insight_pattern, pulse_priv.insight_card, pulse_priv.insight_ops_cache
  from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy;

-- Who may read a card or a pattern: admins and leadership all; a colleague one whose audience names them.
create function pulse.insight_can(p_audience jsonb) returns boolean
language sql stable security definer set search_path = pulse, pg_temp as $$
 select viewer_is('admin', 'leadership')
   or (p_audience->>'rule' = 'person' and current_viewer() is not null and p_audience->>'person_id' = current_viewer()::text)
$$;

-- Evidence keys to this database's ids: dataset group keys (wa_chat.source_key) and message keys (wa_message.import_key,
-- as tools/wa-import.py stores them) become chats and messages a link can open; Pulse ids pass through.
create function pulse.insight_evidence(p jsonb) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object(
  'chats', coalesce((select jsonb_agg(distinct jsonb_build_object('id', w.id, 'title', w.title, 'channelId', w.channel_id)) from pulse_priv.wa_chat w
     where w.org_id = current_org() and (w.source_key in (select jsonb_array_elements_text(coalesce(p->'group_ids', '[]')))
       or w.id::text in (select jsonb_array_elements_text(coalesce(p->'chat_ids', '[]'))))), '[]'),
  'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'chatId', m.chat_id, 'at', m.sent_at)) from (
     select m.id, m.chat_id, m.sent_at from pulse_priv.wa_message m where m.org_id = current_org() and m.import_key in (
       select encode(sha256(convert_to('wa-import/1:' || k, 'UTF8')), 'hex') from jsonb_array_elements_text(coalesce(p->'message_ids', '[]')) k) limit 20) m), '[]'),
  'clients', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.display_name)) from client c where c.org_id = current_org()
     and c.id::text in (select jsonb_array_elements_text(coalesce(p->'client_ids', '[]')))), '[]'),
  'people', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.display_name)) from person x where x.org_id = current_org()
     and x.id::text in (select jsonb_array_elements_text(coalesce(p->'person_ids', '[]')))), '[]'),
  'projects', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name)) from project x where x.org_id = current_org()
     and x.id::text in (select jsonb_array_elements_text(coalesce(p->'project_ids', '[]')))), '[]'),
  'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title)) from task x where x.org_id = current_org()
     and x.id::text in (select jsonb_array_elements_text(coalesce(p->'task_ids', '[]')))), '[]'))
$$;

-- The cards of an area (an Insights tab; `areas` takes several names) or about one subject: {area?, areas?, scope: {person_id | client_id | project_id | pod}?}.
-- Without a scope only company-wide cards (an empty scope) show. Retired cards never show.
create function pulse.insight_cards(p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'area', c.area, 'tab', c.tab, 'ord', c.ord, 'title', c.title, 'soWhat', c.so_what, 'action', c.action,
   'kpis', c.kpis, 'chart', c.chart, 'data', c.data, 'evidence', c.evidence, 'patternIds', c.pattern_ids, 'scope', c.scope,
   'source', c.source, 'version', c.version, 'refreshedAt', c.refreshed_at) order by c.ord, c.id), '[]')
 from pulse_priv.insight_card c
 where c.org_id = current_org() and c.retired_at is null
   and (nullif(p->>'area', '') is null or c.area = p->>'area' or c.tab = p->>'area')
   and (jsonb_typeof(p->'areas') is distinct from 'array' or c.area in (select jsonb_array_elements_text(p->'areas'))
        or c.tab in (select jsonb_array_elements_text(p->'areas')))
   and (case when p->'scope' is null or (p->'scope') = '{}' then c.scope = '{}' else c.scope @> (p->'scope') end)
   and insight_can(c.audience)
$$;

-- The pattern library, filtered (all optional): q (words), family, area, status (default: confirmed and candidate),
-- scope {person_id | client_id | project_id | pod}, minValue (₹), sort (value | support | effect | recent),
-- limit (≤ 200), offset. Facet counts over everything the viewer may read.
create function pulse.insight_patterns(p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare q text := nullif(btrim(coalesce(p->>'q', '')), ''); lim int := greatest(1, least(coalesce((p->>'limit')::int, 60), 200));
 off int := greatest(0, coalesce((p->>'offset')::int, 0)); srt text := coalesce(p->>'sort', 'value'); r jsonb;
begin
 with vis as (
   select x.* from pulse_priv.insight_pattern x where x.org_id = current_org() and x.status <> 'retired' and insight_can(x.audience)
     and (p->'scope' is null or (p->'scope') = '{}' or x.scope @> (p->'scope'))),
 hits as (
   select v.*, case when q is null then 0 else ts_rank(v.search, websearch_to_tsquery('simple', q)) end rnk from vis v
   where (q is null or v.search @@ websearch_to_tsquery('simple', q) or v.statement ilike '%' || q || '%')
     and (nullif(p->>'family', '') is null or v.family = p->>'family')
     and (nullif(p->>'area', '') is null or v.area = p->>'area')
     and (nullif(p->>'status', '') is null or v.status = p->>'status')
     and (nullif(p->>'minValue', '') is null or coalesce(v.value_inr, 0) >= (p->>'minValue')::numeric)),
 ordered as (select h.*, row_number() over (order by
     case srt when 'support' then -coalesce(h.support, 0)::numeric when 'effect' then -abs(coalesce(h.effect, 0))
       when 'recent' then -extract(epoch from h.refreshed_at)::numeric else coalesce(h.rank, 2147483647)::numeric - coalesce(h.value_inr, 0) / 1e12 end,
     -h.rnk, h.id) o from hits h),
 page as (select * from ordered where o > off and o <= off + lim)
 select jsonb_build_object(
   'total', (select count(*) from hits), 'all', (select count(*) from vis),
   'facets', jsonb_build_object(
     'family', coalesce((select jsonb_object_agg(k, n) from (select family k, count(*) n from vis group by 1) f), '{}'),
     'area', coalesce((select jsonb_object_agg(k, n) from (select area k, count(*) n from vis group by 1) f), '{}'),
     'status', coalesce((select jsonb_object_agg(k, n) from (select status k, count(*) n from vis group by 1) f), '{}')),
   'items', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'family', g.family, 'area', g.area, 'unit', g.unit, 'statement', g.statement,
       'outcome', g.outcome, 'segment', g.segment, 'direction', g.direction, 'effectKind', g.effect_kind, 'effect', g.effect, 'ciLow', g.ci_low, 'ciHigh', g.ci_high,
       'support', g.support, 'exposed', g.exposed, 'q', g.q_value, 'status', g.status, 'replication', g.replication, 'stability', g.stability,
       'valueInr', g.value_inr, 'valueDays', g.value_days, 'valueBasis', g.value_basis, 'action', g.action, 'rank', g.rank, 'tags', g.tags, 'scope', g.scope,
       'chart', case when pg_column_size(g.chart) + pg_column_size(g.data) <= 16000 then g.chart end,
       'data', case when pg_column_size(g.chart) + pg_column_size(g.data) <= 16000 then g.data else '[]'::jsonb end,
       'hasEvidence', g.evidence <> '{}', 'refreshedAt', g.refreshed_at) order by g.o) from page g), '[]'))
 into r;
 return r;
end $$;

-- One pattern with everything, its evidence resolved to chats, messages, clients and people. Null when not readable.
create function pulse.insight_pattern(p_id text) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select to_jsonb(g) - 'org_id' - 'search' - 'evidence' || jsonb_build_object('evidence', insight_evidence(g.evidence))
 from pulse_priv.insight_pattern g
 where g.org_id = current_org() and g.id = p_id and g.status <> 'retired' and insight_can(g.audience)
$$;

-- The mining rounds and loads, oldest first (the saturation curve), with what the registry and the cards hold and
-- how much of the chats it rests on. Leadership and admins.
create function pulse.insight_runs() returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select case when viewer_is('admin', 'leadership') then jsonb_build_object(
   'runs', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'source', r.source, 'kind', r.kind, 'round', r.round, 'version', r.version,
       'startedAt', r.started_at, 'finishedAt', r.finished_at, 'counts', r.counts, 'stats', r.stats) order by r.started_at, r.id)
     from pulse_priv.insight_run r where r.org_id = current_org()), '[]'),
   'saturation', (select r.saturation from pulse_priv.insight_run r where r.org_id = current_org() and jsonb_array_length(r.saturation) > 0
     order by r.started_at desc, r.id desc limit 1),
   'patterns', (select jsonb_build_object('confirmed', count(*) filter (where status = 'confirmed'), 'candidate', count(*) filter (where status = 'candidate'),
       'families', count(distinct family), 'refreshedAt', max(refreshed_at)) from pulse_priv.insight_pattern where org_id = current_org() and status <> 'retired'),
   'cards', (select jsonb_build_object('n', count(*), 'refreshedAt', max(refreshed_at)) from pulse_priv.insight_card where org_id = current_org() and retired_at is null),
   'data', (select jsonb_build_object('groups', count(*), 'messages', coalesce(sum(messages), 0), 'from', min(first_at), 'to', max(last_at),
       'clients', count(distinct client_id), 'readAt', (select max(as_of) from pulse_priv.wa_insight where org_id = current_org()))
     from pulse_priv.wa_chat where org_id = current_org())) end
$$;

-- The live client-operations facts, filtered: {since: date, pod: text ('none' = no clear pod), segment, client: uuid}.
-- A group's pod is the pod (people_profile) of the colleagues who wrote 60%+ of its team messages, else none; its segment
-- is its project's first segment code. Working minutes as in 1015/1053 (wa_response.working_s). Leadership and admins.
create function pulse.insight_ops(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare d jsonb; c pulse_priv.insight_ops_cache%rowtype; tz text := org_time_zone();
 f_since timestamptz; f_pod text := nullif(p->>'pod', ''); f_seg text := nullif(p->>'segment', ''); f_client uuid; k text;
begin
 if not viewer_is('admin', 'leadership') then return null; end if;
 begin f_since := (nullif(p->>'since', '')::date)::timestamp at time zone tz; exception when others then f_since := null; end;
 begin f_client := nullif(p->>'client', '')::uuid; exception when others then f_client := null; end;
 k := md5(concat_ws('|', f_since, f_pod, f_seg, f_client));
 select * into c from pulse_priv.insight_ops_cache where org_id = current_org() and key = k;
 if found and coalesce(p->>'fresh', '') <> '1' and c.computed_at > now() - interval '6 hours'
    and c.computed_at >= coalesce((select max(as_of) from pulse_priv.wa_insight where org_id = current_org()), '-infinity')
    and c.computed_at >= coalesce((select max(updated_at) from pulse_priv.wa_chat where org_id = current_org()), '-infinity') then
  return c.data;
 end if;

 create temp table if not exists _io_chat (id uuid primary key, first_at timestamptz, last_at timestamptz, client_id uuid, pod text, segment text, picked boolean) on commit drop;
 truncate _io_chat;
 insert into _io_chat
 with pc as (select pa.chat_id, pp.pod, sum(pa.messages) n from pulse_priv.wa_participant pa
               join people_profile pp on pp.org_id = pa.org_id and pp.person_id = pa.person_id
              where pa.org_id = current_org() and pa.kind = 'colleague' and coalesce(btrim(pp.pod), '') <> '' group by 1, 2),
      top as (select distinct on (chat_id) chat_id, pod, n::numeric / nullif(sum(n) over (partition by chat_id), 0) s from pc order by chat_id, n desc)
 select w.id, w.first_at, w.last_at, w.client_id,
        coalesce(case when t.s >= 0.6 then t.pod end, 'none'),
        coalesce((select case when x = 'L' then 'Lux' else x end from (select nullif(btrim(split_part(split_part(pr.segment, '+', 1), ' ', 1)), '') x) y), 'none'),
        false
   from pulse_priv.wa_chat w left join top t on t.chat_id = w.id left join project pr on pr.org_id = w.org_id and pr.id = w.project_id
  where w.org_id = current_org();
 update _io_chat set picked = (f_pod is null or pod = f_pod) and (f_seg is null or segment = f_seg) and (f_client is null or client_id = f_client)
   and (f_since is null or last_at >= f_since);

 create temp table if not exists _io_msg (id uuid, chat_id uuid, sent_at timestamptz, hour int, dow int, side text, person_id uuid, media_type text) on commit drop;
 truncate _io_msg;
 insert into _io_msg
 select m.id, m.chat_id, m.sent_at, substr(m.local_time, 12, 2)::int, extract(isodow from left(m.local_time, 10)::date)::int,
        case when pa.kind = 'colleague' then 'team' when pa.kind in ('client', 'contact', 'number') then 'client' else 'unknown' end, pa.person_id, m.media_type
   from pulse_priv.wa_message m join _io_chat ch on ch.id = m.chat_id and ch.picked
   join pulse_priv.wa_participant pa on pa.org_id = m.org_id and pa.id = m.participant_id
  where m.org_id = current_org() and (f_since is null or m.sent_at >= f_since) and m.local_time ~ '^\d{4}-\d\d-\d\d.\d\d';

 with chm as (select i.subject_id chat_id, i.metrics m, ch.pod, ch.first_at from pulse_priv.wa_insight i join _io_chat ch on ch.id = i.subject_id
              where i.org_id = current_org() and i.subject = 'chat' and ch.picked and (f_since is null or ch.first_at >= f_since)),
  allchm as (select i.subject_id chat_id, i.metrics m, ch.pod, ch.segment from pulse_priv.wa_insight i join _io_chat ch on ch.id = i.subject_id
              where i.org_id = current_org() and i.subject = 'chat' and (f_seg is null or ch.segment = f_seg) and (f_client is null or ch.client_id = f_client)
                and (f_since is null or ch.first_at >= f_since)),
  stg as (select s.chat_id, s.stage, s.first_at, s.last_at, extract(epoch from s.first_at - ch.first_at) / 86400 sday
            from pulse_priv.wa_chat_stage s join _io_chat ch on ch.id = s.chat_id and ch.picked
           where s.org_id = current_org() and s.stage <> 'quiet' and (f_since is null or ch.first_at >= f_since)),
  resp as (select r.responder_side side, r.working_s / 60.0 wm, r.waited_s / 60.0 cm, m.chat_id, m.sent_at, pa.person_id
             from pulse_priv.wa_response r join _io_msg m on m.id = r.message_id
             left join pulse_priv.wa_participant pa on pa.org_id = r.org_id and pa.id = r.responder_participant
            where r.org_id = current_org() and r.responder_side in ('team', 'client')),
  rstage as (select r.side, r.wm, coalesce((select s.stage from pulse_priv.wa_chat_stage s where s.org_id = current_org() and s.chat_id = r.chat_id
                and s.stage <> 'quiet' and s.first_at <= r.sent_at order by s.first_at desc limit 1), 'onboarding') stage from resp r),
  edge as (select max(last_at) t from _io_chat where picked),
  sig as (select g.kind, g.chat_id, g.at from pulse_priv.wa_signal g join _io_chat ch on ch.id = g.chat_id and ch.picked
           where g.org_id = current_org() and (f_since is null or g.at >= f_since)),
  cs as (select s.intent, s.topics, m.sent_at, ch.first_at from pulse_priv.wa_message_signal s join _io_msg m on m.id = s.message_id and m.side = 'client'
           join _io_chat ch on ch.id = m.chat_id where s.org_id = current_org())
 select jsonb_build_object(
  'computedAt', now(),
  'filters', jsonb_build_object('since', p->>'since', 'pod', f_pod, 'segment', f_seg, 'client', f_client),
  'facets', jsonb_build_object(
    'pods', (select coalesce(jsonb_agg(jsonb_build_object('key', pod, 'n', n) order by pod = 'none', n desc), '[]') from (select pod, count(*) n from _io_chat group by 1) x),
    'segments', (select coalesce(jsonb_agg(jsonb_build_object('key', segment, 'n', n) order by segment = 'none', n desc), '[]') from (select segment, count(*) n from _io_chat group by 1) x),
    'clients', (select coalesce(jsonb_agg(jsonb_build_object('id', x.client_id, 'name', cl.display_name, 'n', x.n) order by cl.display_name), '[]')
       from (select client_id, count(*) n from _io_chat where client_id is not null group by 1) x join client cl on cl.id = x.client_id)),
  'groups', (select count(*) from _io_chat where picked),
  'messages', (select count(*) from _io_msg),
  'clients', (select count(distinct client_id) from _io_chat where picked),
  'from', (select min(sent_at) from _io_msg), 'to', (select max(sent_at) from _io_msg),
  'path', jsonb_build_object(
    'started', (select count(*) from chm),
    'stages', (select coalesce(jsonb_agg(jsonb_build_object('stage', stage, 'reached', n, 'p50', round(p50::numeric, 1), 'p90', round(p90::numeric, 1)) order by p50), '[]') from (
        select stage, count(*) n, percentile_cont(0.5) within group (order by sday) p50, percentile_cont(0.9) within group (order by sday) p90 from stg group by 1) x),
    'steps', (select coalesce(jsonb_agg(jsonb_build_object('key', x.key, 'n', x.n, 'p25', round(x.p25::numeric, 1), 'p50', round(x.p50::numeric, 1),
        'p75', round(x.p75::numeric, 1), 'p90', round(x.p90::numeric, 1)) order by x.o), '[]') from (
        select k.key, k.o, count(v) n, percentile_cont(0.25) within group (order by v) p25, percentile_cont(0.5) within group (order by v) p50,
               percentile_cont(0.75) within group (order by v) p75, percentile_cont(0.9) within group (order by v) p90
          from (values ('startToLive', 'days_start_to_live', 0), ('briefToCreative', 'days_brief_to_creative', 1), ('creativeToApproval', 'days_creative_to_approval', 2),
                       ('approvalToLive', 'days_approval_to_live', 3), ('liveToPayment', 'days_live_to_payment', 4)) k(key, col, o)
          left join lateral (select (chm.m->>k.col)::numeric v from chm where chm.m->>k.col is not null and (chm.m->>k.col)::numeric >= 0) vv on true
         group by k.key, k.o) x),
    'liveHist', (select coalesce(jsonb_agg(jsonb_build_object('lo', b.lo, 'hi', b.hi, 'n', (select count(*) from chm where (chm.m->>'days_start_to_live')::numeric >= b.lo
        and (b.hi is null or (chm.m->>'days_start_to_live')::numeric < b.hi))) order by b.lo), '[]')
        from (values (0, 3), (3, 7), (7, 14), (14, 30), (30, 60), (60, null)) b(lo, hi)),
    'trend', (select coalesce(jsonb_agg(jsonb_build_object('quarter', q, 'n', n, 'p50', round(p50::numeric, 1)) order by q), '[]') from (
        select to_char(chm.first_at at time zone tz, 'YYYY') || '-Q' || to_char(chm.first_at at time zone tz, 'Q') q, count(*) n,
               percentile_cont(0.5) within group (order by (chm.m->>'days_start_to_live')::numeric) p50
          from chm where chm.m->>'days_start_to_live' is not null group by 1) x),
    'stalls', (select coalesce(jsonb_agg(jsonb_build_object('stage', stage, 'n', n) order by n desc), '[]') from (
        select l.stage, count(*) n from (select distinct on (s.chat_id) s.chat_id, s.stage from stg s order by s.chat_id, s.last_at desc) l
          join _io_chat ch on ch.id = l.chat_id
         where not exists (select 1 from stg s2 where s2.chat_id = l.chat_id and s2.stage = 'live') and ch.last_at < (select t from edge) - interval '30 days'
         group by 1) x),
    'live', (select count(distinct chat_id) from stg where stage = 'live')),
  'waits', jsonb_build_object(
    'sides', (select coalesce(jsonb_object_agg(side, jsonb_build_object('n', n, 'p50', round(p50::numeric, 1), 'p75', round(p75::numeric, 1), 'p90', round(p90::numeric, 1),
        'wallP50', round(w50::numeric, 1))), '{}') from (
        select side, count(*) n, percentile_cont(0.5) within group (order by wm) p50, percentile_cont(0.75) within group (order by wm) p75,
               percentile_cont(0.9) within group (order by wm) p90, percentile_cont(0.5) within group (order by cm) w50 from resp group by 1) x),
    'hist', (select coalesce(jsonb_agg(jsonb_build_object('side', s.side, 'lo', b.lo, 'hi', b.hi, 'n', (select count(*) from resp r where r.side = s.side and r.wm >= b.lo
        and (b.hi is null or r.wm < b.hi))) order by s.side, b.lo), '[]')
        from (values ('team'), ('client')) s(side) cross join (values (0, 5), (5, 15), (15, 30), (30, 60), (60, 120), (120, 240), (240, 540), (540, 1620), (1620, null)) b(lo, hi)),
    'byStage', (select coalesce(jsonb_agg(jsonb_build_object('stage', stage, 'side', side, 'n', n, 'p50', round(p50::numeric, 1)) order by stage, side), '[]') from (
        select stage, side, count(*) n, percentile_cont(0.5) within group (order by wm) p50 from rstage group by 1, 2) x),
    'heat', (select coalesce(jsonb_agg(jsonb_build_object('side', side, 'dow', dow, 'hour', hour, 'n', n) order by side, dow, hour), '[]') from (
        select side, dow, hour, count(*) n from _io_msg where side in ('team', 'client') group by 1, 2, 3) x),
    'afterHours', (select jsonb_object_agg(side, round(v::numeric, 3)) from (select side, avg(case when hour < 10 or hour >= 19 or dow = 7 then 1 else 0 end) v
        from _io_msg where side in ('team', 'client') group by 1) x),
    'voice', (select jsonb_object_agg(side, round(v::numeric, 3)) from (select side, avg(case when media_type in ('voice', 'audio') then 1 else 0 end) v
        from _io_msg where side in ('team', 'client') group by 1) x),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('id', x.person_id, 'name', pe.display_name, 'pod', nullif(btrim(pp.pod), ''), 'messages', x.n,
        'groups', x.g, 'answers', r.n, 'p50', round(r.p50::numeric, 1), 'afterHours', round(x.ah::numeric, 3)) order by x.n desc), '[]') from (
        select person_id, count(*) n, count(distinct chat_id) g, avg(case when hour < 10 or hour >= 19 or dow = 7 then 1 else 0 end) ah
          from _io_msg where side = 'team' and person_id is not null group by 1 having count(*) >= 20) x
        join person pe on pe.id = x.person_id left join people_profile pp on pp.org_id = pe.org_id and pp.person_id = x.person_id
        left join lateral (select count(*) n, percentile_cont(0.5) within group (order by wm) p50 from resp where resp.side = 'team' and resp.person_id = x.person_id) r on true),
    'pods', (select coalesce(jsonb_agg(jsonb_build_object('pod', pod, 'groups', g, 'live', round(lv::numeric, 1)) order by pod = 'none', g desc), '[]') from (
        select a.pod, count(*) g, percentile_cont(0.5) within group (order by (a.m->>'days_start_to_live')::numeric) lv from allchm a group by 1) x)),
  'asks', jsonb_build_object(
    'intents', (select coalesce(jsonb_agg(jsonb_build_object('key', intent, 'n', n, 'firstWeek', fw) order by n desc), '[]') from (
        select intent, count(*) n, count(*) filter (where sent_at < first_at + interval '7 days') fw from cs where intent not in ('other', 'greeting') group by 1) x),
    'topics', (select coalesce(jsonb_agg(jsonb_build_object('key', t, 'n', n, 'firstWeek', fw) order by n desc), '[]') from (
        select t, count(*) n, count(*) filter (where sent_at < first_at + interval '7 days') fw from cs cross join unnest(cs.topics) t group by 1) x),
    'clientMessages', (select count(*) from _io_msg where side = 'client'),
    'firstWeekMessages', (select count(*) from _io_msg m join _io_chat ch on ch.id = m.chat_id where m.side = 'client' and m.sent_at < ch.first_at + interval '7 days')),
  'wrong', jsonb_build_object(
    'signals', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'n', n, 'groups', g) order by n desc), '[]') from (
        select kind, count(*) n, count(distinct chat_id) g from sig group by 1) x),
    'months', (select coalesce(jsonb_agg(jsonb_build_object('month', mon, 'kind', kind, 'n', n) order by mon, kind), '[]') from (
        select to_char(at at time zone tz, 'YYYY-MM') mon, kind, count(*) n from sig where kind in ('complaint', 'lead_quality', 'delay', 'churn_risk') group by 1, 2) x),
    'funds', (select jsonb_build_object('asks', count(*), 'groups', count(distinct m.chat_id)) from pulse_priv.wa_message m join _io_msg x on x.id = m.id and x.side = 'team'
        where m.org_id = current_org() and m.kind in ('text', 'media') and m.body ~* '\m(add|top.?up|recharge|load)\M.{0,40}\m(fund|funds|balance|budget)\M')))
 into d;
 delete from pulse_priv.insight_ops_cache where org_id = current_org() and (key = k or computed_at < now() - interval '1 day');
 insert into pulse_priv.insight_ops_cache (org_id, key, computed_at, data) values (current_org(), k, now(), d);
 return d;
end $$;

revoke all on function pulse.insight_can(jsonb), pulse.insight_evidence(jsonb), pulse.insight_cards(jsonb), pulse.insight_patterns(jsonb), pulse.insight_pattern(text),
  pulse.insight_runs(), pulse.insight_ops(jsonb) from public;
grant execute on function pulse.insight_can(jsonb), pulse.insight_evidence(jsonb), pulse.insight_cards(jsonb), pulse.insight_patterns(jsonb), pulse.insight_pattern(text),
  pulse.insight_runs(), pulse.insight_ops(jsonb) to pulse_api;

-- migrate:down
-- Forward-only.

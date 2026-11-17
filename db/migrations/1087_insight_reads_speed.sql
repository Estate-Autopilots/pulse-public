-- migrate:up
-- INSIGHTS-2: the card and pattern reads (1082) decide who may read once per call instead of once per row. With the
-- registry loaded (about 21,000 patterns on pulse_dev) the per-row role lookup made the library take 2-3 s. Same
-- rules: admins and leadership everything; a colleague only rows whose audience names them. Functions only.

create or replace function pulse.insight_cards(p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'area', c.area, 'tab', c.tab, 'ord', c.ord, 'title', c.title, 'soWhat', c.so_what, 'action', c.action,
   'kpis', c.kpis, 'chart', c.chart, 'data', c.data, 'evidence', c.evidence, 'patternIds', c.pattern_ids, 'scope', c.scope,
   'source', c.source, 'version', c.version, 'refreshedAt', c.refreshed_at) order by c.ord, c.id), '[]')
 from pulse_priv.insight_card c, (select viewer_is('admin', 'leadership') lead, current_viewer()::text me) v
 where c.org_id = current_org() and c.retired_at is null
   and (nullif(p->>'area', '') is null or c.area = p->>'area' or c.tab = p->>'area')
   and (jsonb_typeof(p->'areas') is distinct from 'array' or c.area in (select jsonb_array_elements_text(p->'areas'))
        or c.tab in (select jsonb_array_elements_text(p->'areas')))
   and (case when p->'scope' is null or (p->'scope') = '{}' then c.scope = '{}' else c.scope @> (p->'scope') end)
   and (v.lead or (c.audience->>'rule' = 'person' and v.me is not null and c.audience->>'person_id' = v.me))
$$;

create or replace function pulse.insight_patterns(p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare q text := nullif(btrim(coalesce(p->>'q', '')), ''); lim int := greatest(1, least(coalesce((p->>'limit')::int, 60), 200));
 off int := greatest(0, coalesce((p->>'offset')::int, 0)); srt text := coalesce(p->>'sort', 'value'); r jsonb;
 lead boolean := viewer_is('admin', 'leadership'); me text := current_viewer()::text;
begin
 with vis as (
   select x.* from pulse_priv.insight_pattern x where x.org_id = current_org() and x.status <> 'retired'
     and (lead or (x.audience->>'rule' = 'person' and me is not null and x.audience->>'person_id' = me))
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

-- migrate:down
-- Forward-only.

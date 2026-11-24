-- migrate:up
-- EA-PATTERNS round 2 (owner, 15 Nov 2026: "The WhatsApp data is just analysed, not indexed. There is no RAG, no vector
-- database, no decision models."): the company memory. One searchable index over everything a company writes down —
-- imported WhatsApp groups, Pulse conversations, tasks, meeting transcripts, docs and invoice lines — so people and AI
-- employees can ask "which clients complained about delays in October?" and get answers with citations; plus simple,
-- explainable decision models (client churn risk, late-payment risk, deliverable delay risk) with their reasons.
--  * memory.chunk: a piece of one source (a run of messages in one conversation, one task, one meeting stretch, one doc
--    section, one invoice) with who / when / client / project, the events it holds (request, complaint, approval,
--    payment, change, delivery…), its words (tsvector) and a multilingual embedding (multilingual-e5-small, 384-d,
--    computed on this server by tools/company-memory.py; no text leaves the server). Built nightly from the sources,
--    read-only on them; a chunk whose source is gone is removed.
--  * memory.term: in how many chunks each word appears (BM25 word ranking), refreshed by the indexer.
--  * memory.index_run: each refresh, its counts and model.
--  * memory.risk_score / memory.model_card: the decision models' scores with reasons, and how each model did on past
--    data (what it would have predicted against what happened).
-- Who reads (no runtime role has any grant on the tables; only these functions, each applying the reader's access):
--  * pulse.memory_search(p): people and AI employees. A chunk is shown only when its source is readable to the viewer:
--    imported chats through pulse.wa_reader / pulse.chat_browse (as 1099), Pulse conversations through membership,
--    tasks exactly as pulse.task's row security (task_visible_ids, privacy, not deleted), meetings through pulse.meeting_can, docs
--    through pulse.doc_can_see, invoice lines only with pulse.money_can('money.read'). AI employees never receive the
--    original text of an imported WhatsApp chat: they get the redacted text of 1099's history pieces covering the same
--    time (people, companies and numbers as ids) or the citation alone.
--  * pulse.memory_risks(p): the scores a viewer may see (leaders and admins all; a client's relationship owner or its
--    project's PGS their own clients; a task's assignee their own tasks; late-payment risk only with money access).
--  * pulse.memory_status(): the last refresh and the model cards.
-- Additive: a new schema, new tables and functions only.

create schema if not exists memory;
revoke all on schema memory from public;

create table memory.chunk (
 org_id uuid not null,
 id uuid primary key default gen_random_uuid(),
 source_kind text not null check (source_kind in ('whatsapp', 'chat', 'task', 'meeting', 'doc', 'invoice')),
 source_key text not null check (source_key ~ '^[0-9A-Za-z_.:-]{3,200}$'),   -- stable per source piece
 access text not null check (access in ('wa_chat', 'chat', 'task', 'meeting', 'doc', 'money', 'staff')),
 access_ref uuid,                                -- wa_chat / task / meeting / doc id that decides who may read it
 channel_id uuid,                                -- the Pulse conversation, when the source is a conversation
 message_id uuid,                                -- its first Pulse message (the citation's link target)
 client_id uuid,
 project_id uuid,
 persons uuid[] not null default '{}',           -- Pulse people who wrote or own it
 speakers text[] not null default '{}',          -- as Pulse shows them
 first_at timestamptz not null,
 last_at timestamptz not null,
 title text not null check (length(title) between 1 and 300),
 body text not null check (length(body) between 1 and 8000),
 events text[] not null default '{}',            -- request, complaint, approval, payment, change, deliverable, delay…
 langs text[] not null default '{}',
 link text check (length(link) <= 400 and link ~ '^/[^[:space:]]*$'),
 content_hash text not null check (content_hash ~ '^[0-9a-f]{16,64}$'),
 tsv tsvector generated always as (to_tsvector('simple', title || ' ' || body)) stored,
 words int generated always as (length(to_tsvector('simple', title || ' ' || body))) stored,
 embedding public.halfvec(384),
 model text check (length(model) <= 80),
 indexed_at timestamptz not null default now(),
 unique (org_id, source_key), unique (org_id, id),
 check (last_at >= first_at)
);
create index memory_chunk_tsv on memory.chunk using gin (tsv);
create index memory_chunk_client on memory.chunk (org_id, client_id, first_at);
create index memory_chunk_time on memory.chunk (org_id, first_at);
create index memory_chunk_kind on memory.chunk (org_id, source_kind, first_at);
create index memory_chunk_events on memory.chunk using gin (events);
create index memory_chunk_vec on memory.chunk using hnsw (embedding public.halfvec_cosine_ops) with (m = 16, ef_construction = 64);

create table memory.term (
 org_id uuid not null,
 lexeme text not null,
 chunks int not null check (chunks > 0),
 primary key (org_id, lexeme)
);

create table memory.index_run (
 org_id uuid not null,
 id uuid primary key default gen_random_uuid(),
 started_at timestamptz not null default now(),
 finished_at timestamptz,
 model text check (length(model) <= 80),
 counts jsonb not null default '{}',
 note text check (length(note) <= 2000)
);
create index memory_index_run_org on memory.index_run (org_id, started_at desc);

create table memory.risk_score (
 org_id uuid not null,
 model text not null check (model in ('churn', 'late_payment', 'delivery_delay')),
 subject_kind text not null check (subject_kind in ('client', 'invoice', 'task', 'project')),
 subject_key text not null check (length(subject_key) between 1 and 120),  -- the subject's id (or invoice number)
 subject_id uuid,                                                          -- client / task / project id when it has one
 client_id uuid,
 owner_id uuid,                                                            -- who should act (relationship owner, PGS, assignee)
 label text not null check (length(label) between 1 and 300),
 score real not null check (score between 0 and 1),
 band text not null check (band in ('low', 'medium', 'high')),
 reasons jsonb not null default '[]' check (jsonb_typeof(reasons) = 'array'),
 as_of timestamptz not null,
 model_version text not null check (length(model_version) <= 40),
 computed_at timestamptz not null default now(),
 primary key (org_id, model, subject_key)
);
create index memory_risk_client on memory.risk_score (org_id, client_id);

create table memory.model_card (
 org_id uuid not null,
 model text not null check (model in ('churn', 'late_payment', 'delivery_delay')),
 version text not null check (length(version) <= 40),
 built_at timestamptz not null default now(),
 method text not null check (length(method) <= 4000),
 features jsonb not null default '[]',
 evaluation jsonb not null default '{}',
 primary key (org_id, model)
);

alter table memory.chunk enable row level security;
alter table memory.chunk force row level security;
create policy tenant on memory.chunk using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
alter table memory.term enable row level security;
alter table memory.term force row level security;
create policy tenant on memory.term using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
alter table memory.index_run enable row level security;
alter table memory.index_run force row level security;
create policy tenant on memory.index_run using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
alter table memory.risk_score enable row level security;
alter table memory.risk_score force row level security;
create policy tenant on memory.risk_score using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
alter table memory.model_card enable row level security;
alter table memory.model_card force row level security;
create policy tenant on memory.model_card using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on memory.chunk, memory.term, memory.index_run, memory.risk_score, memory.model_card
  from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy;

-- The indexer's last step: recount, for the company's chunks, in how many chunks each word appears.
create function pulse.memory_terms_refresh() returns int
language plpgsql volatile security definer set search_path = pulse, pg_temp as $$
declare n int;
begin
 delete from memory.term where org_id = current_org();
 insert into memory.term (org_id, lexeme, chunks)
 select current_org(), u.lexeme, count(*) from memory.chunk k cross join lateral unnest(k.tsv) u
  where k.org_id = current_org() group by u.lexeme;
 get diagnostics n = row_count;
 return n;
end $$;
revoke all on function pulse.memory_terms_refresh() from public;

-- May the viewer read this chunk? The caller computes the viewer's readable imported chats, conversations and tasks
-- once per question (small arrays) and passes them; meetings and docs ask their own access functions.
create function pulse.memory_ok(p_access text, p_ref uuid, p_channel uuid, p_wa uuid[], p_ch uuid[], p_tv uuid[], p_hr boolean, p_money boolean)
returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
 select case p_access
   when 'wa_chat' then coalesce(p_ref = any(p_wa), false)
   when 'chat' then coalesce(p_channel = any(p_ch), false)
   when 'task' then coalesce(p_ref = any(p_tv), false)
   when 'meeting' then coalesce(meeting_can(p_ref), false)
   when 'doc' then exists (select 1 from doc d where d.org_id = current_org() and d.id = p_ref and d.archived_at is null
                            and doc_can_see(d.id, d.access, d.created_by))
   when 'money' then p_money
   when 'staff' then true
   else false end
$$;
revoke all on function pulse.memory_ok(text, uuid, uuid, uuid[], uuid[], uuid[], boolean, boolean) from public;

-- Rank the chunks the viewer may read by words, meaning and event tags, fused by reciprocal rank (k = 60). Words: BM25 (k1 1.2,
-- b 0.75) over chunks holding any of the question's rarer words (as 1099 measured: "all words must appear" finds almost
-- nothing for a question). Meaning: the closest chunks by cosine distance (HNSW with an iterative scan, so the access
-- and date filters do not empty the list). Tags: when the question names events (complaint, delay, promise…), the chunks
-- tagged with all of them, closest in meaning first (else newest): the tags are common words, so BM25 alone drops them. Internal.
create function pulse.memory_rank(p_q text, p_vec text, p_limit int, p_from timestamptz, p_to timestamptz, p_kinds text[],
                                  p_client uuid, p_wa uuid[], p_ch uuid[], p_tv uuid[], p_hr boolean, p_money boolean, p_events text[] default null)
returns table (id uuid, score real, by_words boolean, by_meaning boolean)
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
 perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
 perform set_config('hnsw.ef_search', '200', true);
 return query
 with st as (select count(*)::float8 n, greatest(avg(k.words), 1)::float8 avgdl from memory.chunk k where k.org_id = current_org()),
 ql as (select distinct u.lexeme l from unnest(to_tsvector('simple', left(coalesce(p_q, ''), 400))) u where length(u.lexeme) > 1),
 tw as (select ql.l, coalesce(t.chunks, 0) df, ln(1 + (st.n - coalesce(t.chunks, 0) + 0.5) / (coalesce(t.chunks, 0) + 0.5)) idf
          from ql cross join st left join memory.term t on t.org_id = current_org() and t.lexeme = ql.l),
 rare as (select tw.l from tw cross join st where tw.df between 1 and greatest(0.08 * st.n, 50)),
 tq as (select to_tsquery('simple', string_agg('''' || replace(replace(f.l, '\', '\\'), '''', '''''') || '''', ' | ')) q
          from (select l from rare union all select l from tw where not exists (select 1 from rare)) f),
 hit as (select k.id, k.last_at, k.words, k.tsv from memory.chunk k cross join tq
          where tq.q is not null and k.org_id = current_org() and k.tsv @@ tq.q
            and (p_from is null or k.last_at >= p_from) and (p_to is null or k.first_at < p_to)
            and (p_kinds is null or k.source_kind = any(p_kinds)) and (p_client is null or k.client_id = p_client)
            and memory_ok(k.access, k.access_ref, k.channel_id, p_wa, p_ch, p_tv, p_hr, p_money)),
 words as (select h.id, row_number() over (order by sum(tw.idf * cardinality(u.positions) * 2.2
                    / (cardinality(u.positions) + 1.2 * (0.25 + 0.75 * h.words / st.avgdl))) desc, h.last_at desc) r
            from hit h cross join st cross join lateral unnest(h.tsv) u join tw on tw.l = u.lexeme
           group by h.id, h.last_at order by r limit 80),
 meaning as (select x.id, row_number() over (order by x.d) r from (
              select k.id, k.embedding operator(public.<=>) p_vec::public.halfvec(384) d
                from memory.chunk k
               where p_vec is not null and k.org_id = current_org() and k.embedding is not null
                 and (p_from is null or k.last_at >= p_from) and (p_to is null or k.first_at < p_to)
                 and (p_kinds is null or k.source_kind = any(p_kinds)) and (p_client is null or k.client_id = p_client)
                 and memory_ok(k.access, k.access_ref, k.channel_id, p_wa, p_ch, p_tv, p_hr, p_money)
               order by k.embedding operator(public.<=>) p_vec::public.halfvec(384) limit 80) x),
 tagged as (select k.id, row_number() over (order by case when p_vec is not null and k.embedding is not null
                    then k.embedding operator(public.<=>) p_vec::public.halfvec(384) end nulls last, k.last_at desc) r
              from memory.chunk k
             where cardinality(coalesce(p_events, '{}')) > 0 and k.org_id = current_org() and k.events @> p_events
               and (p_from is null or k.last_at >= p_from) and (p_to is null or k.first_at < p_to)
               and (p_kinds is null or k.source_kind = any(p_kinds)) and (p_client is null or k.client_id = p_client)
               and memory_ok(k.access, k.access_ref, k.channel_id, p_wa, p_ch, p_tv, p_hr, p_money)
             order by r limit 80)
 select u.id, sum(u.w / (60 + u.r))::real, bool_or(u.src = 'w'), bool_or(u.src = 'm')
   from (select words.id, words.r, 1.0::float8 w, 'w'::text src from words
         union all select meaning.id, meaning.r, 1.0::float8, 'm'::text from meaning
         union all select tagged.id, tagged.r, 1.0::float8, 't'::text from tagged) u
  group by u.id order by 2 desc limit greatest(1, least(coalesce(p_limit, 10), 40));
end $$;
revoke all on function pulse.memory_rank(text, text, int, timestamptz, timestamptz, text[], uuid, uuid[], uuid[], uuid[], boolean, boolean, text[]) from public;

-- Search the company memory. p: {"q": text, "vec": "[…384 numbers…]" or null, "from": date, "to": date,
-- "kinds": [source kinds], "client": uuid, "events": [tags the question names], "limit": n ≤ 40}. Each hit is a citation: what (kind, title), where (the
-- group or conversation, client, project), when, who, the events it holds, a link into Pulse and a short excerpt.
-- AI employees: imported chats only where the company's chief AI may read everything (admin) or the AI is a member of
-- that chat, and their text only as 1099's redacted history pieces of the same time (or no text).
create function pulse.memory_search(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare
 me uuid := current_viewer(); ai uuid := agent_session();
 lead boolean := viewer_is('admin', 'leadership'); hr boolean := viewer_is('admin', 'leadership', 'hr');
 money boolean := money_can('money.read'); wa uuid[]; tv uuid[]; ch uuid[]; kinds text[]; events text[];
begin
 if me is null and ai is null then raise exception 'Sign in to search the company memory' using errcode = '42501'; end if;
 if ai is not null then
   select array_agg(x.id) into wa from pulse_priv.wa_chat x where x.org_id = current_org()
     and (lead or exists (select 1 from chat_member m where m.org_id = x.org_id and m.channel_id = x.channel_id and m.person_id = ai));
 elsif chat_import_reads() then
   select array_agg(x.id) into wa from pulse_priv.wa_chat x where x.org_id = current_org() and (wa_reader(x.id) or chat_browse(x.channel_id));
 end if;
 -- the tasks the viewer may read, exactly as pulse.task's row security decides (not deleted, privacy, person rules)
 select array_agg(t.id) into tv from task t where t.org_id = current_org() and t.deleted_at is null
   and (hr or t.id in (select task_visible_ids()))
   and case when viewer_outside_seat() then t.id = any(coalesce(task_mine(), '{}')) else not (t.id = any(coalesce(task_hidden_ids(), '{}'))) end;
 select array_agg(distinct m.channel_id) into ch from chat_member m where m.org_id = current_org() and m.person_id = coalesce(ai, me);
 if jsonb_typeof(p->'kinds') = 'array' then select array_agg(x) into kinds from jsonb_array_elements_text(p->'kinds') x; end if;
 if jsonb_typeof(p->'events') = 'array' then select array_agg(x) into events from jsonb_array_elements_text(p->'events') x; end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
     'id', k.id, 'kind', k.source_kind, 'title', k.title, 'score', round(r.score::numeric, 5),
     'byWords', r.by_words, 'byMeaning', r.by_meaning,
     'where', case when k.source_kind in ('whatsapp', 'chat') then coalesce(wc.title, cc.name) end,
     'channelId', k.channel_id, 'messageId', k.message_id, 'link', k.link,
     'clientId', k.client_id, 'client', cl.display_name, 'projectId', k.project_id, 'project', coalesce(pr.title, pr.name),
     'from', k.first_at, 'to', k.last_at, 'speakers', to_jsonb(k.speakers[1:6]), 'events', to_jsonb(k.events),
     'text', case when ai is not null and k.source_kind = 'whatsapp' then
                    (select left(w.body, 700) from pulse_priv.wa_chunk w where w.org_id = k.org_id and w.chat_id = k.access_ref
                       and w.first_at <= k.last_at and w.last_at >= k.first_at order by w.first_at limit 1)
                  else left(k.body, 700) end,
     'redacted', ai is not null and k.source_kind = 'whatsapp') order by r.score desc)
   from memory_rank(p->>'q', p->>'vec', coalesce((p->>'limit')::int, 10), (p->>'from')::timestamptz, (p->>'to')::timestamptz,
                    kinds, (p->>'client')::uuid, coalesce(wa, '{}'), coalesce(ch, '{}'), coalesce(tv, '{}'), hr, money, events) r
   join memory.chunk k on k.org_id = current_org() and k.id = r.id
   left join pulse_priv.wa_chat wc on wc.org_id = k.org_id and wc.id = k.access_ref and k.source_kind = 'whatsapp'
   left join chat_channel cc on cc.org_id = k.org_id and cc.id = k.channel_id
   left join client cl on cl.id = k.client_id left join project pr on pr.id = k.project_id), '[]'::jsonb);
end $$;

-- Decision-model scores the viewer may see. p: {"model": "churn"|"late_payment"|"delivery_delay"|null, "client": uuid,
-- "band": "high"|…, "limit": n ≤ 200}. Leaders and admins see all; a client's relationship owner or its PGS see their
-- clients; a task's assignee their tasks; late-payment risk needs money access. Highest first, with the reasons.
create function pulse.memory_risks(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := coalesce(agent_session(), current_viewer()); lead boolean := viewer_is('admin', 'leadership');
 money boolean := money_can('money.read');
begin
 if me is null then raise exception 'Sign in to see risk scores' using errcode = '42501'; end if;
 return jsonb_build_object('scores', coalesce((select jsonb_agg(jsonb_build_object(
     'model', s.model, 'subject', s.subject_kind, 'subjectId', s.subject_id, 'key', s.subject_key, 'label', s.label,
     'clientId', s.client_id, 'client', cl.display_name, 'ownerId', s.owner_id, 'owner', o.display_name,
     'score', round(s.score::numeric, 3), 'band', s.band, 'reasons', s.reasons, 'asOf', s.as_of, 'version', s.model_version)
     order by s.score desc)
   from (select s.* from memory.risk_score s
          where s.org_id = current_org()
            and (p->>'model' is null or s.model = p->>'model') and (p->>'band' is null or s.band = p->>'band')
            and (p->>'client' is null or s.client_id = (p->>'client')::uuid)
            and (case s.model when 'late_payment' then money
                   else lead or s.owner_id = me
                     or (s.client_id is not null and exists (select 1 from client c where c.id = s.client_id and c.relationship_owner_id = me))
                     or (s.client_id is not null and exists (select 1 from project x where x.client_id = s.client_id and x.lead_person_id = me and x.deleted_at is null)) end)
          order by s.score desc limit greatest(1, least(coalesce((p->>'limit')::int, 50), 200))) s
   left join client cl on cl.id = s.client_id left join person o on o.id = s.owner_id), '[]'::jsonb),
   'models', coalesce((select jsonb_agg(jsonb_build_object('model', m.model, 'version', m.version, 'builtAt', m.built_at, 'method', m.method,
       'features', m.features, 'evaluation', m.evaluation) order by m.model)
     from memory.model_card m where m.org_id = current_org() and (m.model <> 'late_payment' or money)), '[]'::jsonb));
end $$;

-- What the memory holds and when it was last refreshed (counts only).
create function pulse.memory_status() returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object(
   'chunks', (select coalesce(jsonb_object_agg(k.source_kind, k.n), '{}'::jsonb) from (select source_kind, count(*) n from memory.chunk where org_id = current_org() group by 1) k),
   'embedded', (select count(*) from memory.chunk where org_id = current_org() and embedding is not null),
   'lastRun', (select jsonb_build_object('startedAt', r.started_at, 'finishedAt', r.finished_at, 'model', r.model, 'counts', r.counts)
                 from memory.index_run r where r.org_id = current_org() order by r.started_at desc limit 1))
  where current_viewer() is not null or agent_session() is not null
$$;

revoke all on function pulse.memory_search(jsonb), pulse.memory_risks(jsonb), pulse.memory_status() from public;
grant execute on function pulse.memory_search(jsonb), pulse.memory_risks(jsonb), pulse.memory_status() to pulse_api;

-- migrate:down
-- Forward-only.

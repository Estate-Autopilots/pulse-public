-- migrate:up
-- WA-DATASETS (owner, 26 Oct 2026: "datasets that can easily train an LLM … usable for model training and RAG … keep
-- filling Pulse"): the retrieval corpus over the imported WhatsApp history, so people can search a client's history by
-- meaning and AI employees can recall it.
--  * wa_chunk: the history cut into topic-coherent pieces (a conversation session, split where the topic shifts), each
--    with its chat, client, project, stage, dates, the imported messages it holds, the Pulse people who wrote in it, its
--    topics and languages and its REDACTED text (people, companies, phones, e-mails, links and ids replaced by stable
--    ids; the only text an AI employee may read). Built outside the repository from the company's own imports and
--    loaded by tools/wa-knowledge.py.
--  * wa_chunk_vec: a multilingual embedding (multilingual-e5, 768-d, half precision, computed on this server) of each
--    substantive message of a chunk; a chunk is as close to a question as its closest message (measured on 200
--    questions with known answers: this beats one vector per chunk, which long chunks blur).
--  * wa_term: in how many chunks each word appears, for BM25 word ranking (refreshed by the loader).
-- Who reads:
--  * people: pulse.wa_history_search — the chunks of chats they may read (pulse.wa_reader and pulse.chat_import_reads:
--    members who are staff, admins, opted-in client contacts; and client groups the company's group-access setting
--    lets them browse, pulse.chat_browse of 1098), ranked by words and meaning, shown as the chat's ORIGINAL messages
--    (the redacted text is never shown to people; a browsed group's hit links to it, its lines show inside the group).
--  * AI employees: pulse.agent_wa_knowledge — only inside a conversation they are a member of, only the history of that
--    conversation's client (or project, or its own imported chat), only the redacted text.
-- No runtime role has any grant on the tables. Additive: new tables and functions only.

create table pulse_priv.wa_chunk (
 org_id uuid not null,
 id uuid primary key default gen_random_uuid(),
 chat_id uuid not null,
 source_key text not null check (source_key ~ '^[0-9A-Za-z_.:-]{1,80}$'),     -- the dataset's chunk id
 version text not null check (length(version) between 1 and 40),             -- the dataset version that made it
 client_id uuid references pulse.client(id) on delete set null,
 project_id uuid references pulse.project(id) on delete set null,
 stage text check (length(stage) <= 40),
 first_at timestamptz not null,
 last_at timestamptz not null,
 messages uuid[] not null default '{}',                                      -- pulse_priv.wa_message ids, in order
 persons uuid[] not null default '{}',                                       -- Pulse people who wrote in it
 topics text[] not null default '{}',
 langs text[] not null default '{}',
 body text not null check (length(body) between 1 and 24000),                -- redacted
 tsv tsvector generated always as (to_tsvector('simple', body)) stored,
 words int generated always as (length(to_tsvector('simple', body))) stored, -- distinct words: BM25's length
 model text check (length(model) <= 80),                                     -- the model of its message vectors
 loaded_at timestamptz not null default now(),
 unique (org_id, source_key), unique (org_id, id),
 foreign key (org_id, chat_id) references pulse_priv.wa_chat (org_id, id),
 check (last_at >= first_at)
);
create index wa_chunk_client on pulse_priv.wa_chunk (org_id, client_id, first_at);
create index wa_chunk_project on pulse_priv.wa_chunk (org_id, project_id, first_at);
create index wa_chunk_chat on pulse_priv.wa_chunk (org_id, chat_id, first_at);
create index wa_chunk_tsv on pulse_priv.wa_chunk using gin (tsv);

create table pulse_priv.wa_chunk_vec (
 org_id uuid not null,
 chunk_id uuid not null,
 embedding public.halfvec(768) not null,
 foreign key (org_id, chunk_id) references pulse_priv.wa_chunk (org_id, id) on delete cascade
);
create index wa_chunk_vec_chunk on pulse_priv.wa_chunk_vec (org_id, chunk_id);

create table pulse_priv.wa_term (
 org_id uuid not null,
 lexeme text not null,
 chunks int not null check (chunks > 0),
 primary key (org_id, lexeme)
);

alter table pulse_priv.wa_chunk enable row level security;
alter table pulse_priv.wa_chunk force row level security;
create policy tenant on pulse_priv.wa_chunk using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
alter table pulse_priv.wa_chunk_vec enable row level security;
alter table pulse_priv.wa_chunk_vec force row level security;
create policy tenant on pulse_priv.wa_chunk_vec using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
alter table pulse_priv.wa_term enable row level security;
alter table pulse_priv.wa_term force row level security;
create policy tenant on pulse_priv.wa_term using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse_priv.wa_chunk, pulse_priv.wa_chunk_vec, pulse_priv.wa_term from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy;

-- The loader's last step: recount, for the company's chunks, in how many chunks each word appears.
create function pulse.wa_terms_refresh() returns int
language plpgsql volatile security definer set search_path = pulse, pg_temp as $$
declare n int;
begin
 delete from pulse_priv.wa_term where org_id = current_org();
 insert into pulse_priv.wa_term (org_id, lexeme, chunks)
 select current_org(), u.lexeme, count(*) from pulse_priv.wa_chunk k cross join lateral unnest(k.tsv) u
  where k.org_id = current_org() group by u.lexeme;
 get diagnostics n = row_count;
 return n;
end $$;
revoke all on function pulse.wa_terms_refresh() from public;

-- Rank chunk ids by words and meaning, fused by reciprocal rank (k = 60); either half may be missing. Internal: callers
-- decide which chunks are allowed. Inside one client's history (at most 4,000 chunks): BM25 (k1 1.2, b 0.75) over
-- every chunk holding any of the question's words ("all words must appear" finds almost nothing for a question), fused
-- with meaning at half weight (p_vec: a "[x,y,…]" text of 768 numbers; a chunk scores as its closest message). On 200
-- questions with known answers, scoped and worded as people ask: recall@5 0.775 against 0.715 for words alone.
-- Across more chunks: words only (meaning across the whole history measured far below words), and only chunks holding
-- one of the question's rarer words (in at most a tenth of the chunks, or 50) are scored, to bound the work.
create function pulse.wa_chunk_rank(p_ids uuid[], p_q text, p_vec text, p_limit int) returns table (id uuid, score real)
language sql stable security definer set search_path = pulse, pg_temp as $$
 with st as (select count(*)::float8 n, greatest(avg(k.words), 1)::float8 avgdl from pulse_priv.wa_chunk k where k.org_id = current_org()),
 ql as (select distinct u.lexeme l from unnest(to_tsvector('simple', left(coalesce(p_q, ''), 400))) u),
 tw as (select ql.l, coalesce(t.chunks, 0) df, ln(1 + (st.n - coalesce(t.chunks, 0) + 0.5) / (coalesce(t.chunks, 0) + 0.5)) idf
          from ql cross join st left join pulse_priv.wa_term t on t.org_id = current_org() and t.lexeme = ql.l),
 rare as (select tw.l from tw cross join st where cardinality(p_ids) > 4000 and tw.df between 1 and greatest(0.1 * st.n, 50)),
 tq as (select to_tsquery('simple', string_agg('''' || replace(replace(f.l, '\', '\\'), '''', '''''') || '''', ' | ')) q
          from (select l from rare union all select l from tw where not exists (select 1 from rare)) f),
 words as (select k.id, row_number() over (order by sum(tw.idf * cardinality(u.positions) * 2.2
                    / (cardinality(u.positions) + 1.2 * (0.25 + 0.75 * k.words / st.avgdl))) desc, k.last_at desc) r
            from pulse_priv.wa_chunk k cross join tq cross join st cross join lateral unnest(k.tsv) u join tw on tw.l = u.lexeme
           where tq.q is not null and k.org_id = current_org() and k.id = any(p_ids) and k.tsv @@ tq.q
           group by k.id, k.last_at order by r limit 60),
 meaning as (select v.chunk_id id, row_number() over (order by min(v.embedding operator(public.<=>) q.v)) r
              from pulse_priv.wa_chunk_vec v,
                   (select p_vec::public.halfvec(768) v where p_vec is not null and cardinality(p_ids) <= 4000) q
             where v.org_id = current_org() and v.chunk_id = any(p_ids)
             group by v.chunk_id order by r limit 60)
 select u.id, sum(u.w / (60 + u.r))::real score
   from (select words.id, words.r, 1.0 w from words union all select meaning.id, meaning.r, 0.5 w from meaning) u
  group by u.id order by score desc limit greatest(1, least(coalesce(p_limit, 8), 50))
$$;
revoke all on function pulse.wa_chunk_rank(uuid[], text, text, int) from public;

-- People: search the history they may read, by words and meaning, within a client / project / chat when given.
-- p: {"q": text, "vec": "[…768 numbers…]" or null, "client": uuid, "project": uuid, "channel": uuid, "limit": n}.
-- Each hit: the chat, dates, stage, its first message in the Pulse chat (a link target) and up to three of its original
-- messages (author, time, text) — what the viewer would see in the chat itself.
create function pulse.wa_history_search(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare ids uuid[];
begin
 if not chat_import_reads() then return '[]'::jsonb; end if;
 select array_agg(k.id) into ids from pulse_priv.wa_chunk k join pulse_priv.wa_chat c on c.org_id = k.org_id and c.id = k.chat_id
  where k.org_id = current_org()
    and (p->>'client' is null or k.client_id = (p->>'client')::uuid)
    and (p->>'project' is null or k.project_id = (p->>'project')::uuid)
    and (p->>'channel' is null or c.channel_id = (p->>'channel')::uuid)
    and c.id in (select x.id from pulse_priv.wa_chat x where x.org_id = current_org() and (wa_reader(x.id) or chat_browse(x.channel_id)));
 if ids is null then return '[]'::jsonb; end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
     'chunkId', k.id, 'score', r.score, 'channelId', c.channel_id, 'chat', c.title, 'clientId', k.client_id, 'client', cl.display_name,
     'projectId', k.project_id, 'project', coalesce(pr.title, pr.name), 'stage', k.stage, 'firstAt', k.first_at, 'lastAt', k.last_at,
     'messages', cardinality(k.messages),
     'messageId', (select m.id from chat_message m where m.org_id = k.org_id and m.channel_id = c.channel_id and m.import_ref = k.messages[1]),
     'preview', (select coalesce(jsonb_agg(jsonb_build_object('author', case when m.guest_id is not null then g.label else a.display_name end, 'at', m.created_at, 'text', left(m.body, 280)) order by m.created_at), '[]'::jsonb)
                 from (select m.* from chat_message m where m.org_id = k.org_id and m.channel_id = c.channel_id and m.import_ref = any(k.messages[1:6])
                         and m.removed_at is null and coalesce(m.body, '') <> '' order by m.created_at limit 3) m
                 left join person a on a.id = m.author_id left join chat_guest g on g.id = m.guest_id)) order by r.score desc)
   from wa_chunk_rank(ids, p->>'q', p->>'vec', coalesce((p->>'limit')::int, 8)) r
   join pulse_priv.wa_chunk k on k.id = r.id join pulse_priv.wa_chat c on c.org_id = k.org_id and c.id = k.chat_id
   left join client cl on cl.id = k.client_id left join project pr on pr.id = k.project_id), '[]'::jsonb);
end $$;

-- AI employees: inside a conversation it is a member of, the redacted history of that conversation's client (else its
-- project, else the conversation's own imported chat), most relevant first. Never original text, never other clients.
create function pulse.agent_wa_knowledge(p_channel uuid, p_q text, p_vec text, p_limit int) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); cl uuid; pr uuid; own uuid; ids uuid[];
begin
 if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
 if not exists (select 1 from chat_member m where m.org_id = current_org() and m.channel_id = p_channel and m.person_id = me) then return '[]'::jsonb; end if;
 select c.client_id, c.project_id, c.id into cl, pr, own from pulse_priv.wa_chat c where c.org_id = current_org() and c.channel_id = p_channel;
 if cl is null and pr is null then
   select gi.client_id, gi.project_id into cl, pr from chat_group_info gi where gi.org_id = current_org() and gi.channel_id = p_channel;
 end if;
 select array_agg(k.id) into ids from pulse_priv.wa_chunk k
  where k.org_id = current_org() and (case when cl is not null then k.client_id = cl when pr is not null then k.project_id = pr else k.chat_id = own end);
 if ids is null then return '[]'::jsonb; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('from', k.first_at, 'to', k.last_at, 'stage', k.stage, 'text', k.body) order by r.score desc)
   from wa_chunk_rank(ids, p_q, p_vec, least(coalesce(p_limit, 5), 8)) r join pulse_priv.wa_chunk k on k.id = r.id), '[]'::jsonb);
end $$;

revoke all on function pulse.wa_history_search(jsonb), pulse.agent_wa_knowledge(uuid, text, text, int) from public;
grant execute on function pulse.wa_history_search(jsonb), pulse.agent_wa_knowledge(uuid, text, text, int) to pulse_api;

-- migrate:down
-- Forward-only.

-- migrate:up
-- WA-IMPORT (owner, 25 Oct 2026: "structure the unstructured data … sentiment, sales intelligence, human interactions,
-- behaviour, SOP patterns, finance, map/data intelligence"): what the imported WhatsApp groups say, as structured
-- facts Pulse's own pages read. Computed on the server from the imported messages (tools/wa-insights.py; local models
-- and rules, nothing sent anywhere) and loaded per company:
--  * wa_message_signal: per message: language, intent, topics, sentiment, flags (urgent, from a voice note …), the
--    method and its confidence.
--  * wa_transcript: what a voice note or audio file says (local Whisper), with timed segments: the chat viewer shows it.
--  * wa_chat_stage: per chat, the stages of the service seen in it (onboarding, brief, shoot, creative, revisions,
--    approval, campaign live, leads, payment, quiet) with first and last time and the messages that show them.
--  * wa_response: how long a message from one side waited for the other side's first answer (wall clock and working
--    hours), and who answered.
--  * wa_signal: sales and service signals worth acting on: complaint, churn risk, upsell, renewal, referral, payment,
--    invoice, quotation, approval, delay, each tied to the message and the client.
--  * wa_place: places the chats name: shared locations (with coordinates) and the project's site.
--  * wa_insight: compact aggregates per client, project, person and chat (metrics jsonb) for the pages that show them.
-- Who reads: per-message facts and transcripts follow the chat (pulse.wa_reader: its members and admins); signals,
-- places and aggregates are for admins and leadership (and a chat's own for its members). No runtime role has any grant;
-- reads go through security-definer functions granted to the API. Additive: new tables and functions only.

create table pulse_priv.wa_message_signal (
 org_id uuid not null,
 message_id uuid primary key,
 chat_id uuid not null,
 lang text check (length(lang) <= 12),
 intent text not null check (intent in ('request', 'question', 'info', 'deliverable', 'approval', 'change', 'complaint', 'ack', 'schedule', 'payment', 'greeting', 'other')),
 intent_p real,
 topics text[] not null default '{}',
 sentiment smallint not null default 0 check (sentiment between -1 and 1),
 sentiment_p real,
 flags text[] not null default '{}',
 basis text not null check (length(basis) between 1 and 40),
 model text not null check (length(model) between 1 and 80),
 foreign key (org_id, message_id) references pulse_priv.wa_message (org_id, id),
 foreign key (org_id, chat_id) references pulse_priv.wa_chat (org_id, id)
);
create index wa_message_signal_chat on pulse_priv.wa_message_signal (org_id, chat_id, intent);

create table pulse_priv.wa_transcript (
 org_id uuid not null,
 sha256 text not null,
 language text check (length(language) <= 12),
 language_p real,
 text text not null check (length(text) <= 100000),
 segments jsonb not null default '[]' check (jsonb_typeof(segments) = 'array'),
 model text not null check (length(model) between 1 and 80),
 seconds real,
 created_at timestamptz not null default now(),
 primary key (org_id, sha256),
 foreign key (org_id, sha256) references pulse_priv.wa_file (org_id, sha256)
);

create table pulse_priv.wa_chat_stage (
 org_id uuid not null,
 chat_id uuid not null,
 stage text not null check (stage in ('onboarding', 'brief', 'shoot', 'creative', 'revision', 'approval', 'live', 'leads', 'payment', 'quiet')),
 first_at timestamptz not null,
 last_at timestamptz not null,
 messages int not null default 0 check (messages >= 0),
 evidence uuid[] not null default '{}',     -- up to 5 messages that show the stage
 primary key (org_id, chat_id, stage),
 foreign key (org_id, chat_id) references pulse_priv.wa_chat (org_id, id)
);

create table pulse_priv.wa_response (
 org_id uuid not null,
 message_id uuid not null,                 -- the answer
 to_message_id uuid not null,              -- the first unanswered message of the other side
 chat_id uuid not null,
 responder_participant uuid,
 responder_side text not null check (responder_side in ('team', 'client')),
 waited_s int not null check (waited_s >= 0),
 working_s int not null check (working_s >= 0),   -- counting only working hours (Mon–Sat 10:00–19:00, the chat's zone)
 primary key (org_id, message_id),
 foreign key (org_id, chat_id) references pulse_priv.wa_chat (org_id, id)
);
create index wa_response_responder on pulse_priv.wa_response (org_id, responder_participant);

create table pulse_priv.wa_signal (
 org_id uuid not null,
 id uuid primary key default gen_random_uuid(),
 chat_id uuid not null,
 message_id uuid,
 client_id uuid references pulse.client(id),
 project_id uuid references pulse.project(id),
 kind text not null check (kind in ('complaint', 'churn_risk', 'upsell', 'renewal', 'referral', 'payment', 'invoice', 'quotation', 'approval', 'delay', 'lead_quality')),
 score real not null check (score between 0 and 1),
 at timestamptz not null,
 amount numeric(14, 2),
 note text check (length(note) <= 300),            -- why (words that matched, never the message text)
 unique (org_id, chat_id, kind, message_id),
 foreign key (org_id, chat_id) references pulse_priv.wa_chat (org_id, id)
);
create index wa_signal_client on pulse_priv.wa_signal (org_id, client_id, at desc);

create table pulse_priv.wa_place (
 org_id uuid not null,
 id uuid primary key default gen_random_uuid(),
 chat_id uuid not null,
 message_id uuid,
 project_id uuid references pulse.project(id),
 kind text not null check (kind in ('shared_location', 'live_location', 'named_place')),
 lat double precision check (lat between -90 and 90),
 lng double precision check (lng between -180 and 180),
 label text check (length(label) <= 200),
 url text check (length(url) <= 600),
 at timestamptz,
 unique (org_id, chat_id, message_id, kind),
 foreign key (org_id, chat_id) references pulse_priv.wa_chat (org_id, id)
);

create table pulse_priv.wa_insight (
 org_id uuid not null,
 subject text not null check (subject in ('client', 'project', 'person', 'chat', 'company')),
 subject_id uuid not null,
 metrics jsonb not null check (jsonb_typeof(metrics) = 'object'),
 as_of timestamptz not null default now(),
 primary key (org_id, subject, subject_id)
);

do $$ declare t text; begin
 foreach t in array array['pulse_priv.wa_message_signal', 'pulse_priv.wa_transcript', 'pulse_priv.wa_chat_stage', 'pulse_priv.wa_response',
   'pulse_priv.wa_signal', 'pulse_priv.wa_place', 'pulse_priv.wa_insight'] loop
  execute format('alter table %s enable row level security', t);
  execute format('alter table %s force row level security', t);
  execute format('create policy tenant on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  execute format('revoke all on %s from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy', t);
 end loop;
end $$;

-- What a voice note says, for whoever may open the note.
create function pulse.wa_transcript_read(p_sha text) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object('text', t.text, 'language', t.language, 'segments', t.segments, 'model', t.model)
 from pulse_priv.wa_transcript t where t.org_id = current_org() and t.sha256 = p_sha and wa_file_open(p_sha) is not null
$$;

-- A chat's structure for its readers: stages, response times by side, signals, places and the signal mix by month.
create function pulse.wa_chat_insights(p_chat uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select case when wa_reader(p_chat) then jsonb_build_object(
  'stages', coalesce((select jsonb_agg(jsonb_build_object('stage', s.stage, 'firstAt', s.first_at, 'lastAt', s.last_at, 'messages', s.messages, 'evidence', s.evidence) order by s.first_at)
    from pulse_priv.wa_chat_stage s where s.org_id = current_org() and s.chat_id = p_chat), '[]'::jsonb),
  'responses', coalesce((select jsonb_object_agg(r.side, jsonb_build_object('answers', r.n, 'medianMinutes', r.med, 'p90Minutes', r.p90, 'workingMedianMinutes', r.wmed))
    from (select responder_side side, count(*) n, round(percentile_cont(0.5) within group (order by waited_s) / 60.0) med,
                 round(percentile_cont(0.9) within group (order by waited_s) / 60.0) p90, round(percentile_cont(0.5) within group (order by working_s) / 60.0) wmed
          from pulse_priv.wa_response where org_id = current_org() and chat_id = p_chat group by 1) r), '{}'::jsonb),
  'signals', coalesce((select jsonb_agg(jsonb_build_object('kind', g.kind, 'at', g.at, 'messageId', g.message_id, 'score', g.score, 'amount', g.amount, 'note', g.note) order by g.at desc)
    from pulse_priv.wa_signal g where g.org_id = current_org() and g.chat_id = p_chat), '[]'::jsonb),
  'places', coalesce((select jsonb_agg(jsonb_build_object('kind', p.kind, 'lat', p.lat, 'lng', p.lng, 'label', p.label, 'url', p.url, 'messageId', p.message_id, 'at', p.at))
    from pulse_priv.wa_place p where p.org_id = current_org() and p.chat_id = p_chat), '[]'::jsonb),
  'sentiment', coalesce((select jsonb_agg(jsonb_build_object('month', x.mon, 'positive', x.pos, 'negative', x.neg, 'messages', x.n) order by x.mon)
    from (select to_char(m.sent_at at time zone 'Asia/Kolkata', 'YYYY-MM') as mon, count(*) filter (where s.sentiment > 0) pos, count(*) filter (where s.sentiment < 0) neg, count(*) n
          from pulse_priv.wa_message_signal s join pulse_priv.wa_message m on m.org_id = s.org_id and m.id = s.message_id
          where s.org_id = current_org() and s.chat_id = p_chat group by 1) x), '[]'::jsonb),
  'metrics', (select i.metrics from pulse_priv.wa_insight i where i.org_id = current_org() and i.subject = 'chat' and i.subject_id = p_chat)) end
$$;

-- Aggregates for a client, project, person or the whole company: admins and leadership; a person also reads their own.
create function pulse.wa_insight(p_subject text, p_id uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select case when viewer_is('admin', 'leadership') or (p_subject = 'person' and p_id = current_viewer()) then
  (select jsonb_build_object('subject', i.subject, 'id', i.subject_id, 'metrics', i.metrics, 'asOf', i.as_of) from pulse_priv.wa_insight i
   where i.org_id = current_org() and i.subject = p_subject and i.subject_id = p_id) end
$$;

-- Signals across chats (complaints, churn risk, upsell …), newest first: admins and leadership.
create function pulse.wa_signals(p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select case when viewer_is('admin', 'leadership') then coalesce((select jsonb_agg(x.j order by x.at desc) from (
   select g.at, jsonb_build_object('id', g.id, 'kind', g.kind, 'at', g.at, 'score', g.score, 'amount', g.amount, 'note', g.note, 'chatId', g.chat_id, 'chat', c.title,
     'messageId', g.message_id, 'clientId', g.client_id, 'client', cl.display_name, 'projectId', g.project_id) j
   from pulse_priv.wa_signal g join pulse_priv.wa_chat c on c.org_id = g.org_id and c.id = g.chat_id left join client cl on cl.id = g.client_id
   where g.org_id = current_org() and (p->>'kind' is null or g.kind = p->>'kind') and (p->>'client' is null or g.client_id = (p->>'client')::uuid)
    and (p->>'since' is null or g.at >= (p->>'since')::timestamptz)
   order by g.at desc limit greatest(1, least(coalesce((p->>'limit')::int, 200), 1000))) x), '[]'::jsonb) end
$$;

revoke all on function pulse.wa_transcript_read(text), pulse.wa_chat_insights(uuid), pulse.wa_insight(text, uuid), pulse.wa_signals(jsonb) from public;
grant execute on function pulse.wa_transcript_read(text), pulse.wa_chat_insights(uuid), pulse.wa_insight(text, uuid), pulse.wa_signals(jsonb) to pulse_api;

-- migrate:down
-- Forward-only.

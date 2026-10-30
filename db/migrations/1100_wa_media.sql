-- migrate:up
-- WA-MEDIA (owner, 26 Oct 2026: "analyse and extract image info, the same for video (frames, or transcripts, then
-- analysed) … keep filling Pulse with that data"): what every file of the imported WhatsApp groups shows or says, as
-- facts Pulse's own pages read. Computed on the server (tools/wa-media.py loads it; the analysis itself runs outside
-- this repository on the company's own files):
--  * wa_media: per file (image, video, document, voice note / audio): what it is (class), a one-line description for
--    the chat (alt text), a short summary, the text that can be read in it, the structured facts (project facts,
--    creative attributes, ad metrics, payment / billing details, unit prices, scenes …), quality issues, and flags for
--    what it contains (faces, lead data, ID numbers …). Searchable.
--  * wa_media_figure: the numbers files carry, one row each: ad spend, leads, cost per lead, impressions, reach,
--    clicks (Ads Manager screenshots, reports), an ad account's available funds (billing pages), payments and ad-fund
--    top-ups (payment screenshots, platform receipts),
--    invoices, quotations, receipts, prices and budgets; tied to the chat, message, client and project. Card, bank,
--    UPI and ID numbers are never stored (the analysis masks them).
--  * wa_creative: the creative library: every ad creative, brochure page, reel or edit sent in a chat, its version in a
--    series, and what the client said next (approved, changes asked, no answer), with the client's messages as evidence.
-- Who reads: a file's facts follow the file (pulse.wa_file_open: whoever may open it); a chat's list follows the chat
-- (pulse.wa_reader); figures and the creative library across chats are for admins and leadership, and for members of
-- the chats they come from. No runtime role has a grant on the tables; reads go through security-definer functions
-- granted to the API. Additive: new tables and functions only.

create table pulse_priv.wa_media (
 org_id uuid not null,
 sha256 text not null,
 kind text not null check (kind in ('image', 'video', 'document', 'audio')),
 class text not null check (length(class) between 1 and 40),
 subclass text check (length(subclass) <= 160),
 alt_text text check (length(alt_text) <= 400),
 summary text check (length(summary) <= 2000),
 visible_text text check (length(visible_text) <= 20000),
 languages text[] not null default '{}',
 facts jsonb not null default '{}' check (jsonb_typeof(facts) = 'object'),
 quality_issues text[] not null default '{}',
 sensitive text[] not null default '{}',
 confidence real check (confidence between 0 and 1),
 model text not null check (length(model) between 1 and 80),
 version text not null check (length(version) between 1 and 40),
 analysed_at timestamptz not null default now(),
 search tsvector generated always as (to_tsvector('simple', left(coalesce(alt_text, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(subclass, '') || ' ' || coalesce(visible_text, ''), 60000))) stored,
 primary key (org_id, sha256),
 foreign key (org_id, sha256) references pulse_priv.wa_file (org_id, sha256)
);
create index wa_media_search on pulse_priv.wa_media using gin (search);
create index wa_media_class on pulse_priv.wa_media (org_id, kind, class);

create table pulse_priv.wa_media_figure (
 org_id uuid not null,
 id uuid primary key default gen_random_uuid(),
 sha256 text not null,
 chat_id uuid not null,
 message_id uuid,
 client_id uuid references pulse.client(id),
 project_id uuid references pulse.project(id),
 kind text not null check (kind in ('ad_spend', 'leads', 'cost_per_lead', 'impressions', 'reach', 'clicks', 'payment', 'ad_funds', 'ad_balance',
   'invoice', 'quotation', 'receipt', 'price', 'budget')),
 amount numeric(16, 2) not null,
 unit text not null check (unit in ('inr', 'count', 'pct')),
 at timestamptz not null,                  -- the date the file states, else when it was sent
 stated_date boolean not null default false,
 period text check (length(period) <= 80),  -- a date range as the file writes it
 label text check (length(label) <= 200),    -- campaign / line / purpose, as the analysis wrote it
 status text check (status in ('success', 'pending', 'failed')),
 method text check (length(method) <= 30),
 source text not null check (source in ('image', 'document', 'video')),
 foreign key (org_id, sha256) references pulse_priv.wa_file (org_id, sha256),
 foreign key (org_id, chat_id) references pulse_priv.wa_chat (org_id, id)
);
create index wa_media_figure_client on pulse_priv.wa_media_figure (org_id, client_id, at desc);
create index wa_media_figure_chat on pulse_priv.wa_media_figure (org_id, chat_id);

create table pulse_priv.wa_creative (
 org_id uuid not null,
 id uuid primary key default gen_random_uuid(),
 chat_id uuid not null,
 message_id uuid not null,                 -- its first send in the chat
 sha256 text not null,
 client_id uuid references pulse.client(id),
 project_id uuid references pulse.project(id),
 sent_at timestamptz not null,
 sender_side text not null check (sender_side in ('team', 'client', 'unknown')),
 kind text not null check (kind in ('image', 'video', 'document')),
 class text not null check (length(class) between 1 and 40),
 format text check (length(format) <= 40),
 headline text check (length(headline) <= 400),
 offer text check (length(offer) <= 400),
 cta text check (length(cta) <= 160),
 language text check (length(language) <= 40),
 series text check (length(series) <= 64),   -- creatives of one series (same design, revised) share it
 version_no int check (version_no >= 1),
 versions int check (versions >= 1),
 status text not null check (status in ('approved', 'changes_requested', 'discussed', 'no_response')),
 approvals int not null default 0,
 changes int not null default 0,
 client_replies int not null default 0,
 first_reply_minutes int,
 feedback uuid[] not null default '{}',     -- the client's messages about it (wa_message ids), in order
 change_notes text[] not null default '{}', -- the changes the client asked, one short line each
 unique (org_id, chat_id, sha256),
 foreign key (org_id, sha256) references pulse_priv.wa_file (org_id, sha256),
 foreign key (org_id, chat_id) references pulse_priv.wa_chat (org_id, id)
);
create index wa_creative_client on pulse_priv.wa_creative (org_id, client_id, sent_at desc);
create index wa_creative_project on pulse_priv.wa_creative (org_id, project_id, sent_at desc);

-- An imported message by its file (search and the creative library find the message a file came in).
create index chat_message_wa_file on pulse.chat_message (org_id, (attachments->0->>'wa')) where import_ref is not null;

do $$ declare t text; begin
 foreach t in array array['pulse_priv.wa_media', 'pulse_priv.wa_media_figure', 'pulse_priv.wa_creative'] loop
  execute format('alter table %s enable row level security', t);
  execute format('alter table %s force row level security', t);
  execute format('create policy tenant on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  execute format('revoke all on %s from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy', t);
 end loop;
end $$;

-- What a file is, for whoever may open it: everything the analysis found, and the figures it carries.
create function pulse.wa_media_read(p_sha text) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object('sha256', w.sha256, 'kind', w.kind, 'class', w.class, 'subclass', w.subclass, 'alt', w.alt_text, 'summary', w.summary,
   'text', w.visible_text, 'languages', w.languages, 'facts', w.facts, 'quality', w.quality_issues, 'sensitive', w.sensitive, 'model', w.model,
   'analysedAt', w.analysed_at,
   'figures', coalesce((select jsonb_agg(jsonb_build_object('kind', f.kind, 'amount', f.amount, 'unit', f.unit, 'at', f.at, 'statedDate', f.stated_date,
       'period', f.period, 'label', f.label, 'status', f.status, 'method', f.method) order by f.at, f.kind)
     from (select distinct on (kind, amount, label, period) * from pulse_priv.wa_media_figure x where x.org_id = w.org_id and x.sha256 = w.sha256) f), '[]'::jsonb),
   'creative', (select jsonb_build_object('status', c.status, 'versionNo', c.version_no, 'versions', c.versions, 'approvals', c.approvals, 'changes', c.changes,
       'changeNotes', c.change_notes, 'firstReplyMinutes', c.first_reply_minutes) from pulse_priv.wa_creative c where c.org_id = w.org_id and c.sha256 = w.sha256 and wa_reader(c.chat_id)
     order by c.sent_at limit 1))
 from pulse_priv.wa_media w where w.org_id = current_org() and w.sha256 = p_sha and wa_file_open(p_sha) is not null
$$;

-- A chat's imported files and what each is, for the chat's readers (one call per chat; the bubble shows the line).
create function pulse.wa_native_media(p_channel uuid) returns table (message_id uuid, sha256 text, kind text, class text, alt text, summary text,
  figures jsonb, quality text[], creative jsonb)
language sql stable security definer set search_path = pulse, pg_temp as $$
 select m.id, w.sha256, w.kind, w.class, w.alt_text, w.summary,
   (select jsonb_agg(jsonb_build_object('kind', f.kind, 'amount', f.amount, 'unit', f.unit, 'label', f.label, 'status', f.status) order by f.kind)
     from (select distinct on (kind, amount, label) * from pulse_priv.wa_media_figure x where x.org_id = w.org_id and x.sha256 = w.sha256 limit 12) f),
   w.quality_issues,
   (select jsonb_build_object('status', c.status, 'versionNo', c.version_no, 'versions', c.versions) from pulse_priv.wa_creative c
     where c.org_id = w.org_id and c.chat_id = wc.id and c.sha256 = w.sha256)
 from chat_message m
 join pulse_priv.wa_chat wc on wc.org_id = m.org_id and wc.channel_id = m.channel_id
 join pulse_priv.wa_media w on w.org_id = m.org_id and w.sha256 = m.attachments->0->>'wa'
 where m.org_id = current_org() and m.channel_id = p_channel and m.import_ref is not null and m.removed_at is null
   and chat_import_reads() and wa_reader(wc.id)
$$;

-- Files whose description, summary or readable text has the terms, in chats the viewer reads: the most terms first,
-- then the newest.
create function pulse.wa_media_search(p_terms text[], p_limit int default 8) returns table (message_id uuid, channel_id uuid, chat text, sha256 text,
  kind text, class text, alt text, at timestamptz)
language sql stable security definer set search_path = pulse, pg_temp as $$
 with q as (select array(select '%' || replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%' from unnest(p_terms) t where length(t) >= 2 limit 8) pats),
 hit as (select w.sha256, w.kind, w.class, w.alt_text,
           (select count(*) from unnest(q.pats) p where coalesce(w.alt_text, '') || ' ' || coalesce(w.summary, '') || ' ' || coalesce(w.subclass, '') || ' '
              || coalesce(w.visible_text, '') ilike p) n
         from q, pulse_priv.wa_media w where w.org_id = current_org() and cardinality(q.pats) > 0)
 select x.id, x.channel_id, wc.title, h.sha256, h.kind, h.class, h.alt_text, x.created_at
 from hit h
 join chat_message x on x.org_id = current_org() and x.attachments->0->>'wa' = h.sha256 and x.import_ref is not null and x.removed_at is null
 join pulse_priv.wa_chat wc on wc.org_id = x.org_id and wc.channel_id = x.channel_id
 where h.n > 0 and chat_import_reads() and wa_reader(wc.id)
 order by h.n desc, x.created_at desc
 limit greatest(1, least(coalesce(p_limit, 8), 50))
$$;

-- The creative library of a client, a project or a chat: what was sent, its version, what the client said next.
-- Admins and leadership see every chat; anyone else the chats they read.
create function pulse.wa_creatives(p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb) from (
  select c.sent_at at, jsonb_build_object('id', c.id, 'sha256', c.sha256, 'kind', c.kind, 'class', c.class, 'format', c.format, 'headline', c.headline,
    'offer', c.offer, 'cta', c.cta, 'language', c.language, 'series', c.series, 'versionNo', c.version_no, 'versions', c.versions, 'status', c.status,
    'approvals', c.approvals, 'changes', c.changes, 'changeNotes', c.change_notes, 'clientReplies', c.client_replies, 'firstReplyMinutes', c.first_reply_minutes, 'sentAt', c.sent_at,
    'senderSide', c.sender_side, 'chatId', c.chat_id, 'chat', wc.title, 'channelId', wc.channel_id, 'clientId', c.client_id, 'projectId', c.project_id,
    'alt', w.alt_text, 'summary', w.summary, 'quality', w.quality_issues,
    'poster', (select f.meta->>'poster' from pulse_priv.wa_file f where f.org_id = c.org_id and f.sha256 = c.sha256),
    'messageId', (select n.id from chat_message n where n.org_id = c.org_id and n.import_ref = c.message_id),
    'feedback', (select coalesce(jsonb_agg(n.id order by n.created_at), '[]'::jsonb) from chat_message n where n.org_id = c.org_id and n.import_ref = any(c.feedback))) j
  from pulse_priv.wa_creative c
  join pulse_priv.wa_chat wc on wc.org_id = c.org_id and wc.id = c.chat_id
  left join pulse_priv.wa_media w on w.org_id = c.org_id and w.sha256 = c.sha256
  where c.org_id = current_org()
    and (p->>'client' is null or c.client_id = (p->>'client')::uuid) and (p->>'project' is null or c.project_id = (p->>'project')::uuid)
    and (p->>'chat' is null or wc.channel_id = (p->>'chat')::uuid) and (p->>'status' is null or c.status = p->>'status')
    and (viewer_is('admin', 'leadership') or (chat_import_reads() and wa_reader(c.chat_id)))
  order by c.sent_at desc limit greatest(1, least(coalesce((p->>'limit')::int, 200), 1000))) x
$$;

-- The numbers files carry (payments, ad funds, spend, leads, invoices …) for a client, a project or a chat: admins and
-- leadership, and members of the chats they come from.
create function pulse.wa_media_figures(p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb) from (
  select f.at, jsonb_build_object('id', f.id, 'kind', f.kind, 'amount', f.amount, 'unit', f.unit, 'at', f.at, 'statedDate', f.stated_date, 'period', f.period,
    'label', f.label, 'status', f.status, 'method', f.method, 'source', f.source, 'sha256', f.sha256, 'class', w.class, 'alt', w.alt_text,
    'chatId', f.chat_id, 'chat', wc.title, 'channelId', wc.channel_id, 'clientId', f.client_id, 'projectId', f.project_id,
    'messageId', (select n.id from chat_message n where n.org_id = f.org_id and n.import_ref = f.message_id)) j
  from pulse_priv.wa_media_figure f
  join pulse_priv.wa_chat wc on wc.org_id = f.org_id and wc.id = f.chat_id
  left join pulse_priv.wa_media w on w.org_id = f.org_id and w.sha256 = f.sha256
  where f.org_id = current_org()
    and (p->>'client' is null or f.client_id = (p->>'client')::uuid) and (p->>'project' is null or f.project_id = (p->>'project')::uuid)
    and (p->>'chat' is null or wc.channel_id = (p->>'chat')::uuid) and (p->>'kind' is null or f.kind = p->>'kind')
    and (p->>'since' is null or f.at >= (p->>'since')::timestamptz)
    and (viewer_is('admin', 'leadership') or (chat_import_reads() and wa_reader(f.chat_id)))
  order by f.at desc limit greatest(1, least(coalesce((p->>'limit')::int, 300), 2000))) x
$$;

revoke all on function pulse.wa_media_read(text), pulse.wa_native_media(uuid), pulse.wa_media_search(text[], int), pulse.wa_creatives(jsonb),
 pulse.wa_media_figures(jsonb) from public;
grant execute on function pulse.wa_media_read(text), pulse.wa_native_media(uuid), pulse.wa_media_search(text[], int), pulse.wa_creatives(jsonb),
 pulse.wa_media_figures(jsonb) to pulse_api;

-- migrate:down
-- Forward-only.

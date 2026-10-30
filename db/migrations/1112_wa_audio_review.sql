-- migrate:up
-- WA-AUDIO (owner, 26 Oct 2026: "100% perfect extraction of words from audio messages; compare quality across
-- different models, test them, the best one"): a colleague listens to a test set of imported voice notes and corrects
-- a machine draft, so every speech engine can be scored against what was really said; and voice-note transcripts
-- become searchable from Ctrl+K.
--  * wa_transcript_review_item: one clip of a review set (a voice note, audio file or video soundtrack of the imported
--    WhatsApp groups), its draft (the engines' vote) and the other engines' versions to pick from. Loaded by
--    tools/wa-audio-review.py; the set itself is chosen outside this repository.
--  * wa_transcript_review: what one reviewer heard: the corrected text, the languages spoken, how many speakers, how
--    clear the audio is, a note; done or skipped. One row per reviewer, so two people can check the same clip.
-- Who reviews: admins and leadership, and the person a review set's task is assigned to (a task whose source_key is
-- 'wa-transcript-review:<set>'). A reviewer hears only the set's clips (the file stream checks the set, not the chat),
-- and nothing of the chat around them. No runtime role has a grant on the tables; reads and writes go through
-- security-definer functions granted to the API. Additive: new tables and functions only.

create table pulse_priv.wa_transcript_review_item (
 org_id uuid not null,
 set_key text not null check (set_key ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
 sha256 text not null,
 position int not null check (position >= 0),
 label text not null check (length(label) between 1 and 20),
 kind text not null check (kind in ('voice', 'audio', 'video')),
 duration_s real check (duration_s >= 0),
 draft text not null default '' check (length(draft) <= 20000),
 draft_source text not null check (length(draft_source) between 1 and 200),
 alternatives jsonb not null default '[]' check (jsonb_typeof(alternatives) = 'array' and length(alternatives::text) <= 120000),
 created_at timestamptz not null default now(),
 primary key (org_id, set_key, sha256),
 foreign key (org_id, sha256) references pulse_priv.wa_file (org_id, sha256)
);
create index wa_transcript_review_item_pos on pulse_priv.wa_transcript_review_item (org_id, set_key, position);

create table pulse_priv.wa_transcript_review (
 org_id uuid not null,
 set_key text not null,
 sha256 text not null,
 reviewer uuid not null references pulse.person (id),
 text text not null default '' check (length(text) <= 20000),
 languages text[] not null default '{}' check (languages <@ array['en', 'hi', 'mr', 'other']::text[]),
 speakers smallint check (speakers between 0 and 20),
 audio text check (audio in ('clear', 'noisy', 'partly_unclear', 'no_speech')),
 note text check (length(note) <= 2000),
 status text not null check (status in ('done', 'skipped')),
 seconds int check (seconds between 0 and 86400),
 updated_at timestamptz not null default now(),
 primary key (org_id, set_key, sha256, reviewer),
 foreign key (org_id, set_key, sha256) references pulse_priv.wa_transcript_review_item (org_id, set_key, sha256) on delete cascade
);

do $$ declare t text; begin
 foreach t in array array['pulse_priv.wa_transcript_review_item', 'pulse_priv.wa_transcript_review'] loop
  execute format('alter table %s enable row level security', t);
  execute format('alter table %s force row level security', t);
  execute format('create policy tenant on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  execute format('revoke all on %s from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy', t);
 end loop;
end $$;

-- May the viewer review this set? Admins and leadership; else the assignee of the set's open task.
create function pulse.wa_review_can(p_set text) returns boolean
language sql stable security definer set search_path = pulse, pg_temp as $$
 select current_viewer() is not null and exists (select 1 from pulse_priv.wa_transcript_review_item i where i.org_id = current_org() and i.set_key = p_set)
  and (viewer_is('admin', 'leadership') or exists (select 1 from task t where t.org_id = current_org() and t.source_key = 'wa-transcript-review:' || p_set
       and t.assignee_person_id = current_viewer() and t.deleted_at is null and t.status <> 'cancelled'))
$$;

-- The sets the viewer may review, with how far they (and everyone) are.
create function pulse.wa_review_sets() returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('set', s.set_key, 'clips', s.clips, 'seconds', s.seconds,
     'mine', (select count(*)::int from pulse_priv.wa_transcript_review r where r.org_id = current_org() and r.set_key = s.set_key and r.reviewer = current_viewer()),
     'reviewed', (select count(distinct r.sha256)::int from pulse_priv.wa_transcript_review r where r.org_id = current_org() and r.set_key = s.set_key and r.status = 'done'))
   order by s.set_key), '[]'::jsonb)
 from (select i.set_key, count(*)::int clips, round(sum(coalesce(i.duration_s, 0)))::int seconds from pulse_priv.wa_transcript_review_item i
       where i.org_id = current_org() group by i.set_key) s
 where wa_review_can(s.set_key)
$$;

-- One set: every clip with its draft, the other versions and the viewer's own review; admins also see who else reviewed.
create function pulse.wa_review_items(p_set text) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select case when wa_review_can(p_set) then coalesce((select jsonb_agg(jsonb_build_object('sha256', i.sha256, 'label', i.label, 'kind', i.kind,
     'durationS', i.duration_s, 'draft', i.draft, 'draftSource', i.draft_source, 'alternatives', i.alternatives,
     'mine', (select jsonb_build_object('text', r.text, 'languages', r.languages, 'speakers', r.speakers, 'audio', r.audio, 'note', r.note,
         'status', r.status, 'updatedAt', r.updated_at)
       from pulse_priv.wa_transcript_review r where r.org_id = i.org_id and r.set_key = i.set_key and r.sha256 = i.sha256 and r.reviewer = current_viewer()),
     'others', (select count(*)::int from pulse_priv.wa_transcript_review r where r.org_id = i.org_id and r.set_key = i.set_key and r.sha256 = i.sha256
       and r.reviewer <> current_viewer() and r.status = 'done'))
   order by i.position) from pulse_priv.wa_transcript_review_item i where i.org_id = current_org() and i.set_key = p_set), '[]'::jsonb) end
$$;

-- Save the viewer's review of one clip (again = replace).
create function pulse.wa_review_save(p_set text, p_sha text, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pulse, pg_temp as $$
declare st text := p->>'status'; langs text[];
begin
 if not wa_review_can(p_set) then raise exception 'This review set is not available to you' using errcode = '42501'; end if;
 if not exists (select 1 from pulse_priv.wa_transcript_review_item i where i.org_id = current_org() and i.set_key = p_set and i.sha256 = p_sha) then
  raise exception 'This clip is not in the set' using errcode = 'P0002'; end if;
 if st is null or st not in ('done', 'skipped') then raise exception 'Mark the clip done or skipped' using errcode = '22023'; end if;
 select coalesce(array_agg(distinct x), '{}') into langs from jsonb_array_elements_text(coalesce(p->'languages', '[]')) x where x in ('en', 'hi', 'mr', 'other');
 insert into pulse_priv.wa_transcript_review (org_id, set_key, sha256, reviewer, text, languages, speakers, audio, note, status, seconds, updated_at)
 values (current_org(), p_set, p_sha, current_viewer(), left(coalesce(p->>'text', ''), 20000), langs,
   case when p->>'speakers' ~ '^[0-9]{1,3}$' then least(20, (p->>'speakers')::int)::smallint end,
   case when p->>'audio' in ('clear', 'noisy', 'partly_unclear', 'no_speech') then p->>'audio' end,
   nullif(left(coalesce(p->>'note', ''), 2000), ''), st,
   case when p->>'seconds' ~ '^[0-9]{1,9}$' then least(86400, (p->>'seconds')::int) else 0 end, now())
 on conflict (org_id, set_key, sha256, reviewer) do update set text = excluded.text, languages = excluded.languages, speakers = excluded.speakers,
   audio = excluded.audio, note = excluded.note, status = excluded.status,
   seconds = least(86400, coalesce(pulse_priv.wa_transcript_review.seconds, 0) + coalesce(excluded.seconds, 0)), updated_at = now();
 return jsonb_build_object('ok', true, 'status', st);
end $$;

-- A clip's file for a reviewer of its set (the set decides, not the chat), and its parts.
create function pulse.wa_review_file(p_set text, p_sha text) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object('sha256', f.sha256, 'mime', f.mime, 'size', f.size, 'parts', f.parts)
 from pulse_priv.wa_file f join pulse_priv.wa_transcript_review_item i on i.org_id = f.org_id and i.sha256 = f.sha256 and i.set_key = p_set
 where f.org_id = current_org() and f.sha256 = p_sha and f.complete and wa_review_can(p_set)
$$;
create function pulse.wa_review_file_parts(p_set text, p_sha text, p_from int, p_to int) returns table (part int, data bytea)
language sql stable security definer set search_path = pulse, pg_temp as $$
 select p.part, p.data from pulse_priv.wa_file_part p where p.org_id = current_org() and p.sha256 = p_sha and p.part between p_from and least(p_to, p_from + 63)
  and wa_review_file(p_set, p_sha) is not null order by p.part
$$;

-- Ctrl+K: imported voice notes whose transcript holds every searched word, for the chats the viewer reads.
create function pulse.wa_transcript_search(p_terms text[], p_limit int default 8) returns table (message_id uuid, channel_id uuid, chat text, sha256 text,
  snippet text, language text, at timestamptz)
language sql stable security definer set search_path = pulse, pg_temp as $$
 with q as (select array(select '%' || replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%' from unnest(p_terms) t where length(t) >= 2 limit 8) pats),
 hit as (select t.sha256, t.text, t.language from q, pulse_priv.wa_transcript t
         where t.org_id = current_org() and cardinality(q.pats) > 0 and t.text ilike all (q.pats))
 select x.id, x.channel_id, wc.title, h.sha256,
   left(substr(h.text, greatest(1, position(lower(p_terms[1]) in lower(h.text)) - 40)), 160), h.language, x.created_at
 from hit h
 join chat_message x on x.org_id = current_org() and x.attachments->0->>'wa' = h.sha256 and x.import_ref is not null and x.removed_at is null
 join pulse_priv.wa_chat wc on wc.org_id = x.org_id and wc.channel_id = x.channel_id
 where chat_import_reads() and wa_reader(wc.id)
 order by x.created_at desc limit greatest(1, least(coalesce(p_limit, 8), 50))
$$;

revoke all on function pulse.wa_review_can(text), pulse.wa_review_sets(), pulse.wa_review_items(text), pulse.wa_review_save(text, text, jsonb),
 pulse.wa_review_file(text, text), pulse.wa_review_file_parts(text, text, int, int), pulse.wa_transcript_search(text[], int) from public;
grant execute on function pulse.wa_review_can(text), pulse.wa_review_sets(), pulse.wa_review_items(text), pulse.wa_review_save(text, text, jsonb),
 pulse.wa_review_file(text, text), pulse.wa_review_file_parts(text, text, int, int), pulse.wa_transcript_search(text[], int) to pulse_api;

-- migrate:down
-- Forward-only.

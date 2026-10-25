-- migrate:up
-- WA-IMPORT: no time zone is written into the database (R51; tests/core/test_org_time_zone.py). 1015 and 1016 named India
-- in wa_chat.time_zone's default, in wa_import_begin and in a chat's monthly sentiment: an imported chat now takes the
-- time zone its bundle names (the exporting phone's) or else the company's own (pulse.org_time_zone()), and a chat's
-- months are counted in the chat's zone. Same signatures; no data changes (every chat loaded so far carries its zone).
alter table pulse_priv.wa_chat alter column time_zone drop default;

create or replace function pulse.wa_import_begin(p jsonb) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare cid uuid; ch uuid; bid uuid; k text := p->>'sourceKey'; t text := left(regexp_replace(trim(coalesce(p->>'title', '')), '\s+', ' ', 'g'), 300);
 done boolean := false; parts jsonb;
begin
 if current_org() is null then raise exception 'set the company first' using errcode = '42501'; end if;
 if k is null or k !~ '^[0-9A-Za-z_-]{6,80}$' then raise exception 'sourceKey required' using errcode = '22023'; end if;
 if length(t) = 0 then raise exception 'title required' using errcode = '22023'; end if;
 insert into chat_channel (org_id, key, name, kind, description) values (current_org(), 'wa:' || k, left(t, 120), 'custom', 'Imported from WhatsApp')
 on conflict (org_id, key) do update set name = excluded.name where chat_channel.name is distinct from excluded.name
 returning id into ch;
 if ch is null then select id into ch from chat_channel where org_id = current_org() and key = 'wa:' || k; end if;
 insert into pulse_priv.wa_chat (org_id, source_key, channel_id, title, titles, client_id, project_id, time_zone)
 values (current_org(), k, ch, t, coalesce(p->'titles', '[]'), nullif(p->>'clientId', '')::uuid, nullif(p->>'projectId', '')::uuid, coalesce(nullif(p->>'timeZone', ''), org_time_zone()))
 on conflict (org_id, source_key) do update set title = excluded.title, titles = excluded.titles, client_id = excluded.client_id,
   project_id = excluded.project_id, updated_at = now()
 returning id into cid;
 insert into chat_member (org_id, channel_id, person_id)
 select current_org(), ch, x.id from person x where x.org_id = current_org() and x.side = 'staff' and x.status = 'active'
  and x.id in (select (jsonb_array_elements_text(coalesce(p->'members', '[]')))::uuid) on conflict do nothing;
 insert into pulse_priv.wa_participant (org_id, chat_id, source_key, label, label_raw, kind, person_id)
 select current_org(), cid, x.key, left(x.label, 120), nullif(left(x.raw, 200), ''), x.kind, x.person
 from jsonb_to_recordset(coalesce(p->'participants', '[]')) as x(key text, label text, raw text, kind text, person uuid)
 on conflict (org_id, chat_id, source_key) do update set label = excluded.label, label_raw = excluded.label_raw, kind = excluded.kind, person_id = excluded.person_id;
 select id, finished_at is not null into bid, done from pulse_priv.wa_import_batch where org_id = current_org() and chat_id = cid and bundle_sha256 = p->>'bundleSha256';
 if bid is null then
  insert into pulse_priv.wa_import_batch (org_id, chat_id, tool, bundle_sha256, source, approval_ref, run_by)
  values (current_org(), cid, p->>'tool', p->>'bundleSha256', coalesce(p->'source', '{}'), trim(p->>'approvalRef'), trim(p->>'runBy'))
  returning id into bid;
  done := false;
 end if;
 select coalesce(jsonb_object_agg(source_key, id), '{}') into parts from pulse_priv.wa_participant where org_id = current_org() and chat_id = cid;
 return jsonb_build_object('chatId', cid, 'channelId', ch, 'batchId', bid, 'done', coalesce(done, false), 'participants', parts);
end $$;


-- A chat's structure for its readers: stages, response times by side, signals, places and the signal mix by month.
create or replace function pulse.wa_chat_insights(p_chat uuid) returns jsonb
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
    from (select to_char(m.sent_at at time zone c.time_zone, 'YYYY-MM') as mon, count(*) filter (where s.sentiment > 0) pos, count(*) filter (where s.sentiment < 0) neg, count(*) n
          from pulse_priv.wa_message_signal s join pulse_priv.wa_message m on m.org_id = s.org_id and m.id = s.message_id
          join pulse_priv.wa_chat c on c.org_id = s.org_id and c.id = s.chat_id
          where s.org_id = current_org() and s.chat_id = p_chat group by 1) x), '[]'::jsonb),
  'metrics', (select i.metrics from pulse_priv.wa_insight i where i.org_id = current_org() and i.subject = 'chat' and i.subject_id = p_chat)) end
$$;


-- migrate:down
-- Forward-only.

-- migrate:up
-- WA-IMPORT: searching an imported chat also finds what its voice notes say (their local transcripts, 1016), not only
-- the text and file names; a hit from a voice note says so. Same signature and rules as 1015's pulse.wa_search.
create or replace function pulse.wa_search(p_chat uuid, p_q text) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'at', x.sent_at, 'participantId', x.participant_id, 'body', left(x.body, 200), 'fileName', x.file_name,
   'transcript', x.spoken) order by x.sent_at desc), '[]'::jsonb)
 from (select m.id, m.sent_at, m.participant_id, case when t.text is not null and not (m.body ilike w.pat) then t.text else m.body end body, m.file_name,
          t.text is not null and not (m.body ilike w.pat or coalesce(m.file_name, '') ilike w.pat) spoken
   from pulse_priv.wa_message m
   join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
   cross join (select '%' || replace(replace(trim(p_q), '%', '\%'), '_', '\_') || '%' pat) w
   left join pulse_priv.wa_transcript t on t.org_id = m.org_id and t.sha256 = m.file_sha256 and t.text ilike w.pat
   where m.org_id = current_org() and m.chat_id = p_chat and wa_reader(p_chat) and length(trim(coalesce(p_q, ''))) between 2 and 100
    and (m.body ilike w.pat or m.file_name ilike w.pat or t.text is not null)
   order by m.sent_at desc limit 200) x
$$;

-- migrate:down
-- Forward-only.

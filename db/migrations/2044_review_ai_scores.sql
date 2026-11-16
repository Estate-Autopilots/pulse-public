-- migrate:up
-- SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.3: "the Claude that is available on the company's server should basically
-- give confidence to these and make review data even cleaner"). The company's own AI checks each pending suggestion
-- before a person does: a confidence (0 to 1) and one plain reason, kept beside the source's own confidence. People then
-- confirm only the doubtful ones; the sure ones are accepted together (Review data's one queue).
--
-- The AI is the company's own AI co-worker on its own server, through the co-worker key path (/api/v0/agent/*, 0510):
-- pulse.review_ai_queue() hands it the next unchecked suggestions, pulse.review_ai_score() keeps what it said. Both
-- answer only inside an AI co-worker's session (pulse.agent_session()). A score decides nothing: accepting stays a
-- person's act (review-data/decide). Suggestions read from WhatsApp groups are never handed out (COMMON.md: WhatsApp
-- data never leaves the server; the model runs at its provider): contacts from the chats, models and shoots, and any
-- suggestion whose source names a chat.
alter table pulse.review_item
  add column ai_confidence numeric(4,3) check (ai_confidence between 0 and 1),
  add column ai_reason text check (length(ai_reason) <= 300),
  add column ai_scored_at timestamptz,
  add column ai_scorer uuid references pulse.person(id);

create function pulse.review_ai_private(p_kind text, p_source text) returns boolean
  language sql immutable as $$
  select p_kind in ('wa_contact', 'talent') or coalesce(p_source, '') ~* '(whatsapp|(^|[:_-])wa[:_-]|chat)'
$$;

create function pulse.review_ai_queue(p_limit int) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if agent_session() is null then raise exception 'An AI co-worker checks suggestions' using errcode = '42501'; end if;
  -- review_item has no creation timestamp; keep batches stable with its unique id.
  return coalesce((select jsonb_agg(x order by x.id) from (
    select r.id, r.kind, left(r.title, 300) title, r.proposed, r.confidence::float "sourceConfidence",
      left(r.evidence::text, 1500) evidence
    from review_item r where r.status = 'pending' and r.ai_scored_at is null and not review_ai_private(r.kind, r.source_key)
    order by r.id limit least(greatest(coalesce(p_limit, 25), 1), 50)) x), '[]'::jsonb);
end $$;

-- [{id, confidence, reason}]: kept on pending suggestions only; a score again replaces the earlier one.
create function pulse.review_ai_score(p_scores jsonb) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a uuid := agent_session(); s jsonb; n int := 0; c numeric; why text;
begin
  if a is null then raise exception 'An AI co-worker checks suggestions' using errcode = '42501'; end if;
  if jsonb_typeof(p_scores) <> 'array' or jsonb_array_length(p_scores) > 50 then raise exception 'Send up to 50 scores' using errcode = '22023'; end if;
  for s in select * from jsonb_array_elements(p_scores) loop
    c := (s->>'confidence')::numeric; why := btrim(coalesce(s->>'reason', ''));
    if c is null or c < 0 or c > 1 or why = '' then raise exception 'Each score needs a confidence from 0 to 1 and a reason' using errcode = '22023'; end if;
    update review_item set ai_confidence = round(c, 3), ai_reason = left(why, 300), ai_scored_at = now(), ai_scorer = a
     where id = (s->>'id')::uuid and status = 'pending' and not review_ai_private(kind, source_key);
    if found then n := n + 1; end if;
  end loop;
  if n > 0 then perform audit_write('review_ai_scored', 'review_item', n::text); end if;
  return n;
end $$;

revoke all on function pulse.review_ai_private(text, text), pulse.review_ai_queue(int), pulse.review_ai_score(jsonb) from public;
grant execute on function pulse.review_ai_private(text, text), pulse.review_ai_queue(int), pulse.review_ai_score(jsonb) to pulse_api;

-- migrate:down
drop function if exists pulse.review_ai_score(jsonb);
drop function if exists pulse.review_ai_queue(int);
drop function if exists pulse.review_ai_private(text, text);
alter table pulse.review_item drop column if exists ai_scorer, drop column if exists ai_scored_at, drop column if exists ai_reason, drop column if exists ai_confidence;

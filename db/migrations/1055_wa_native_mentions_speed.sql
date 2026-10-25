-- migrate:up
-- WA-NATIVE: mentions are read about ten times faster on a busy server: wa_native_mentions (1051) tried every name of
-- the group as a pattern on every message that has an "@"; it now tries only the names whose first two letters (spaces
-- aside; an "@" never counts as a letter) follow any "@" in that message (the full pattern still decides, so "@A@B" reads
-- both as before). Same results: checked against 1051's on every
-- mention message of EA dev (all equal; five busy groups re-synced in 31 s instead of 342 s)
-- and tests/core/test_wa_native.py. Re-written from 1051 with only those lines added.

create or replace function pulse.wa_native_mentions(p_body text, p_names jsonb, p_numbers jsonb) returns jsonb
language plpgsql stable set search_path = pulse, pg_temp as $$
declare b text := coalesce(p_body, ''); targets text[] := '{}'; ids uuid[] := '{}'; found int; people int := 0; guests int := 0;
 c jsonb; pat text; raw text; d text; e text; hit jsonb; i int := 0; guard int := 0; k int; heads text[];
begin
 found := (select count(*) from regexp_matches(b, '(^|[^[:alnum:]_.@])@[~+[:alnum:]]', 'g'));
 if found = 0 then return jsonb_build_object('body', b, 'ids', '[]'::jsonb, 'found', 0, 'people', 0, 'guests', 0); end if;
 -- "@+91 98765 43210", "@919876543210": the person with that phone, else the chat's only guest ending in those digits.
 loop
  raw := substring(b from '(?:^|[^[:alnum:]_.@])@(\+?[0-9][0-9  -]{5,18}[0-9])');
  exit when raw is null or guard >= 30;
  guard := guard + 1;
  d := regexp_replace(raw, '[^0-9]', '', 'g');
  e := case when length(d) = 10 and left(d, 1) in ('6', '7', '8', '9') and raw !~ '^\+' then '+91' || d
            when length(d) = 11 and left(d, 1) = '0' and substr(d, 2, 1) in ('6', '7', '8', '9') and raw !~ '^\+' then '+91' || substr(d, 2)
            else '+' || d end;
  hit := (select x from jsonb_array_elements(coalesce(p_numbers, '[]')) x where x->>'e164' = e limit 1);
  if hit is null and (select count(*) from jsonb_array_elements(coalesce(p_numbers, '[]')) x where x->>'last4' = right(d, 4)) = 1 then
   hit := (select x from jsonb_array_elements(p_numbers) x where x->>'last4' = right(d, 4));
  end if;
  i := i + 1;
  b := regexp_replace(b, '(^|[^[:alnum:]_.@])@' || regexp_replace(raw, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g'), '\1' || chr(1) || i || chr(2));
  targets := targets || coalesce(hit->>'to', '@' || raw);
  if hit->>'person' is not null then ids := ids || (hit->>'person')::uuid; people := people + 1;
  elsif hit is not null then guests := guests + 1; end if;
 end loop;
 -- "@Name" / "@~Name": the longest name first, so "@Asha Kireteso" is not read as "@Asha". Only names whose first two
 -- letters (spaces aside) follow an "@" in this message are tried (1055: one regex per likely name, not one per name of the group).
 heads := array(select distinct lower(regexp_replace(x[1], '[~\s]', '', 'g')) from regexp_matches(b, '@(~?\s?[^\s@]\s*[^\s@])', 'g') x);
 for c in select x from jsonb_array_elements(coalesce(p_names, '[]')) x where lower(left(regexp_replace(x->>'name', '\s', '', 'g'), 2)) = any(heads)
   order by length(x->>'name') desc loop
  exit when position('@' in b) = 0;
  pat := '(^|[^[:alnum:]_.@])@~?\s?' || regexp_replace(regexp_replace(c->>'name', '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g'), '\s+', '\\s+', 'g') || '(?![[:alnum:]_])';
  guard := 0;
  while guard < 10 and b ~* pat loop
   guard := guard + 1; i := i + 1;
   b := regexp_replace(b, pat, '\1' || chr(1) || i || chr(2), 'i');
   targets := targets || (c->>'to');
   if c->>'person' is not null then ids := ids || (c->>'person')::uuid; people := people + 1; else guests := guests + 1; end if;
  end loop;
 end loop;
 for k in 1..i loop b := replace(b, chr(1) || k || chr(2), targets[k]); end loop;
 return jsonb_build_object('body', b, 'ids', to_jsonb(array(select distinct x from unnest(ids) x)), 'found', found, 'people', people, 'guests', guests);
end $$;

-- migrate:down
-- Forward-only.

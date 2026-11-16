-- migrate:up
-- COMPANY-SEARCH (owner, 8 Nov 2026): "Searching different companies should be public, because company status is a
-- public thing … Employees who made their account public can also be searched … by name, ID, CIN, GST, whatever."
-- First user: Contracts (one company finds another to send it an agreement).
--
--  * pulse.org_public_card: a company's public card. Its admins fill it in (Settings → Company → Public profile):
--    legal name, city, industry, website, GSTIN, CIN and other public IDs, and say what is shown. By default only the
--    name, @handle, logo and city are shown; every active company is listed ("Show us in search" can be turned off).
--  * The "verified" badge: a GSTIN whose state code, shape and mod-36 check letter are right, or a CIN whose shape,
--    state, year and kind are right (a CIN has no check digit). registry_status leaves room for a later check with the
--    official registry; nothing calls a paid or official service now.
--  * People: only an account that turned on "Let people find me" (pulse_priv.account_profile.directory_on, off by
--    default). Public: name, @handle (the account's, IDENTITY-UNIFY), headline, photo and current company; e-mail and
--    phone only when the person ticks them.
--  * pulse.directory_entry: the search index. It holds ONLY what is public (a hidden field is never written to it),
--    kept in step by triggers. Searched with Postgres full text (prefixes), pg_trgm (typos) and a cheap
--    Hindi/Marathi (Devanagari) to Latin transliteration with a "sounds like" key. Ranked: exact ID or @handle, exact
--    name, name starts with, words, close spelling, sounds like.
--  * Read only through SECURITY DEFINER functions with an explicit column list (directory_companies, directory_people,
--    directory_company, directory_person, …); the API role has no grant on the tables.
--  * pulse.directory_invite: "Not on Vitals? Invite them": a pending invite (name, e-mail or phone) and the hash of a
--    one-click join link. Nothing is sent by Pulse; the person shares the link from their own device.
-- Forced row security and a tenant policy on every new table; the schema owner (the definer functions) may read and
-- write them across companies (the directory policy, as person_username_alias in 1746).
-- Safe on a live install: additive; every active company gets an index entry with its name and handle; nobody's
-- person entry is made until they turn it on. The real companies' cards are seeded with name, handle and city only.

-- ------------------------------------------------------------------------------------------------ ID checks
-- GSTIN: 2-digit state code (01-38, 97 other territory, 99 centre), the PAN (5 letters, 4 digits, a letter), the
-- registration number, a letter (Z by default) and the check character (mod 36, weights 1 and 2).
create function pulse.gstin_valid(p text) returns boolean
  language plpgsql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
declare a constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; g text := upper(regexp_replace(coalesce(p, ''), '[[:space:]]', '', 'g'));
  s int := 0; v int; st int;
begin
  if g !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][0-9A-Z][0-9A-Z]$' then return false; end if;
  st := substr(g, 1, 2)::int;
  if not (st between 1 and 38 or st in (97, 99)) then return false; end if;
  for i in 1..14 loop
    v := (strpos(a, substr(g, i, 1)) - 1) * (case when i % 2 = 1 then 1 else 2 end);
    s := s + v / 36 + v % 36;
  end loop;
  return substr(a, ((36 - s % 36) % 36) + 1, 1) = substr(g, 15, 1);
end $$;

-- CIN (company identification number, 21 characters): listed or unlisted, the 5-digit industry code, the state, the
-- year, the kind of company and a 6-digit number. It has no check digit, so its parts are checked.
create function pulse.cin_valid(p text) returns boolean
  language plpgsql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
declare c text := upper(regexp_replace(coalesce(p, ''), '[[:space:]]', '', 'g')); y int;
begin
  if c !~ '^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$' then return false; end if;
  if substr(c, 7, 2) <> all (array['AN','AP','AR','AS','BR','CH','CG','CT','DD','DL','DN','GA','GJ','HP','HR','JH','JK',
      'KA','KL','LA','LD','MH','ML','MN','MP','MZ','NL','OD','OR','PB','PY','RJ','SK','TG','TN','TR','TS','UK','UP','UR','WB']) then
    return false;
  end if;
  y := substr(c, 9, 4)::int;
  if y < 1850 or y > 2100 then return false; end if;
  return substr(c, 13, 3) = any (array['PLC','PTC','GOI','SGC','FLC','FTC','GAP','GAT','NPL','ULL','ULT','OPC']);
end $$;

-- An ID as it is compared: capitals and digits only (spaces, dots and dashes dropped).
create function pulse.dir_id_norm(p text) returns text
  language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- One public ID: {kind, label, value}, or an error in plain words. Kinds: gstin, cin, llpin, pan, udyam, other.
create function pulse.dir_id_check(p_kind text, p_value text) returns text
  language plpgsql immutable set search_path = pulse, pg_temp as $$
declare v text := upper(btrim(coalesce(p_value, '')));
begin
  if v = '' then return null; end if;
  case p_kind
    when 'gstin' then
      v := dir_id_norm(v);
      if v !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][0-9A-Z][0-9A-Z]$' then
        raise exception 'A GSTIN has 15 letters and numbers, like 27ABCDE1234F1Z5. Check it for typos.' using errcode = '22023';
      end if;
      if not (substr(v, 1, 2)::int between 1 and 38 or substr(v, 1, 2) in ('97', '99')) then
        raise exception 'This GSTIN starts with %, which is not a state code. Check the first 2 numbers.', substr(v, 1, 2) using errcode = '22023';
      end if;
      if not gstin_valid(v) then
        raise exception 'This GSTIN''s last letter does not match the rest. Check it for typos.' using errcode = '22023';
      end if;
    when 'cin' then
      v := dir_id_norm(v);
      if not cin_valid(v) then
        raise exception 'A CIN has 21 letters and numbers, like U72900MH2020PTC000001. Check it for typos.' using errcode = '22023';
      end if;
    when 'llpin' then
      v := regexp_replace(v, '[[:space:]]', '', 'g');
      if v !~ '^[A-Z]{3}-?[0-9]{4}$' then raise exception 'An LLPIN looks like AAB-1234.' using errcode = '22023'; end if;
      if v !~ '-' then v := substr(v, 1, 3) || '-' || substr(v, 4); end if;
    when 'pan' then
      v := dir_id_norm(v);
      if v !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then raise exception 'A PAN has 10 letters and numbers: 5 letters, 4 numbers, 1 letter.' using errcode = '22023'; end if;
    when 'udyam' then
      v := regexp_replace(v, '[[:space:]]', '', 'g');
      if v !~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$' then raise exception 'An Udyam number looks like UDYAM-MH-26-0000001.' using errcode = '22023'; end if;
    when 'other' then
      if length(v) > 40 then raise exception 'Keep an ID under 40 letters.' using errcode = '22023'; end if;
    else
      raise exception 'Choose GSTIN, CIN, LLPIN, PAN, Udyam or Other.' using errcode = '22023';
  end case;
  return v;
end $$;

-- ------------------------------------------------------------------------------------------------ text for search
-- Lower case, common accents dropped, & read as "and", anything but letters, digits and Devanagari a space.
create function pulse.dir_fold(p text) returns text
  language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select btrim(regexp_replace(regexp_replace(
    translate(lower(replace(coalesce(p, ''), '&', ' and ')), 'àáâãäåāçèéêëēìíîïīñòóôõöōùúûüūýÿ', 'aaaaaaaceeeeeiiiiinoooooouuuuuyy'),
    '[^a-z0-9\u0900-\u097F]+', ' ', 'g'), '\s+', ' ', 'g'))
$$;

-- A company name without the words every company has (Pvt Ltd, LLP, The …): "Vitals Technologies Pvt. Ltd." and
-- "vitals technologies" are the same name.
create function pulse.dir_core(p text) returns text
  language sql immutable parallel safe set search_path = pulse, pg_catalog, pg_temp as $$
  select coalesce(nullif(btrim(regexp_replace(' ' || dir_fold(p) || ' ',
    '( (pvt|private|ltd|limited|llp|inc|co|company|corp|corporation|plc|opc|the|pvtltd))+(?= )', ' ', 'g')), ''), dir_fold(p))
$$;

-- Devanagari (Hindi, Marathi) to plain Latin letters, as people would type the name in English: "वाइटल्स" → "vaitals".
-- Consonants carry an "a" unless a vowel sign or the virama follows; the last one of a word drops it.
create function pulse.dir_translit(p text) returns text
  language plpgsql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
declare s text := coalesce(p, ''); out text := ''; ch text; c text; i int := 1; n int; nx int; cp int;
  -- Consonants (with the precomposed nukta letters), then vowels, vowel signs, nasal signs and digits. JSON \u escapes,
  -- so the map does not depend on how an editor stores combining characters.
  cons constant jsonb := '{"\u0915":"k","\u0916":"kh","\u0917":"g","\u0918":"gh","\u0919":"n","\u091a":"ch","\u091b":"chh",
    "\u091c":"j","\u091d":"jh","\u091e":"n","\u091f":"t","\u0920":"th","\u0921":"d","\u0922":"dh","\u0923":"n","\u0924":"t",
    "\u0925":"th","\u0926":"d","\u0927":"dh","\u0928":"n","\u092a":"p","\u092b":"ph","\u092c":"b","\u092d":"bh","\u092e":"m",
    "\u092f":"y","\u0930":"r","\u0932":"l","\u0933":"l","\u0935":"v","\u0936":"sh","\u0937":"sh","\u0938":"s","\u0939":"h",
    "\u0958":"q","\u0959":"kh","\u095a":"g","\u095b":"z","\u095c":"r","\u095d":"rh","\u095e":"f","\u095f":"y"}';
  vow constant jsonb := '{"\u0905":"a","\u0906":"a","\u0907":"i","\u0908":"i","\u0909":"u","\u090a":"u","\u090b":"ri","\u090d":"e",
    "\u090f":"e","\u0910":"ai","\u0911":"o","\u0913":"o","\u0914":"au","\u093e":"a","\u093f":"i","\u0940":"i","\u0941":"u",
    "\u0942":"u","\u0943":"ri","\u0945":"e","\u0947":"e","\u0948":"ai","\u0949":"o","\u094b":"o","\u094c":"au",
    "\u0901":"n","\u0902":"n","\u0903":"h","\u0966":"0","\u0967":"1","\u0968":"2","\u0969":"3","\u096a":"4","\u096b":"5",
    "\u096c":"6","\u096d":"7","\u096e":"8","\u096f":"9"}';
begin
  if s !~ '[\u0900-\u097F]' then return s; end if;
  n := length(s);
  while i <= n loop
    ch := substr(s, i, 1); cp := ascii(ch);
    nx := coalesce(ascii(nullif(substr(s, i + 1, 1), '')), 0);
    c := cons ->> ch;
    if c is not null then
      if nx = 2364 then                                                     -- a nukta after it: ज़ z, फ़ f, क़ q, ड़ r
        c := case c when 'k' then 'q' when 'j' then 'z' when 'ph' then 'f' when 'd' then 'r' when 'dh' then 'rh' else c end;
        i := i + 1; nx := coalesce(ascii(nullif(substr(s, i + 1, 1), '')), 0);
      end if;
      out := out || c;
      if nx = 2381 then i := i + 1;                                         -- virama: no vowel
      elsif nx between 2366 and 2380 or nx in (2402, 2403) then null;       -- a vowel sign follows
      elsif nx between 2325 and 2361 or nx between 2392 and 2399 or nx between 2305 and 2307 then out := out || 'a';
      end if;                                                               -- end of a word: no "a"
    elsif vow ? ch then out := out || (vow ->> ch);
    elsif cp in (2364, 2381) then null;                                     -- a stray nukta or virama
    elsif cp in (2404, 2405) then out := out || ' ';                        -- danda
    else out := out || ch;
    end if;
    i := i + 1;
  end loop;
  return out;
end $$;

-- A "sounds like" key per word (after transliteration): ph=f, w=v, z=s, ch, sh, th … folded, vowels after the first
-- letter dropped, doubled letters once. "Vitals" and "वाइटल्स" both give "vtls".
create function pulse.dir_sound(p text) returns text
  language plpgsql immutable parallel safe set search_path = pulse, pg_catalog, pg_temp as $$
declare w text; out text[] := '{}';
begin
  foreach w in array regexp_split_to_array(dir_fold(dir_translit(p)), ' ') loop
    if w = '' then continue; end if;
    w := regexp_replace(w, '[\u0900-\u097F]', '', 'g');
    w := replace(replace(replace(w, 'chh', 'C'), 'ch', 'C'), 'ck', 'k');
    w := replace(replace(replace(replace(replace(w, 'sh', 's'), 'ph', 'f'), 'th', 't'), 'dh', 'd'), 'kh', 'k');
    w := replace(replace(replace(replace(w, 'gh', 'g'), 'bh', 'b'), 'jh', 'j'), 'q', 'k');
    w := replace(replace(replace(replace(w, 'x', 'ks'), 'w', 'v'), 'z', 's'), 'c', 'k');
    w := replace(w, 'C', 'c');
    w := left(w, 1) || regexp_replace(substr(w, 2), '[aeiouh]', '', 'g');
    w := regexp_replace(w, '(.)\1+', '\1', 'g');
    if w <> '' then out := out || w; end if;
  end loop;
  return array_to_string(out, ' ');
end $$;

-- What was typed as a full-text query: every word, the last one (or every one) as a prefix. Null when nothing is left.
create function pulse.dir_tsquery(p text) returns tsquery
  language sql immutable parallel safe set search_path = pulse, pg_catalog, pg_temp as $$
  select case when x = '' then null else to_tsquery('simple', x) end
    from (select coalesce(string_agg(w || ':*', ' & '), '') x
            from unnest(regexp_split_to_array(dir_fold(dir_translit(p)), ' ')) w
           where w ~ '^[a-z0-9]+$') q
$$;

-- ------------------------------------------------------------------------------------------------ the company's card
create table pulse.org_public_card (
  org_id            uuid primary key references pulse.org(id) on delete cascade,
  listed            boolean not null default true,                  -- "Show us in search"
  legal_name        text check (length(legal_name) <= 160),
  city              text check (length(city) <= 80),
  industry          text check (length(industry) <= 80),
  website           text check (website is null or (length(website) <= 200 and website ~* '^https?://[^[:space:]/]+\.[^[:space:]]+$')),
  gstin             text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][0-9A-Z][0-9A-Z]$'),
  cin               text check (cin is null or cin ~ '^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$'),
  other_ids         jsonb not null default '[]' check (jsonb_typeof(other_ids) = 'array' and jsonb_array_length(other_ids) <= 8),
  show_legal_name   boolean not null default false,
  show_logo         boolean not null default true,
  show_city         boolean not null default true,
  show_industry     boolean not null default false,
  show_website      boolean not null default false,
  show_ids          boolean not null default false,
  -- Room for a later check with the official registry (GST portal, MCA). Today only the format is checked.
  registry_status   text not null default 'not_checked' check (registry_status in ('not_checked', 'matched', 'mismatch')),
  registry_checked_at timestamptz,
  updated_by        uuid,
  updated_at        timestamptz not null default now()
);
alter table pulse.org_public_card enable row level security;
alter table pulse.org_public_card force row level security;
create policy tenant_isolation on pulse.org_public_card using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse.org_public_card from public;
create trigger audit_mutation after insert or update or delete on pulse.org_public_card for each row execute function pulse.audit_mutation();

-- ------------------------------------------------------------------------------------------------ a person's choice
alter table pulse_priv.account_profile
  add column directory_on    boolean not null default false,          -- "Let people find me"
  add column directory_email boolean not null default false,          -- show my e-mail
  add column directory_phone boolean not null default false,          -- show my phone
  add column directory_org   uuid references pulse.org(id) on delete set null;   -- the company I show

-- ------------------------------------------------------------------------------------------------ the index
-- Only public values. org_id: the company itself, or the company a person shows (else the company of their first
-- seat), so each company's row security sees its own entries and nobody else's.
create table pulse.directory_entry (
  org_id          uuid not null references pulse.org(id) on delete cascade,
  kind            text not null check (kind in ('company', 'person')),
  ref             uuid not null,                       -- the company (org id) or the person's Pulse account
  handle          text not null,
  name            text not null,
  legal_name      text,
  city            text,
  industry        text,
  website         text,
  headline        text,
  company_ref     uuid,
  company_handle  text,
  company_name    text,
  ids             jsonb not null default '[]',         -- [{kind, label, value}] the company shows
  id_keys         text[] not null default '{}',        -- the same, as compared (and a person's shown e-mail or phone)
  email           text,
  phone           text,
  picture_version int,                                 -- logo or photo version when one is shown
  verified_by     text check (verified_by in ('gstin', 'cin')),
  name_fold       text not null default '',
  name_core       text not null default '',
  fuzzy           text not null default '',
  sound           text not null default '',
  id_text         text not null default '',
  tsv             tsvector not null default ''::tsvector,
  updated_at      timestamptz not null default now(),
  primary key (kind, ref)
);
alter table pulse.directory_entry enable row level security;
alter table pulse.directory_entry force row level security;
create policy tenant_isolation on pulse.directory_entry using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse.directory_entry from public;

create function pulse.directory_entry_fill() returns trigger
  language plpgsql set search_path = pulse, pg_temp as $$
declare lat text := dir_fold(dir_translit(new.name));
begin
  new.name_fold := lat;
  new.name_core := dir_core(dir_translit(new.name));
  new.fuzzy := btrim(lat || ' ' || dir_fold(dir_translit(coalesce(new.legal_name, ''))) || ' ' || new.handle);
  new.sound := dir_sound(new.name || ' ' || coalesce(new.legal_name, ''));
  new.id_text := array_to_string(new.id_keys, ' ');
  new.tsv := setweight(to_tsvector('simple', lat || ' ' || new.handle), 'A')
          || setweight(to_tsvector('simple', dir_fold(dir_translit(coalesce(new.legal_name, '')))), 'B')
          || setweight(to_tsvector('simple', dir_fold(coalesce(new.headline, '') || ' ' || coalesce(new.company_name, ''))), 'C')
          || setweight(to_tsvector('simple', dir_fold(coalesce(new.city, '') || ' ' || coalesce(new.industry, ''))), 'D');
  new.updated_at := now();
  return new;
end $$;
create trigger directory_entry_fill before insert or update on pulse.directory_entry for each row execute function pulse.directory_entry_fill();

create index directory_entry_org on pulse.directory_entry(org_id);
create index directory_entry_company_ref on pulse.directory_entry(company_ref) where kind = 'person';
create index directory_entry_handle on pulse.directory_entry(kind, handle text_pattern_ops);
create index directory_entry_core on pulse.directory_entry(kind, name_core);
create index directory_entry_prefix on pulse.directory_entry(kind, name_fold text_pattern_ops);
create index directory_entry_ids on pulse.directory_entry using gin (id_keys);
create index directory_entry_c_fuzzy on pulse.directory_entry using gin (fuzzy public.gin_trgm_ops) where kind = 'company';
create index directory_entry_p_fuzzy on pulse.directory_entry using gin (fuzzy public.gin_trgm_ops) where kind = 'person';
create index directory_entry_c_sound on pulse.directory_entry using gin (sound public.gin_trgm_ops) where kind = 'company';
create index directory_entry_p_sound on pulse.directory_entry using gin (sound public.gin_trgm_ops) where kind = 'person';
create index directory_entry_idtext on pulse.directory_entry using gin (id_text public.gin_trgm_ops) where id_text <> '';
create index directory_entry_tsv on pulse.directory_entry using gin (tsv);

-- ------------------------------------------------------------------------------------------------ keeping it in step
-- A company's entry from its org row, card and logo. Listed: active, a company (not a personal space), not a
-- rehearsal, and "Show us in search" on. Hidden fields are never written. People who show it follow its name.
create function pulse.directory_refresh_company(p_org uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o text := coalesce(current_setting('pulse.org_id', true), ''); g record; k record; b record; ids jsonb := '[]'; keys text[] := '{}'; x jsonb; v text;
begin
  select id, name, handle, status, kind, rehearsal into g from org where id = p_org;
  select * into k from org_public_card where org_id = p_org;
  if g.id is null or g.handle is null or g.status <> 'active' or g.kind <> 'company' or g.rehearsal or coalesce(k.listed, true) = false then
    delete from directory_entry where kind = 'company' and ref = p_org;
  else
    perform set_config('pulse.org_id', p_org::text, true);
    select version, (mark is not null or logo is not null) has into b from org_brand where org_id = p_org;
    perform set_config('pulse.org_id', o, true);
    if coalesce(k.show_ids, false) then
      if k.gstin is not null then
        ids := ids || jsonb_build_object('kind', 'gstin', 'label', 'GSTIN', 'value', k.gstin);
        keys := keys || k.gstin || substr(k.gstin, 3, 10);                       -- the GSTIN and the PAN inside it
      end if;
      if k.cin is not null then ids := ids || jsonb_build_object('kind', 'cin', 'label', 'CIN', 'value', k.cin); keys := keys || k.cin; end if;
      for x in select * from jsonb_array_elements(k.other_ids) loop
        v := x ->> 'value';
        if coalesce(v, '') = '' then continue; end if;
        ids := ids || jsonb_build_object('kind', x ->> 'kind', 'label', coalesce(nullif(x ->> 'label', ''), upper(x ->> 'kind')), 'value', v);
        keys := keys || dir_id_norm(v);
      end loop;
    end if;
    insert into directory_entry(org_id, kind, ref, handle, name, legal_name, city, industry, website, ids, id_keys, picture_version, verified_by)
    values (p_org, 'company', p_org, g.handle, g.name,
      case when k.show_legal_name then nullif(btrim(k.legal_name), '') end,
      case when coalesce(k.show_city, true) then nullif(btrim(k.city), '') end,
      case when k.show_industry then nullif(btrim(k.industry), '') end,
      case when k.show_website then nullif(btrim(k.website), '') end,
      ids, array(select distinct u from unnest(keys) u where u <> ''),
      case when coalesce(k.show_logo, true) and b.has then b.version end,
      case when k.gstin is not null and gstin_valid(k.gstin) then 'gstin' when k.cin is not null and cin_valid(k.cin) then 'cin' end)
    on conflict (kind, ref) do update set org_id = excluded.org_id, handle = excluded.handle, name = excluded.name,
      legal_name = excluded.legal_name, city = excluded.city, industry = excluded.industry, website = excluded.website,
      ids = excluded.ids, id_keys = excluded.id_keys, picture_version = excluded.picture_version, verified_by = excluded.verified_by;
  end if;
  update directory_entry e set company_handle = d.handle, company_name = d.name
    from (select g.handle, g.name) d where e.kind = 'person' and e.company_ref = p_org
     and (e.company_handle is distinct from d.handle or e.company_name is distinct from d.name);
end $$;

-- The company a person shows: their chosen seat's company, else their latest staff or freelancer seat in a listed
-- company. Null when they have none.
create function pulse.directory_person_company(p_account uuid) returns uuid
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select am.member_org from pulse_priv.account_member am join org g on g.id = am.member_org
    left join pulse_priv.account_profile ap on ap.account_id = am.account_id
   where am.account_id = p_account and am.kind in ('staff', 'freelancer') and g.status = 'active' and g.kind = 'company' and not g.rehearsal
   order by (am.member_org = ap.directory_org) desc nulls last, am.joined_at desc limit 1
$$;

-- A person's entry: only while "Let people find me" is on. Name and handle from the account; headline and photo from
-- the account profile; e-mail and phone only when ticked.
create function pulse.directory_refresh_person(p_account uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a record; p record; co uuid; home uuid; g record; keys text[] := '{}';
begin
  select id, handle, display_name into a from pulse_priv.pulse_account where id = p_account;
  select * into p from pulse_priv.account_profile where account_id = p_account;
  co := directory_person_company(p_account);
  select coalesce(co, (select member_org from pulse_priv.account_member where account_id = p_account and kind <> 'agent' order by joined_at limit 1)) into home;
  if a.id is null or not coalesce(p.directory_on, false) or home is null
     or exists (select 1 from pulse_priv.account_member where account_id = p_account and kind = 'agent') then
    delete from directory_entry where kind = 'person' and ref = p_account;
    return;
  end if;
  select handle, name into g from org where id = co;
  if p.directory_email and p.contact_email is not null then keys := keys || lower(p.contact_email); end if;
  if p.directory_phone and p.contact_phone is not null then keys := keys || right(regexp_replace(p.contact_phone, '\D', '', 'g'), 10); end if;
  insert into directory_entry(org_id, kind, ref, handle, name, headline, company_ref, company_handle, company_name, email, phone, id_keys, picture_version)
  values (home, 'person', p_account, a.handle, a.display_name, nullif(btrim(p.headline), ''), co, g.handle, g.name,
    case when p.directory_email then p.contact_email end, case when p.directory_phone then p.contact_phone end, keys,
    case when p.photo_bytes is not null then (extract(epoch from p.photo_at)::bigint % 2000000000)::int end)
  on conflict (kind, ref) do update set org_id = excluded.org_id, handle = excluded.handle, name = excluded.name,
    headline = excluded.headline, company_ref = excluded.company_ref, company_handle = excluded.company_handle,
    company_name = excluded.company_name, email = excluded.email, phone = excluded.phone, id_keys = excluded.id_keys,
    picture_version = excluded.picture_version;
end $$;

create function pulse.directory_follow() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  case tg_table_name
    when 'org' then perform directory_refresh_company(new.id);
    when 'org_public_card' then perform directory_refresh_company(coalesce(new.org_id, old.org_id));
    when 'org_brand' then perform directory_refresh_company(coalesce(new.org_id, old.org_id));
    when 'pulse_account' then
      if exists (select 1 from directory_entry where kind = 'person' and ref = new.id) then perform directory_refresh_person(new.id); end if;
    when 'account_profile' then perform directory_refresh_person(coalesce(new.account_id, old.account_id));
    when 'account_member' then
      if exists (select 1 from directory_entry where kind = 'person' and ref in (new.account_id, old.account_id)) then
        if tg_op <> 'INSERT' then perform directory_refresh_person(old.account_id); end if;
        if tg_op <> 'DELETE' then perform directory_refresh_person(new.account_id); end if;
      end if;
  end case;
  return null;
end $$;
create trigger directory_follow after insert or update of name, handle, status, kind, rehearsal on pulse.org
  for each row execute function pulse.directory_follow();
create trigger directory_follow after insert or update or delete on pulse.org_public_card
  for each row execute function pulse.directory_follow();
create trigger directory_follow after insert or update of mark, logo, version or delete on pulse.org_brand
  for each row execute function pulse.directory_follow();
create trigger directory_follow after update of handle, display_name on pulse_priv.pulse_account
  for each row execute function pulse.directory_follow();
create trigger directory_follow after insert or update or delete on pulse_priv.account_profile
  for each row execute function pulse.directory_follow();
create trigger directory_follow after insert or update or delete on pulse_priv.account_member
  for each row execute function pulse.directory_follow();

-- ------------------------------------------------------------------------------------------------ search
-- Companies for anyone signed in. The explicit column list is everything a company card shows; nothing else exists in
-- the index. match: id, handle, name, prefix, words, fuzzy, sounds.
create function pulse.directory_companies(p_q text, p_limit int default 8, p_exclude uuid default null)
returns table (id uuid, handle text, name text, legal_name text, city text, industry text, website text,
  logo_version int, verified_by text, ids jsonb, match text, score real)
  language plpgsql stable security definer set search_path = pulse, pg_temp
  set pg_trgm.word_similarity_threshold = 0.4 set pg_trgm.strict_word_similarity_threshold = 0.5 set pg_trgm.similarity_threshold = 0.45 set plan_cache_mode = force_custom_plan as $$
declare raw text := left(btrim(coalesce(p_q, '')), 120); f text; core text; idn text; hq text; snd text; tsq tsquery;
  lim int := least(greatest(coalesce(p_limit, 8), 1), 20); good text[] := '{}'; bad text[] := '{}'; w text; gq tsquery; bf text;
begin
  if current_viewer() is null then raise exception 'Sign in to search' using errcode = '42501'; end if;
  f := dir_fold(dir_translit(raw)); core := dir_core(dir_translit(raw)); idn := dir_id_norm(raw);
  hq := lower(regexp_replace(raw, '^@', '')); snd := dir_sound(raw); tsq := dir_tsquery(raw);
  if length(f) < 2 then return; end if;
  -- Several words, some found as they are and some not (a typo): close spelling looks only at the words not found and
  -- asks the found ones of the full-text index, so a common word ("Shree") does not make every such name a candidate.
  bf := f;
  if tsq is not null and f ~ ' ' then
    foreach w in array regexp_split_to_array(f, ' ') loop
      continue when w !~ '^[a-z0-9]+$';
      if exists (select 1 from directory_entry e where e.kind = 'company' and e.tsv @@ to_tsquery('simple', w || ':*')) then good := good || w; else bad := bad || w; end if;
    end loop;
    if cardinality(good) > 0 and cardinality(bad) > 0 and length(array_to_string(bad, ' ')) >= 3 then
      gq := to_tsquery('simple', array_to_string(array(select x || ':*' from unnest(good) x), ' & '));
      bf := array_to_string(bad, ' ');
    end if;
  end if;
  -- Stages, cheapest first. A later stage runs only while the earlier ones found fewer than the page holds:
  -- its best score is below theirs, so it could not reach the page anyway (the ranking is the same, the work is not).
  return query
  with s1 as materialized (
    select e.ref, 100::real s, 'id'::text m from directory_entry e
     where length(idn) >= 6 and e.id_keys @> array[idn] and e.kind = 'company'
    union all
    select e.ref, 96, 'handle' from directory_entry e where e.kind = 'company' and e.handle = hq
    union all
    select e.ref, 90, 'name' from directory_entry e where e.kind = 'company' and e.name_core = core
    union all
    (select e.ref, 70, 'id' from directory_entry e
      where length(idn) >= 6 and idn ~ '[0-9]' and e.id_text <> '' and e.id_text like '%' || idn || '%' and e.kind = 'company' limit 20)
    union all
    (select e.ref, (80 + public.similarity(e.name_fold, f) * 5)::real, 'prefix' from directory_entry e
      where e.kind = 'company' and e.name_fold like replace(replace(replace(f, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      order by e.name_fold using ~<~ limit 40)
    union all
    (select e.ref, 78, 'handle' from directory_entry e
      where e.kind = 'company' and length(hq) >= 2 and e.handle like replace(replace(hq, '_', '\_'), '%', '\%') || '%'
      order by e.handle using ~<~ limit 20)
  ), s2 as materialized (
    (select t.ref, (60 + t.r * 10)::real, 'words' from (
       select e.ref, ts_rank(e.tsv, tsq) r from directory_entry e
        where tsq is not null and e.kind = 'company' and e.tsv @@ tsq
          and (select count(distinct x.ref) from s1 x) <= lim limit 400) t
      order by t.r desc limit 40)
  ), s3 as materialized (
    -- Close spelling, strict first (whole words: few candidates). Never when an exact ID, @handle or name matched.
    (select t.ref, (40 + t.w * 15)::real, 'fuzzy' from (
       select e.ref, public.word_similarity(f, e.fuzzy) w from directory_entry e
        where length(f) >= 3 and e.kind = 'company' and bf operator(public.<<%) e.fuzzy and (gq is null or e.tsv @@ gq)
          and not exists (select 1 from s1 x where x.s >= 90) and (select count(distinct x.ref) from (select ref from s1 union select ref from s2) x) <= lim limit 400) t
      order by t.w desc limit 40)
  ), s4 as (
    -- The strict pass found nothing: looser close spelling (a letter missing or swapped in a short word), then sounds like.
    (select t.ref, (40 + t.w * 15)::real, 'fuzzy' from (
       select e.ref, public.word_similarity(f, e.fuzzy) w from directory_entry e
        where length(f) >= 3 and e.kind = 'company' and bf operator(public.<%) e.fuzzy and (gq is null or e.tsv @@ gq)
          and not exists (select 1 from s1 x where x.s >= 90) and not exists (select 1 from s3) and (select count(distinct x.ref) from (select ref from s1 union select ref from s2) x) <= lim limit 400) t
      order by t.w desc limit 40)
    union all
    (select t.ref, (20 + t.w * 15)::real, 'sounds' from (
       select e.ref, public.similarity(snd, e.sound) w from directory_entry e
        where length(snd) >= 3 and e.kind = 'company' and e.sound operator(public.%) snd and (gq is null or e.tsv @@ gq)
          and not exists (select 1 from s1 x where x.s >= 90) and not exists (select 1 from s3) and (select count(distinct x.ref) from (select ref from s1 union select ref from s2) x) <= lim limit 400) t
      order by t.w desc limit 20)
  ), c as (
    select * from s1 union all select * from s2 union all select * from s3 union all select * from s4
  ), best as (
    select distinct on (c.ref) c.ref, c.s, c.m from c order by c.ref, c.s desc
  )
  select e.ref, e.handle, e.name, e.legal_name, e.city, e.industry, e.website, e.picture_version, e.verified_by, e.ids, b.m, b.s
    from best b join directory_entry e on e.kind = 'company' and e.ref = b.ref
   where p_exclude is null or e.ref <> p_exclude
   order by b.s desc, length(e.name), e.name, e.handle
   limit lim;
end $$;

-- People who turned on "Let people find me", for anyone signed in. E-mail and phone only when they show them.
create function pulse.directory_people(p_q text, p_limit int default 8)
returns table (handle text, name text, headline text, photo_version int, company_handle text, company_name text,
  email text, phone text, match text, score real)
  language plpgsql stable security definer set search_path = pulse, pg_temp
  set pg_trgm.word_similarity_threshold = 0.4 set pg_trgm.strict_word_similarity_threshold = 0.5 set pg_trgm.similarity_threshold = 0.45 set plan_cache_mode = force_custom_plan as $$
declare raw text := left(btrim(coalesce(p_q, '')), 120); f text; core text; hq text; snd text; tsq tsquery; key text;
  lim int := least(greatest(coalesce(p_limit, 8), 1), 20); good text[] := '{}'; bad text[] := '{}'; w text; gq tsquery; bf text;
begin
  if current_viewer() is null then raise exception 'Sign in to search' using errcode = '42501'; end if;
  f := dir_fold(dir_translit(raw)); core := dir_core(dir_translit(raw)); hq := lower(regexp_replace(raw, '^@', ''));
  snd := dir_sound(raw); tsq := dir_tsquery(raw);
  key := case when raw ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then lower(raw)
              when regexp_replace(raw, '\D', '', 'g') ~ '^[0-9]{10,13}$' and raw !~ '[A-Za-z]' then right(regexp_replace(raw, '\D', '', 'g'), 10) end;
  if length(f) < 2 then return; end if;
  -- Several words, some found as they are and some not (a typo): close spelling looks only at the words not found and
  -- asks the found ones of the full-text index, so a common word ("Shree") does not make every such name a candidate.
  bf := f;
  if tsq is not null and f ~ ' ' then
    foreach w in array regexp_split_to_array(f, ' ') loop
      continue when w !~ '^[a-z0-9]+$';
      if exists (select 1 from directory_entry e where e.kind = 'person' and e.tsv @@ to_tsquery('simple', w || ':*')) then good := good || w; else bad := bad || w; end if;
    end loop;
    if cardinality(good) > 0 and cardinality(bad) > 0 and length(array_to_string(bad, ' ')) >= 3 then
      gq := to_tsquery('simple', array_to_string(array(select x || ':*' from unnest(good) x), ' & '));
      bf := array_to_string(bad, ' ');
    end if;
  end if;
  -- Stages, cheapest first. A later stage runs only while the earlier ones found fewer than the page holds:
  -- its best score is below theirs, so it could not reach the page anyway (the ranking is the same, the work is not).
  return query
  with s1 as materialized (
    select e.ref, 100::real s, 'id'::text m from directory_entry e where key is not null and e.id_keys @> array[key] and e.kind = 'person'
    union all
    select e.ref, 96, 'handle' from directory_entry e where e.kind = 'person' and e.handle = hq
    union all
    select e.ref, 90, 'name' from directory_entry e where e.kind = 'person' and e.name_core = core
    union all
    (select e.ref, (80 + public.similarity(e.name_fold, f) * 5)::real, 'prefix' from directory_entry e
      where e.kind = 'person' and e.name_fold like replace(replace(replace(f, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      order by e.name_fold using ~<~ limit 40)
    union all
    (select e.ref, 78, 'handle' from directory_entry e
      where e.kind = 'person' and length(hq) >= 2 and e.handle like replace(replace(hq, '_', '\_'), '%', '\%') || '%'
      order by e.handle using ~<~ limit 20)
  ), s2 as materialized (
    (select t.ref, (60 + t.r * 10)::real, 'words' from (
       select e.ref, ts_rank(e.tsv, tsq) r from directory_entry e
        where tsq is not null and e.kind = 'person' and e.tsv @@ tsq
          and (select count(distinct x.ref) from s1 x) < lim limit 400) t
      order by t.r desc limit 40)
  ), s3 as materialized (
    -- Close spelling, strict first (whole words: few candidates). Never when an exact ID, @handle or name matched.
    (select t.ref, (40 + t.w * 15)::real, 'fuzzy' from (
       select e.ref, public.word_similarity(f, e.fuzzy) w from directory_entry e
        where length(f) >= 3 and e.kind = 'person' and bf operator(public.<<%) e.fuzzy and (gq is null or e.tsv @@ gq)
          and not exists (select 1 from s1 x where x.s >= 90) and (select count(distinct x.ref) from (select ref from s1 union select ref from s2) x) < lim limit 400) t
      order by t.w desc limit 40)
  ), s4 as (
    -- The strict pass found nothing: looser close spelling (a letter missing or swapped in a short word), then sounds like.
    (select t.ref, (40 + t.w * 15)::real, 'fuzzy' from (
       select e.ref, public.word_similarity(f, e.fuzzy) w from directory_entry e
        where length(f) >= 3 and e.kind = 'person' and bf operator(public.<%) e.fuzzy and (gq is null or e.tsv @@ gq)
          and not exists (select 1 from s1 x where x.s >= 90) and not exists (select 1 from s3) and (select count(distinct x.ref) from (select ref from s1 union select ref from s2) x) < lim limit 400) t
      order by t.w desc limit 40)
    union all
    (select t.ref, (20 + t.w * 15)::real, 'sounds' from (
       select e.ref, public.similarity(snd, e.sound) w from directory_entry e
        where length(snd) >= 3 and e.kind = 'person' and e.sound operator(public.%) snd and (gq is null or e.tsv @@ gq)
          and not exists (select 1 from s1 x where x.s >= 90) and not exists (select 1 from s3) and (select count(distinct x.ref) from (select ref from s1 union select ref from s2) x) < lim limit 400) t
      order by t.w desc limit 20)
  ), c as (
    select * from s1 union all select * from s2 union all select * from s3 union all select * from s4
  ), best as (
    select distinct on (c.ref) c.ref, c.s, c.m from c order by c.ref, c.s desc
  )
  select e.handle, e.name, e.headline, e.picture_version, e.company_handle, e.company_name, e.email, e.phone, b.m, b.s
    from best b join directory_entry e on e.kind = 'person' and e.ref = b.ref
   order by b.s desc, length(e.name), e.name, e.handle
   limit lim;
end $$;

-- One company's card by its @handle (a listed company only). The same columns as a search result.
create function pulse.directory_company(p_handle text)
returns table (id uuid, handle text, name text, legal_name text, city text, industry text, website text,
  logo_version int, verified_by text, ids jsonb)
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is null then raise exception 'Sign in to see companies' using errcode = '42501'; end if;
  return query select e.ref, e.handle, e.name, e.legal_name, e.city, e.industry, e.website, e.picture_version, e.verified_by, e.ids
    from directory_entry e where e.kind = 'company' and e.handle = lower(regexp_replace(btrim(coalesce(p_handle, '')), '^@', ''));
end $$;

create function pulse.directory_person(p_handle text)
returns table (handle text, name text, headline text, photo_version int, company_handle text, company_name text, email text, phone text)
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is null then raise exception 'Sign in to see people' using errcode = '42501'; end if;
  return query select e.handle, e.name, e.headline, e.picture_version, e.company_handle, e.company_name, e.email, e.phone
    from directory_entry e where e.kind = 'person' and e.handle = lower(regexp_replace(btrim(coalesce(p_handle, '')), '^@', ''));
end $$;

-- The square logo a listed company shows (the mark, else the wide logo), or nothing.
create function pulse.directory_company_logo(p_handle text) returns table (mime text, bytes bytea, version int)
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare o text := coalesce(current_setting('pulse.org_id', true), ''); r uuid;
begin
  if current_viewer() is null then raise exception 'Sign in to see companies' using errcode = '42501'; end if;
  select e.ref into r from directory_entry e where e.kind = 'company' and e.handle = lower(btrim(coalesce(p_handle, ''))) and e.picture_version is not null;
  if r is null then return; end if;
  perform set_config('pulse.org_id', r::text, true);
  return query select coalesce(b.mark_mime, b.logo_mime), coalesce(b.mark, b.logo), b.version from org_brand b where b.org_id = r;
  perform set_config('pulse.org_id', o, true);
end $$;

-- The photo of a person who can be found, or nothing.
create function pulse.directory_person_photo(p_handle text) returns table (mime text, bytes bytea, version int)
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is null then raise exception 'Sign in to see people' using errcode = '42501'; end if;
  return query select p.photo_mime, p.photo_bytes, e.picture_version from directory_entry e
    join pulse_priv.account_profile p on p.account_id = e.ref
   where e.kind = 'person' and e.handle = lower(btrim(coalesce(p_handle, ''))) and e.picture_version is not null and p.photo_bytes is not null;
end $$;

-- ------------------------------------------------------------------------------------------------ the admin's card
create function pulse.directory_card_json() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('name', g.name, 'handle', g.handle,
    'listed', coalesce(k.listed, true), 'legalName', k.legal_name, 'city', k.city, 'industry', k.industry, 'website', k.website,
    'gstin', k.gstin, 'cin', k.cin, 'otherIds', coalesce(k.other_ids, '[]'),
    'show', jsonb_build_object('legalName', coalesce(k.show_legal_name, false), 'logo', coalesce(k.show_logo, true),
      'city', coalesce(k.show_city, true), 'industry', coalesce(k.show_industry, false),
      'website', coalesce(k.show_website, false), 'ids', coalesce(k.show_ids, false)),
    'verifiedBy', case when gstin_valid(k.gstin) then 'gstin' when cin_valid(k.cin) then 'cin' end,
    'registryStatus', coalesce(k.registry_status, 'not_checked'),
    'hasLogo', exists (select 1 from org_brand b where b.org_id = g.id and (b.mark is not null or b.logo is not null)),
    'shown', (select to_jsonb(e) - 'org_id' - 'ref' - 'name_fold' - 'name_core' - 'fuzzy' - 'sound' - 'id_text' - 'tsv' - 'id_keys' - 'updated_at' - 'email' - 'phone' - 'headline' - 'company_ref' - 'company_handle' - 'company_name'
                from directory_entry e where e.kind = 'company' and e.ref = g.id))
  from org g left join org_public_card k on k.org_id = g.id where g.id = current_org()
$$;

create function pulse.directory_card_get() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is null or not viewer_is('admin') then raise exception 'A company admin sets the public profile' using errcode = '42501'; end if;
  return directory_card_json();
end $$;

-- Save the card ({listed, legalName, city, industry, website, gstin, cin, otherIds:[{kind,value,label?}], show:{…}}).
-- A key left out keeps its value. Every change is in the company's record history.
create function pulse.directory_card_save(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k org_public_card; before jsonb; others jsonb := '[]'; x jsonb; v text; s jsonb := coalesce(p -> 'show', '{}');
  txt text;
begin
  if current_viewer() is null or not viewer_is('admin') then raise exception 'A company admin sets the public profile' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p, 'null')) <> 'object' then raise exception 'Send the profile as fields' using errcode = '22023'; end if;
  insert into org_public_card(org_id) values (current_org()) on conflict (org_id) do nothing;
  select * into k from org_public_card where org_id = current_org() for update;
  before := directory_card_json();
  if p ? 'listed' then k.listed := coalesce((p ->> 'listed')::boolean, true); end if;
  foreach txt in array array['legalName', 'city', 'industry', 'website'] loop
    if p ? txt then
      v := nullif(btrim(coalesce(p ->> txt, '')), '');
      if txt = 'legalName' then
        if length(v) > 160 then raise exception 'Keep the legal name under 160 letters' using errcode = '22023'; end if; k.legal_name := v;
      elsif txt = 'city' then
        if length(v) > 80 then raise exception 'Keep the city under 80 letters' using errcode = '22023'; end if; k.city := v;
      elsif txt = 'industry' then
        if length(v) > 80 then raise exception 'Keep the industry under 80 letters' using errcode = '22023'; end if; k.industry := v;
      else
        if v is not null and v !~* '^https?://' then v := 'https://' || v; end if;
        if v is not null and (length(v) > 200 or v !~* '^https?://[^[:space:]/]+\.[^[:space:]]+$') then
          raise exception 'Type the website like www.example.com' using errcode = '22023';
        end if;
        k.website := v;
      end if;
    end if;
  end loop;
  if p ? 'gstin' then k.gstin := dir_id_check('gstin', p ->> 'gstin'); end if;
  if p ? 'cin' then k.cin := dir_id_check('cin', p ->> 'cin'); end if;
  if p ? 'otherIds' then
    if jsonb_typeof(p -> 'otherIds') <> 'array' or jsonb_array_length(p -> 'otherIds') > 8 then
      raise exception 'Add up to 8 other IDs' using errcode = '22023';
    end if;
    for x in select * from jsonb_array_elements(p -> 'otherIds') loop
      v := dir_id_check(coalesce(x ->> 'kind', 'other'), x ->> 'value');
      if v is null then continue; end if;
      others := others || jsonb_build_object('kind', coalesce(x ->> 'kind', 'other'), 'value', v,
        'label', case coalesce(x ->> 'kind', 'other') when 'llpin' then 'LLPIN' when 'pan' then 'PAN' when 'udyam' then 'Udyam'
          else coalesce(nullif(left(btrim(x ->> 'label'), 30), ''), 'ID') end);
    end loop;
    k.other_ids := others;
  end if;
  if s ? 'legalName' then k.show_legal_name := coalesce((s ->> 'legalName')::boolean, false); end if;
  if s ? 'logo' then k.show_logo := coalesce((s ->> 'logo')::boolean, true); end if;
  if s ? 'city' then k.show_city := coalesce((s ->> 'city')::boolean, true); end if;
  if s ? 'industry' then k.show_industry := coalesce((s ->> 'industry')::boolean, false); end if;
  if s ? 'website' then k.show_website := coalesce((s ->> 'website')::boolean, false); end if;
  if s ? 'ids' then k.show_ids := coalesce((s ->> 'ids')::boolean, false); end if;
  -- A new GSTIN or CIN has not been checked with the registry.
  if (p ? 'gstin' or p ? 'cin') then k.registry_status := 'not_checked'; k.registry_checked_at := null; end if;
  update org_public_card set listed = k.listed, legal_name = k.legal_name, city = k.city, industry = k.industry,
    website = k.website, gstin = k.gstin, cin = k.cin, other_ids = k.other_ids, show_legal_name = k.show_legal_name,
    show_logo = k.show_logo, show_city = k.show_city, show_industry = k.show_industry, show_website = k.show_website,
    show_ids = k.show_ids, registry_status = k.registry_status, registry_checked_at = k.registry_checked_at,
    updated_by = current_viewer(), updated_at = now()
   where org_id = current_org();
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (current_org(), 'org', current_org(), 'public_profile', (before - 'shown')::text, (directory_card_json() - 'shown')::text, current_viewer());
  return directory_card_json();
end $$;

-- ------------------------------------------------------------------------------------------------ my own choice
create function pulse.directory_me() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare a uuid := account_of_viewer(); p record; acct record;
begin
  if current_viewer() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if a is null then
    return jsonb_build_object('findable', false, 'showEmail', false, 'showPhone', false, 'company', null, 'companies', '[]'::jsonb,
      'hasEmail', false, 'hasPhone', false, 'shown', null, 'account', false);
  end if;
  select * into p from pulse_priv.account_profile where account_id = a;
  select handle, display_name into acct from pulse_priv.pulse_account where id = a;
  return jsonb_build_object('account', true, 'handle', acct.handle, 'name', acct.display_name,
    'findable', coalesce(p.directory_on, false), 'showEmail', coalesce(p.directory_email, false), 'showPhone', coalesce(p.directory_phone, false),
    'hasEmail', p.contact_email is not null, 'hasPhone', p.contact_phone is not null,
    'company', (select g.handle from org g where g.id = directory_person_company(a)),
    'companies', coalesce((select jsonb_agg(jsonb_build_object('handle', g.handle, 'name', g.name) order by g.name)
        from pulse_priv.account_member am join org g on g.id = am.member_org
       where am.account_id = a and am.kind in ('staff', 'freelancer') and g.status = 'active' and g.kind = 'company' and not g.rehearsal), '[]'),
    'shown', (select jsonb_build_object('handle', e.handle, 'name', e.name, 'headline', e.headline, 'photoVersion', e.picture_version,
        'companyHandle', e.company_handle, 'companyName', e.company_name, 'email', e.email, 'phone', e.phone)
      from directory_entry e where e.kind = 'person' and e.ref = a));
end $$;

create function pulse.directory_me_save(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a uuid; co uuid; h text;
begin
  if current_viewer() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if exists (select 1 from person where id = current_viewer() and side = 'agent') then
    raise exception 'An AI employee is not listed in search' using errcode = '42501';
  end if;
  a := coalesce(account_of_viewer(), account_ensure());
  if a is null then raise exception 'Make your Pulse account first' using errcode = '42501'; end if;
  insert into pulse_priv.account_profile(account_id) values (a) on conflict (account_id) do nothing;
  if p ? 'company' then
    h := lower(regexp_replace(btrim(coalesce(p ->> 'company', '')), '^@', ''));
    if h <> '' then
      select am.member_org into co from pulse_priv.account_member am join org g on g.id = am.member_org
       where am.account_id = a and g.handle = h and am.kind in ('staff', 'freelancer');
      if co is null then raise exception 'You can show only a company you work in' using errcode = '22023'; end if;
    end if;
  end if;
  update pulse_priv.account_profile set
    directory_on = case when p ? 'findable' then coalesce((p ->> 'findable')::boolean, false) else directory_on end,
    directory_email = case when p ? 'showEmail' then coalesce((p ->> 'showEmail')::boolean, false) else directory_email end,
    directory_phone = case when p ? 'showPhone' then coalesce((p ->> 'showPhone')::boolean, false) else directory_phone end,
    directory_org = case when p ? 'company' then co else directory_org end,
    updated_at = now()
   where account_id = a;
  return directory_me();
end $$;

-- ------------------------------------------------------------------------------------------------ invites
create table pulse.directory_invite (
  org_id        uuid not null references pulse.org(id) on delete cascade,
  id            uuid primary key default gen_random_uuid(),
  company_name  text not null check (length(btrim(company_name)) between 2 and 160),
  email         text check (email is null or email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  phone         text check (phone is null or phone ~ '^\+?[0-9]{10,15}$'),
  purpose       text not null default 'general' check (purpose in ('general', 'contract')),
  note          text check (length(note) <= 300),
  token_hash    text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status        text not null default 'pending' check (status in ('pending', 'joined', 'cancelled')),
  joined_org    uuid references pulse.org(id) on delete set null,
  joined_at     timestamptz,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  check (email is not null or phone is not null)
);
create index directory_invite_org on pulse.directory_invite(org_id, created_at desc);
select pulse.check_values_add('pulse.record_change'::regclass, 'record_change_entity_type_check', 'entity_type', array['directory_invite']);
alter table pulse.directory_invite enable row level security;
alter table pulse.directory_invite force row level security;
create policy tenant_isolation on pulse.directory_invite using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse.directory_invite from public;

create function pulse.directory_invite_json(i pulse.directory_invite) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('id', i.id, 'companyName', i.company_name, 'email', i.email, 'phone', i.phone, 'purpose', i.purpose,
    'note', i.note, 'status', i.status, 'createdAt', i.created_at, 'joinedAt', i.joined_at,
    'joinedCompany', (select jsonb_build_object('id', g.id, 'handle', g.handle, 'name', g.name) from org g where g.id = i.joined_org))
$$;

-- A pending invite for a company that is not on Pulse yet. The API makes the link's token and passes only its hash.
-- At most 30 a day per company. Nothing is sent.
create function pulse.directory_invite_make(p_name text, p_email text, p_phone text, p_purpose text, p_note text, p_token_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare i directory_invite; e text := nullif(lower(btrim(coalesce(p_email, ''))), ''); ph text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
begin
  if current_viewer() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then raise exception 'Type the company''s name' using errcode = '22023'; end if;
  if length(btrim(p_name)) > 160 then raise exception 'Keep the name under 160 letters' using errcode = '22023'; end if;
  if e is null and ph is null then raise exception 'Add an e-mail or a phone number' using errcode = '22023'; end if;
  if e is not null and e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Check the e-mail address' using errcode = '22023'; end if;
  if ph is not null and ph !~ '^\+?[0-9]{10,15}$' then raise exception 'Type the phone with 10 numbers, like 98xxxxxxxx' using errcode = '22023'; end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'Keep the note under 300 letters' using errcode = '22023'; end if;
  if (select count(*) from directory_invite where org_id = current_org() and created_at > now() - interval '1 day') >= 30 then
    raise exception 'Your company made 30 invites today. Try again tomorrow.' using errcode = '54000';
  end if;
  insert into directory_invite(org_id, company_name, email, phone, purpose, note, token_hash, created_by)
  values (current_org(), btrim(p_name), e, ph, case when p_purpose = 'contract' then 'contract' else 'general' end,
    nullif(btrim(coalesce(p_note, '')), ''), p_token_hash, current_viewer())
  returning * into i;
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (current_org(), 'directory_invite', i.id, 'status', null, 'pending', current_viewer());
  return directory_invite_json(i);
end $$;

-- My company's invites: the ones I made, or every one for an admin.
create function pulse.directory_invites() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(directory_invite_json(i) order by i.created_at desc) from (
    select * from directory_invite where org_id = current_org() and (created_by = current_viewer() or viewer_is('admin'))
     order by created_at desc limit 100) i), '[]');
end $$;

-- After sign-up the join page hands the link back: the invite is marked joined with the signed-in person's company
-- (once). Returns who invited them, or null for an unknown or used link.
create function pulse.directory_invite_claim(p_token_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare i directory_invite; o text := coalesce(current_setting('pulse.org_id', true), ''); from_name text; from_handle text;
begin
  if current_viewer() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into i from directory_invite where token_hash = p_token_hash for update;
  if i.id is null then return null; end if;
  select name, handle into from_name, from_handle from org where id = i.org_id;
  if i.status = 'pending' and i.org_id <> current_org() then
    update directory_invite set status = 'joined', joined_org = current_org(), joined_at = now() where id = i.id returning * into i;
    perform set_config('pulse.org_id', i.org_id::text, true);
    insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
    values (i.org_id, 'directory_invite', i.id, 'status', 'pending', 'joined', null);
    perform set_config('pulse.org_id', o, true);
  end if;
  return jsonb_build_object('status', i.status, 'companyName', i.company_name, 'purpose', i.purpose,
    'from', jsonb_build_object('name', from_name, 'handle', from_handle), 'mine', i.joined_org = current_org());
end $$;

-- ------------------------------------------------------------------------------------------------ the owner's policy
-- The schema owner (the definer functions above) reads and writes these across companies. The policy names the owner
-- role itself (TO <owner> USING (true)) rather than testing current_user: for the owner the row check then folds to a
-- constant and is no security barrier, so the search's LIKE, full-text and trigram conditions can use their indexes
-- (with a current_user test every search scanned the whole table: 2-9 s on 100k companies). Every other role still has
-- the tenant policy only, and the API role has no grant on these tables at all.
do $$ declare o text := (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'pulse'); begin
  execute format('create policy directory on pulse.org_public_card for select to %I using (true)', o);
  execute format('create policy directory on pulse.directory_entry to %I using (true) with check (true)', o);
  execute format('create policy directory on pulse.directory_invite to %I using (true) with check (true)', o);
end $$;

-- ------------------------------------------------------------------------------------------------ grants
revoke all on function pulse.gstin_valid(text), pulse.cin_valid(text), pulse.dir_id_norm(text), pulse.dir_id_check(text, text),
  pulse.dir_fold(text), pulse.dir_core(text), pulse.dir_translit(text), pulse.dir_sound(text), pulse.dir_tsquery(text),
  pulse.directory_entry_fill(), pulse.directory_refresh_company(uuid), pulse.directory_person_company(uuid),
  pulse.directory_refresh_person(uuid), pulse.directory_follow(), pulse.directory_companies(text, int, uuid),
  pulse.directory_people(text, int), pulse.directory_company(text), pulse.directory_person(text),
  pulse.directory_company_logo(text), pulse.directory_person_photo(text), pulse.directory_card_json(),
  pulse.directory_card_get(), pulse.directory_card_save(jsonb), pulse.directory_me(), pulse.directory_me_save(jsonb),
  pulse.directory_invite_json(pulse.directory_invite), pulse.directory_invite_make(text, text, text, text, text, text),
  pulse.directory_invites(), pulse.directory_invite_claim(text) from public;
grant execute on function pulse.gstin_valid(text), pulse.cin_valid(text), pulse.directory_companies(text, int, uuid),
  pulse.directory_people(text, int), pulse.directory_company(text), pulse.directory_person(text),
  pulse.directory_company_logo(text), pulse.directory_person_photo(text), pulse.directory_card_get(),
  pulse.directory_card_save(jsonb), pulse.directory_me(), pulse.directory_me_save(jsonb),
  pulse.directory_invite_make(text, text, text, text, text, text), pulse.directory_invites(),
  pulse.directory_invite_claim(text) to pulse_api;

-- ------------------------------------------------------------------------------------------------ fill it
-- Every listed company gets its entry (name, handle, logo; nothing else is shown until its admins say so).
do $$ declare g record; begin
  for g in select id from pulse.org loop perform pulse.directory_refresh_company(g.id); end loop;
end $$;

-- The real companies' cards: name and handle are their own already; the city where it is on record (Estate
-- Autopilots: Pune). Nothing else, and nobody was asked anything.
do $$ declare g record; begin
  for g in select id, code from pulse.org
            where (code, handle) in (('EA', 'estateautopilots'), ('WL', 'willowlane'), ('VTI', 'vitalstechnologies'), ('SHU', 'suyashhq')) loop
    perform set_config('pulse.org_id', g.id::text, true);
    insert into pulse.org_public_card(org_id, city) values (g.id, case g.code when 'EA' then 'Pune' end)
    on conflict (org_id) do nothing;
  end loop;
  perform set_config('pulse.org_id', '', true);
end $$;

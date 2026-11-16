-- migrate:up
-- AGENT-MEMORY (13 Nov 2026, owner P4.1: T4.1.2–3). A role AI employee (the Project Coordinator) works in chat, client
-- WhatsApp groups and Pulse, and keeps memory at four levels (research: ~/ea-research/flow/reports/AGENT-MEMORY.md):
--   company       pulse.org_memory: facts about the company, shared by every AI employee (what one learned, a new
--                 colleague's assistant already knows). A fact is shared only when two different colleagues said it, or
--                 a leader or admin said it in a staff group, or a leader added it; until then it is a candidate that no
--                 run is given. Client conversations never feed it.
--   agent         agent_memory level 'agent': its own notes and rules (0906, 1840), unchanged.
--   person        agent_memory level 'person': per colleague. 'private' notes are what it learned in that person's own
--                 conversations with it; only that person sees them, and only runs in a direct chat with them get them
--                 (row security below enforces it, for every role). Notes managers write ("How Bevit works") stay shared.
--   conversation  agent_memory level 'conversation': what was said in one group (a client's "I prefer calls after 6"),
--                 given only to runs in that group and shown only to its members.
-- Every conversation it is in is captured as it happens (chat_message); each night pulse.agent_memory_nightly() runs
-- agent_memory_learn for every AI employee with the Memory tool. Typed rules read each colleague's sentences (no model):
-- first-person preferences, habits, work and "my X is Y" become notes about them; "we / our company …" statements in the
-- present tense become company candidates. New notes are merged like Mem0's ADD / UPDATE / NOOP: the same thing again
-- is reinforced (seen + 1), a new value for the same slot ("prefers: reports") replaces the old one (kept, retired as
-- 'replaced'), and learned notes fade when neither heard nor used for 45 days × times seen (at most 180). Secrets,
-- money, health and family details are never kept. People see, correct and forget what it remembers about them
-- (agent_memory_mine / _correct / _forget / _forget_me, and "what do you remember about me" / "forget everything about
-- me" in chat). Additive: existing notes keep their meaning (about someone → level 'person', shared).

-- 1. Levels, privacy and learning state on the notes ---------------------------------------------------------------------
alter table pulse.agent_memory add column level text not null default 'agent' check (level in ('agent', 'person', 'conversation'));
update pulse.agent_memory set level = 'person' where about_person_id is not null;
alter table pulse.agent_memory add column private boolean not null default false;
alter table pulse.agent_memory add constraint agent_memory_private_person check (not private or (level = 'person' and about_person_id is not null));
alter table pulse.agent_memory add constraint agent_memory_conversation_channel check (level <> 'conversation' or channel_id is not null);
alter table pulse.agent_memory add column slot text check (slot is null or length(slot) <= 120);
alter table pulse.agent_memory add column seen int not null default 1 check (seen >= 1);
alter table pulse.agent_memory add column last_seen_at timestamptz;
alter table pulse.agent_memory add column used_at timestamptz;
alter table pulse.agent_memory add column replaced_by uuid references pulse.agent_memory(id);
alter table pulse.agent_memory add column retired_why text
  check (retired_why is null or retired_why in ('removed', 'forgotten', 'replaced', 'faded', 'undone'));
alter table pulse.agent_memory drop constraint agent_memory_source_check;
alter table pulse.agent_memory add constraint agent_memory_source_check check (source in ('manager', 'agent', 'chat', 'learned'));
create index agent_memory_level on pulse.agent_memory (org_id, agent_id, level, about_person_id, channel_id) where retired_at is null;
-- Older writers (remember, a manager's note, 1840) say only whom a note is about: a note about someone is level 'person'.
create function pulse.agent_memory_level_fit() returns trigger language plpgsql set search_path = pulse, pg_temp as $$
begin
  if new.level = 'agent' and new.about_person_id is not null then new.level := 'person';
  elsif new.level = 'person' and new.about_person_id is null and not new.private then new.level := 'agent';
  end if;
  return new;
end $$;
create trigger agent_memory_level_fit before insert or update of about_person_id, level on pulse.agent_memory
  for each row execute function pulse.agent_memory_level_fit();
create index agent_memory_message on pulse.agent_memory (org_id, message_id) where message_id is not null;

-- A private note is read only by the person it is about, by the AI employee itself (its runtime), and by the nightly
-- pass (no viewer). Restrictive: it applies to every role, the SECURITY DEFINER functions' owner included, so a query that
-- forgets the rule still cannot show one person's private memory to another.
create policy private_to_person on pulse.agent_memory as restrictive
  using (not private or about_person_id = pulse.current_viewer() or agent_id = pulse.current_viewer() or pulse.current_viewer() is null)
  with check (not private or about_person_id = pulse.current_viewer() or agent_id = pulse.current_viewer() or pulse.current_viewer() is null);

-- The general notes every run gets are its own (level 'agent'): not a person's, not one conversation's.
do $$
declare f record; d text; c text; n int := 0;
begin
  for f in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'pulse' and p.prosrc like '%from agent_memory where agent_id = me and retired_at is null and about_person_id is null order by%' loop
    d := pg_get_functiondef(f.oid);
    c := replace(d, 'from agent_memory where agent_id = me and retired_at is null and about_person_id is null order by',
                    'from agent_memory where agent_id = me and retired_at is null and about_person_id is null and level = ''agent'' order by');
    if c <> d then execute c; n := n + 1; end if;
  end loop;
  if n = 0 then raise exception 'no dispatch function reads agent_memory as 1840 left it (AGENT-MEMORY 2090)'; end if;
end $$;

-- Learning: up to when it has read its conversations.
alter table pulse.agent_member add column memory_learned_until timestamptz;

-- 2. Company memory ------------------------------------------------------------------------------------------------------
create table pulse.org_memory (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  body text not null check (length(btrim(body)) between 3 and 600),
  words text[] not null default '{}',
  state text not null default 'candidate' check (state in ('candidate', 'shared')),
  source text not null check (source in ('learned', 'leader')),
  learned_by uuid references pulse.person(id),
  from_group boolean not null default false,
  people uuid[] not null default '{}',
  seen int not null default 1 check (seen >= 1),
  evidence jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references pulse.person(id),
  last_seen_at timestamptz not null default now(),
  used_at timestamptz,
  shared_at timestamptz,
  shared_by uuid references pulse.person(id),
  edited_at timestamptz,
  edited_by uuid references pulse.person(id),
  retired_at timestamptz,
  retired_by uuid references pulse.person(id),
  retired_why text check (retired_why is null or retired_why in ('removed', 'forgotten', 'faded'))
);
create index org_memory_live on pulse.org_memory (org_id, state, last_seen_at desc) where retired_at is null;
alter table pulse.org_memory enable row level security;
alter table pulse.org_memory force row level security;
create policy tenant on pulse.org_memory using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create trigger audit_mutation after insert or update or delete on pulse.org_memory for each row execute function pulse.audit_mutation();

-- Each learning pass: when, over which window, what it read and what changed (counts only).
create table pulse.agent_memory_pass (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references pulse.agent_member(person_id),
  reason text not null check (reason in ('nightly', 'on_demand')),
  started_by uuid references pulse.person(id),
  since timestamptz,
  until timestamptz not null,
  messages int not null default 0,
  conversations int not null default 0,
  people int not null default 0,
  added int not null default 0,
  reinforced int not null default 0,
  replaced int not null default 0,
  faded int not null default 0,
  shared int not null default 0,
  at timestamptz not null default now()
);
create index agent_memory_pass_recent on pulse.agent_memory_pass (org_id, agent_id, at desc);
alter table pulse.agent_memory_pass enable row level security;
alter table pulse.agent_memory_pass force row level security;
create policy tenant on pulse.agent_memory_pass using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

-- 3. Typed reading of a message (pure) ------------------------------------------------------------------------------------
create function pulse.mem_norm(p text) returns text language sql immutable set search_path = pulse, pg_temp as $$
  select btrim(regexp_replace(lower(coalesce(p, '')), '[^[:alnum:]]+', ' ', 'g'))
$$;
-- Content words (stop words out), sorted and distinct: what a note is about, for matching and slots.
create function pulse.mem_words(p text) returns text[] language sql immutable set search_path = pulse, pg_temp as $$
  select coalesce(array_agg(distinct w order by w), '{}') from unnest(regexp_split_to_array(mem_norm(p), ' ')) w
   where length(w) >= 2 and w <> all (array['the', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from',
     'is', 'are', 'was', 'be', 'been', 'am', 'it', 'its', 'this', 'that', 'these', 'those', 'we', 'our', 'us', 'me', 'my', 'you',
     'your', 'they', 'their', 'he', 'she', 'his', 'her', 'them', 'so', 'as', 'if', 'then', 'than', 'also', 'just', 'very', 'do',
     'does', 'did', 'have', 'has', 'had', 'will', 'would', 'should', 'can', 'could', 'all', 'any', 'every', 'each', 'some',
     'about', 'into', 'up', 'out', 'over', 'not', 'no', 'yes', 'please', 'pls', 'ok', 'okay', 'really', 'always', 'usually',
     'normally', 'generally', 'mostly', 'often', 'never', 'typically', 'prefer', 'prefers', 'like', 'likes', 'love', 'hate',
     'dislike'])
$$;
-- The first content word in reading order (a slot: what a note is about).
create function pulse.mem_lead(p text) returns text language sql immutable set search_path = pulse, pg_temp as $$
  select w from unnest(regexp_split_to_array(mem_norm(p), ' ')) with ordinality t(w, i) where cardinality(mem_words(w)) > 0 order by i limit 1
$$;
create function pulse.mem_overlap(a text[], b text[]) returns real language sql immutable set search_path = pulse, pg_temp as $$
  select case when cardinality(a) = 0 or cardinality(b) = 0 then 0::real
    else (select count(*) from (select unnest(a) intersect select unnest(b)) x)::real
       / (select count(*) from (select unnest(a) union select unnest(b)) y)::real end
$$;
-- Never kept: secrets, money and identity numbers, health, family, pay (and anything with a long number in it).
create function pulse.mem_sensitive(p text) returns boolean language sql immutable set search_path = pulse, pg_temp as $$
  select coalesce(p, '') ~* '(password|passcode|\motp\M|\mpin\M|cvv|login|credential|api key|token|secret|bank|account (no|number)|ifsc|upi|aadha?ar|\mpan\M|passport|salary|\mpay\M|payslip|ctc|loan|debt|health|medical|doctor|hospital|sick|illness|pregnan|therapy|diagnos|religio|caste|wife|husband|girlfriend|boyfriend|divorce|my (son|daughter|kid|kids|child|children|mother|father|mom|dad|parents|family)|home address|my address|phone number|mobile number)'
      or coalesce(p, '') ~ '[0-9][0-9 -]{5,}[0-9]'
$$;
-- What one message says that is worth keeping, sentence by sentence:
--   pref | habit | work | my | name   about the person who wrote it (first person: "I prefer …", "I usually …",
--                                    "I'm handling …", "my working hours are …", "call me …")
--   company                          about the company ("we / our office / the company …", present tense, ≥ 3 words)
-- Questions, standing instructions (kept live as rules, 1840), plans, one-offs and anything sensitive are left out.
create function pulse.mem_extract(p_body text) returns table (kind text, body text, slot text) language plpgsql immutable set search_path = pulse, pg_temp as $$
declare s text; m text[]; obj text; w text[]; verb text;
begin
  if p_body is null or length(p_body) > 2000 then return; end if;
  for s in select btrim(x) from regexp_split_to_table(p_body, '(?<=[.!;])\s+|\n+') x loop
    s := btrim(regexp_replace(s, '^(?:(?:ok|okay|also|btw|fyi|so|and|hi|hey|hello|just so you know|for your info)\M[\s,:-]*)+', '', 'i'));
    s := btrim(regexp_replace(s, '[.!;\s]+$', ''));
    continue when length(s) < 8 or length(s) > 300 or s ~ '\?' or mem_sensitive(s);
    -- standing instructions are rules (1840), kept live, not here
    continue when s ~* '^(always|never|from now on|going forward|henceforth|in future|whenever|every time|each time|make sure|don''?t|do not|please)\M';
    continue when s ~* '\m(every|each|all|any)\s+(quotations?|quotes?|estimates?|invoices?|bills?|tasks?|clients?|messages?|replies|proposals?|orders?)\M.*\m(should|must|shall|has to|have to|needs? to)\M';
    m := regexp_match(s, '^i\s+(?:really\s+|usually\s+|generally\s+|much\s+)?(prefer|like|love|hate|dislike)\s+(.{3,})$', 'i');
    if m is not null then
      obj := btrim(m[2]); w := mem_words(obj);
      continue when obj ~* '^(it|this|that|these|those|the idea|the plan|your|you)\M' or cardinality(w) = 0;
      verb := case lower(m[1]) when 'prefer' then 'Prefers' when 'hate' then 'Dislikes' when 'dislike' then 'Dislikes' else 'Likes' end;
      kind := 'pref'; body := verb || ' ' || obj; slot := 'pref:' || mem_lead(obj);
      return next; continue;
    end if;
    m := regexp_match(s, '^i\s+(usually|normally|generally|mostly|often|always|never|typically)\s+(.{3,})$', 'i');
    if m is not null then
      obj := btrim(m[2]); w := mem_words(obj);
      continue when cardinality(w) = 0;
      kind := 'habit'; body := initcap(m[1]) || ' ' || obj; slot := 'habit:' || mem_lead(obj);
      return next; continue;
    end if;
    m := regexp_match(s, '^(?:i''?m|i am)\s+(?:currently\s+|now\s+|also\s+)?(working on|handling|looking after|in charge of|responsible for|managing|leading|running)\s+(.{3,})$', 'i');
    if m is not null then
      obj := btrim(m[2]); w := mem_words(obj);
      continue when cardinality(w) = 0 or obj ~* '^(it|this|that)\M';
      verb := case lower(m[1]) when 'working on' then 'Works on' when 'handling' then 'Handles' when 'looking after' then 'Looks after'
        when 'in charge of' then 'In charge of' when 'responsible for' then 'Responsible for' when 'managing' then 'Manages'
        when 'leading' then 'Leads' else 'Runs' end;
      kind := 'work'; body := verb || ' ' || obj; slot := 'work:' || mem_norm(obj);
      return next; continue;
    end if;
    m := regexp_match(s, '^my\s+([a-z]+(?:\s+[a-z]+){0,3})\s+(?:is|are)\s+(.{2,})$', 'i');
    if m is not null then
      continue when cardinality(mem_words(m[2])) = 0 or m[1] ~* '^(name|day|mood|plan|problem|issue|question|point|bad|fault|mistake)$';
      kind := 'my'; body := upper(left(btrim(m[1]), 1)) || lower(substr(btrim(m[1]), 2)) || ': ' || btrim(m[2]); slot := 'my:' || mem_norm(m[1]);
      return next; continue;
    end if;
    m := regexp_match(s, '^(?:you can call me|please call me|call me|i go by)\s+([[:alpha:]][[:alpha:] .''-]{1,30})$', 'i');
    if m is not null then
      kind := 'name'; body := 'Likes to be called ' || btrim(m[1]); slot := 'name';
      return next; continue;
    end if;
    -- About the company, in the present tense: no plans, wishes, one-offs or the past.
    if s ~* '^(we|our (team|company|office|agency|firm|policy|process|rule|clients?|working hours|week)|the company|at (our office|work)|in our (company|team|office))\M'
       and array_to_string((regexp_split_to_array(s, '\s+'))[1:7], ' ')
           !~* '\m(will|would|should|could|might|may|can|cannot|can''t|need|needs|have to|has to|going|gonna|let''s|lets|did|didn''t|were|was|had|plan|planning|planned|think|thinking|consider|considering|hope|hoping|want|wanted|tried|trying|got|just|wish|maybe|probably)\M'
       and s !~* '^we''(ll|d|ve)' and cardinality(mem_words(s)) >= 3 then
      kind := 'company'; body := upper(left(s, 1)) || substr(s, 2) || '.'; slot := null;
      return next; continue;
    end if;
  end loop;
end $$;

-- 4. Keeping what it learned ----------------------------------------------------------------------------------------------
-- One learned note about a person (private or one conversation's): reinforce the same, replace a new value for the same
-- slot, else add. A note a person or manager already wrote with the same meaning is left alone. Returns the change.
create function pulse.mem_keep(p_agent uuid, p_level text, p_private boolean, p_about uuid, p_by uuid, p_channel uuid, p_message uuid,
    p_body text, p_slot text, p_at timestamptz) returns text language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o agent_memory; nid uuid; w text[] := mem_words(p_body);
begin
  if exists (select 1 from agent_memory a where a.agent_id = p_agent and a.org_id = current_org() and a.retired_at is null
              and a.source <> 'learned' and a.about_person_id is not distinct from p_about and mem_overlap(mem_words(a.body), w) >= 0.6) then
    return 'known'; end if;
  select * into o from agent_memory a where a.agent_id = p_agent and a.org_id = current_org() and a.retired_at is null and a.source = 'learned'
     and a.level = p_level and a.private = p_private and a.about_person_id is not distinct from p_about
     and (p_level <> 'conversation' or a.channel_id = p_channel)
     and (a.slot = p_slot or mem_overlap(mem_words(a.body), w) >= 0.6)
   order by (mem_norm(a.body) = mem_norm(p_body)) desc, a.last_seen_at desc nulls last limit 1;
  -- The same thing again (near word for word, or the same meaning under another slot) is reinforced; a new value for the
  -- same slot ("reports on WhatsApp" → "reports by email") replaces it below.
  if o.id is not null and (mem_norm(o.body) = mem_norm(p_body) or mem_overlap(mem_words(o.body), w) >= 0.8
                           or (o.slot is distinct from p_slot and mem_overlap(mem_words(o.body), w) >= 0.6)) then
    update agent_memory set seen = seen + 1, last_seen_at = greatest(coalesce(last_seen_at, p_at), p_at) where id = o.id;
    return 'reinforced';
  end if;
  if o.id is not null and o.slot is distinct from p_slot then o := null; end if;
  insert into agent_memory (org_id, agent_id, body, source, created_by, about_person_id, said_by, channel_id, message_id, level, private, slot, last_seen_at)
  values (current_org(), p_agent, left(p_body, 1000), 'learned', p_by, p_about, p_by, p_channel, p_message, p_level, p_private, p_slot, p_at)
  returning id into nid;
  if o.id is not null then
    update agent_memory set retired_at = now(), retired_why = 'replaced', replaced_by = nid where id = o.id;
    return 'replaced';
  end if;
  return 'added';
end $$;

-- A company statement heard from a colleague: the same fact again counts who said it; it is shared once two different
-- colleagues said it, or a leader or admin said it in a staff group. Returns the change.
create function pulse.org_mem_hear(p_agent uuid, p_body text, p_person uuid, p_channel uuid, p_message uuid, p_group boolean,
    p_leader boolean, p_at timestamptz) returns text language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o org_memory; w text[] := mem_words(p_body); ev jsonb := jsonb_build_object('channelId', p_channel, 'messageId', p_message, 'at', p_at);
  v_people uuid[]; go boolean;
begin
  select * into o from org_memory m where m.org_id = current_org() and m.retired_at is null and mem_overlap(m.words, w) >= 0.6
   order by mem_overlap(m.words, w) desc, m.last_seen_at desc limit 1;
  if o.id is null then
    go := p_leader and p_group;
    insert into org_memory (org_id, body, words, state, source, learned_by, from_group, people, evidence, created_by, last_seen_at, shared_at)
    values (current_org(), left(p_body, 600), w, case when go then 'shared' else 'candidate' end, 'learned', p_agent, p_group, array[p_person],
            jsonb_build_array(ev), p_person, p_at, case when go then now() end);
    return case when go then 'shared' else 'added' end;
  end if;
  if exists (select 1 from jsonb_array_elements(o.evidence) e where e->>'messageId' = p_message::text) then return 'known'; end if;
  v_people := case when p_person = any(o.people) then o.people else o.people || p_person end;
  go := o.state = 'candidate' and (cardinality(v_people) >= 2 or (p_leader and p_group));
  update org_memory set people = v_people, seen = seen + 1, last_seen_at = greatest(last_seen_at, p_at), from_group = from_group or p_group,
         evidence = (select coalesce(jsonb_agg(e order by (e->>'at') desc), '[]'::jsonb) from (select e from jsonb_array_elements(o.evidence || jsonb_build_array(ev)) e
                      order by (e->>'at') desc limit 10) x),
         state = case when go then 'shared' else state end, shared_at = case when go then now() else shared_at end
   where id = o.id;
  return case when go then 'shared' else 'reinforced' end;
end $$;

-- 5. The learning pass ----------------------------------------------------------------------------------------------------
-- Reads every message colleagues and clients wrote, since the last pass, in the conversations it is in (its own direct
-- chats and its groups), keeps what the typed rules find, then lets unused learned notes fade. The nightly loop runs it
-- with no viewer; its manager or an admin can run it now ("Learn now"). Counts only in the answer.
create function pulse.agent_memory_learn(p_agent uuid, p_reason text default 'on_demand') returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a agent_member; since timestamptz; v_until timestamptz := now(); r record; x record; op text; leader boolean;
  n jsonb := jsonb_build_object('messages', 0, 'added', 0, 'reinforced', 0, 'replaced', 0, 'faded', 0, 'shared', 0);
  chans uuid[] := '{}'; ppl uuid[] := '{}'; f int; k int; pid uuid; by_whom uuid := current_viewer();
begin
  if agent_session() is not null then raise exception 'An AI employee does not run its own learning' using errcode = '42501'; end if;
  if by_whom is not null and not agent_manage_ok(p_agent) then raise exception 'Its manager or an admin runs its learning' using errcode = '42501'; end if;
  if p_reason not in ('nightly', 'on_demand') then raise exception 'Say why it learns' using errcode = '22023'; end if;
  select * into a from agent_member where person_id = p_agent and org_id = current_org() for update;
  if not found then raise exception 'Not found' using errcode = 'P0002'; end if;
  -- The pass itself reads and writes everyone's notes (private ones too) and answers in counts only: it runs as the
  -- nightly job does, with no viewer, for the rest of this transaction's call, then the viewer is put back.
  perform set_config('pulse.viewer_id', '', true);
  since := coalesce(a.memory_learned_until, v_until - interval '30 days');
  for r in
    select m.id, m.channel_id, m.author_id, m.body, m.created_at, ch.kind ch_kind, chat_client_facing(ch.id) cf, p.side
      from chat_message m
      join chat_channel ch on ch.id = m.channel_id and ch.org_id = m.org_id
      join chat_member cm on cm.channel_id = m.channel_id and cm.person_id = p_agent
      join person p on p.id = m.author_id and p.org_id = m.org_id
     where m.org_id = current_org() and m.created_at > since and m.created_at <= v_until and m.removed_at is null
       and m.kind = 'text' and m.author_id <> p_agent and p.side <> 'agent' and p.status = 'active'
       and not exists (select 1 from agent_memory n where n.org_id = m.org_id and n.message_id = m.id)
       and not exists (select 1 from agent_rule ru where ru.org_id = m.org_id and ru.message_id = m.id)
     order by m.created_at
  loop
    n := jsonb_set(n, '{messages}', to_jsonb((n->>'messages')::int + 1));
    if not r.channel_id = any(chans) then chans := chans || r.channel_id; end if;
    if not r.author_id = any(ppl) then ppl := ppl || r.author_id; end if;
    for x in select * from mem_extract(r.body) loop
      op := null;
      if x.kind = 'company' then
        -- a client, or anything said where clients read, never becomes company memory
        continue when r.side <> 'staff' or r.cf;
        if r.ch_kind <> 'direct' then
          op := mem_keep(p_agent, 'conversation', false, null, r.author_id, r.channel_id, r.id, x.body, null, r.created_at);
        end if;
        leader := agent_rule_setter_ok(p_agent, r.author_id);
        op := coalesce(nullif(org_mem_hear(p_agent, x.body, r.author_id, r.channel_id, r.id, r.ch_kind <> 'direct', leader, r.created_at), 'known'), op);
      elsif r.ch_kind = 'direct' then
        continue when r.side <> 'staff';
        op := mem_keep(p_agent, 'person', true, r.author_id, r.author_id, r.channel_id, r.id, x.body, x.slot, r.created_at);
      else
        -- said in a group: that group's memory (a client's too), and a colleague's own private memory when no client reads it
        op := mem_keep(p_agent, 'conversation', false, r.author_id, r.author_id, r.channel_id, r.id, x.body, x.slot, r.created_at);
        if r.side = 'staff' and not r.cf then
          op := coalesce(nullif(mem_keep(p_agent, 'person', true, r.author_id, r.author_id, r.channel_id, r.id, x.body, x.slot, r.created_at), 'known'), op);
        end if;
      end if;
      if op in ('added', 'reinforced', 'replaced', 'shared') then n := jsonb_set(n, array[op], to_jsonb((n->>op)::int + 1)); end if;
    end loop;
  end loop;
  -- Fading: a learned note neither heard again nor used for 45 days per time it was heard (at most 180) is let go; a
  -- company candidate nobody repeated in 30 days too, and a shared learned company fact unused for 180 days.
  update agent_memory set retired_at = now(), retired_why = 'faded'
   where agent_id = p_agent and org_id = current_org() and source = 'learned' and retired_at is null
     and greatest(coalesce(last_seen_at, created_at), coalesce(used_at, created_at), coalesce(edited_at, created_at)) < v_until - make_interval(days => 45 * least(seen, 4));
  get diagnostics f = row_count;
  -- At most 40 learned notes per person: the least heard, oldest go first.
  for pid in select about_person_id from agent_memory where agent_id = p_agent and org_id = current_org() and source = 'learned' and retired_at is null
              and level = 'person' group by about_person_id having count(*) > 40 loop
    update agent_memory set retired_at = now(), retired_why = 'faded' where id in (
      select id from agent_memory where agent_id = p_agent and org_id = current_org() and source = 'learned' and retired_at is null and level = 'person'
         and about_person_id = pid order by seen desc, coalesce(last_seen_at, created_at) desc offset 40);
    get diagnostics k = row_count; f := f + k;
  end loop;
  update org_memory set retired_at = now(), retired_why = 'faded'
   where org_id = current_org() and retired_at is null and source = 'learned'
     and ((state = 'candidate' and last_seen_at < v_until - interval '30 days')
       or (state = 'shared' and greatest(last_seen_at, coalesce(used_at, last_seen_at), coalesce(edited_at, last_seen_at)) < v_until - interval '180 days'));
  n := jsonb_set(n, '{faded}', to_jsonb(f));
  update agent_member set memory_learned_until = v_until where person_id = p_agent;
  insert into agent_memory_pass (org_id, agent_id, reason, started_by, since, until, messages, conversations, people, added, reinforced, replaced, faded, shared)
  values (current_org(), p_agent, p_reason, by_whom, since, v_until, (n->>'messages')::int, cardinality(chans), cardinality(ppl),
          (n->>'added')::int, (n->>'reinforced')::int, (n->>'replaced')::int, f, (n->>'shared')::int);
  perform set_config('pulse.viewer_id', coalesce(by_whom::text, ''), true);
  return n || jsonb_build_object('conversations', cardinality(chans), 'people', cardinality(ppl), 'since', since, 'until', v_until);
end $$;

-- Every night from 3 a.m. company time, once a day: each AI employee that has the Memory tool learns from its day.
create function pulse.agent_memory_nightly() returns int language plpgsql security definer set search_path = pulse, pg_temp as $$
declare tz text := org_time_zone(); today date := (now() at time zone tz)::date; a uuid; k int := 0;
begin
  if current_org() is null or current_viewer() is not null or agent_session() is not null then return 0; end if;
  if extract(hour from now() at time zone tz) < 3 then return 0; end if;
  for a in select m.person_id from agent_member m join person p on p.id = m.person_id
            where m.org_id = current_org() and m.disabled_at is null and p.status = 'active' and 'memory' = any(m.tools)
              and not exists (select 1 from agent_memory_pass s where s.org_id = m.org_id and s.agent_id = m.person_id and s.reason = 'nightly'
                                and (s.at at time zone tz)::date = today)
            order by m.person_id loop
    perform agent_memory_learn(a, 'nightly'); k := k + 1;
  end loop;
  return k;
end $$;

-- 6. What a run is given --------------------------------------------------------------------------------------------------
-- For one run, decided by Pulse from the run's own message (never by the model): its rules; the notes managers wrote
-- about the person who wrote; that person's private notes only in a direct chat with them; this conversation's notes in
-- a group; and the company's shared facts, except where clients read. What it is given is marked used (fading).
create function pulse.agent_memory_for(p_run uuid) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); msg chat_message; direct boolean := false; cf boolean := false; who person; out jsonb;
  priv uuid[]; conv uuid[]; comp uuid[];
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  if not exists (select 1 from agent_run r where r.id = p_run and r.org_id = current_org() and r.agent_id = me and r.state = 'dispatching') then
    raise exception 'Do this inside the run' using errcode = '42501'; end if;
  msg := agent_run_message(p_run);
  if msg.id is not null then
    select (ch.kind = 'direct'), chat_client_facing(ch.id) into direct, cf from chat_channel ch where ch.id = msg.channel_id;
    select * into who from person where id = msg.author_id and org_id = current_org();
  end if;
  priv := case when direct and who.side = 'staff' then array(select id from agent_memory where agent_id = me and org_id = current_org() and retired_at is null
             and level = 'person' and private and about_person_id = who.id order by seen desc, coalesce(last_seen_at, created_at) desc limit 20) else '{}' end;
  conv := case when msg.id is not null and not direct then array(select id from agent_memory where agent_id = me and org_id = current_org() and retired_at is null
             and level = 'conversation' and channel_id = msg.channel_id order by seen desc, coalesce(last_seen_at, created_at) desc limit 20) else '{}' end;
  comp := case when not cf then array(select id from org_memory where org_id = current_org() and retired_at is null and state = 'shared'
             order by seen desc, last_seen_at desc limit 20) else '{}' end;
  out := jsonb_build_object(
    'rules', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'body', r.body, 'scope', r.scope, 'include', r.include_text, 'setBy', p.display_name,
        'setOn', to_char(r.set_at at time zone org_time_zone(), 'FMDD Mon')) order by r.set_at)
      from agent_rule r join person p on p.id = r.set_by where r.agent_id = me and r.org_id = current_org() and r.retired_at is null), '[]'::jsonb),
    'person', who.display_name,
    'about', coalesce((select jsonb_agg(x.body order by x.created_at desc) from (select body, created_at from agent_memory
      where agent_id = me and org_id = current_org() and level = 'person' and not private and about_person_id = who.id and retired_at is null
      order by created_at desc limit 20) x), '[]'::jsonb),
    'private', coalesce((select jsonb_agg(a.body order by array_position(priv, a.id)) from agent_memory a where a.id = any(priv)), '[]'::jsonb),
    'conversation', coalesce((select jsonb_agg(jsonb_build_object('who', p.display_name, 'body', a.body) order by array_position(conv, a.id))
      from agent_memory a left join person p on p.id = a.about_person_id where a.id = any(conv)), '[]'::jsonb),
    'company', coalesce((select jsonb_agg(o.body order by array_position(comp, o.id)) from org_memory o where o.id = any(comp)), '[]'::jsonb),
    'direct', direct, 'clientFacing', cf);
  update agent_memory set used_at = now() where id = any(priv || conv);
  update org_memory set used_at = now() where id = any(comp);
  return out;
end $$;

-- The older read (1840) keeps working for older runtimes, without anyone's private notes or one conversation's.
create or replace function pulse.agent_notes_for(p_person uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session();
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'rules', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'body', r.body, 'scope', r.scope, 'include', r.include_text, 'setBy', p.display_name,
        'setOn', to_char(r.set_at at time zone org_time_zone(), 'FMDD Mon')) order by r.set_at)
      from agent_rule r join person p on p.id = r.set_by where r.agent_id = me and r.org_id = current_org() and r.retired_at is null), '[]'::jsonb),
    'person', (select display_name from person where id = p_person and org_id = current_org()),
    'about', coalesce((select jsonb_agg(x.body order by x.created_at desc) from (select body, created_at from agent_memory
      where agent_id = me and org_id = current_org() and about_person_id = p_person and level = 'person' and not private and retired_at is null
      order by created_at desc limit 20) x), '[]'::jsonb));
end $$;

-- 7. See, correct and forget ----------------------------------------------------------------------------------------------
-- One person's view of what an AI employee remembers about them: private notes, the notes about them others can see,
-- and what it keeps from groups about them. Notes a manager wrote are shown but only that manager or an admin changes them.
create function pulse.mem_about(p_agent uuid, p_person uuid) returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'body', a.body, 'level', a.level, 'private', a.private, 'source', a.source,
      'seen', a.seen, 'at', a.created_at, 'lastSeenAt', a.last_seen_at, 'editedAt', a.edited_at,
      'by', case when a.source = 'manager' then w.display_name end, 'where', case when a.level = 'conversation' then ch.name end,
      'canChange', a.source <> 'manager') order by a.private desc, a.seen desc, a.created_at desc), '[]'::jsonb)
    from agent_memory a join person w on w.id = a.created_by left join chat_channel ch on ch.id = a.channel_id and a.level = 'conversation'
   where a.agent_id = p_agent and a.org_id = current_org() and a.about_person_id = p_person and a.retired_at is null
$$;

create function pulse.agent_memory_mine(p_agent uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if agent_session() is not null or current_viewer() is null or not exists (select 1 from agent_member where person_id = p_agent and org_id = current_org()) then
    raise exception 'Not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('items', mem_about(p_agent, current_viewer()));
end $$;

-- Correct one note about yourself (not one a manager wrote): the AI employee uses the corrected words from now on.
create function pulse.agent_memory_correct(p_id uuid, p_body text) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare b text := btrim(regexp_replace(coalesce(p_body, ''), '\s+', ' ', 'g')); a agent_memory;
begin
  if agent_session() is not null or current_viewer() is null then raise exception 'Not found' using errcode = 'P0002'; end if;
  if length(b) not between 3 and 1000 then raise exception 'Write it in 3 to 1,000 characters' using errcode = '22023'; end if;
  select * into a from agent_memory where id = p_id and org_id = current_org() and retired_at is null and about_person_id = current_viewer() and source <> 'manager';
  if not found then raise exception 'Not found' using errcode = 'P0002'; end if;
  update agent_memory set body = b, edited_at = now(), edited_by = current_viewer(), seen = greatest(seen, 2), last_seen_at = now() where id = p_id;
  return jsonb_build_object('id', p_id, 'body', b);
end $$;

-- Forget one note about yourself (not one a manager wrote).
create function pulse.agent_memory_forget(p_id uuid) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if agent_session() is not null or current_viewer() is null then raise exception 'Not found' using errcode = 'P0002'; end if;
  update agent_memory set retired_at = now(), retired_by = current_viewer(), retired_why = 'forgotten'
   where id = p_id and org_id = current_org() and retired_at is null and about_person_id = current_viewer() and source <> 'manager';
  if not found then raise exception 'Not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('forgotten', 1);
end $$;

-- Forget everything an AI employee remembers about one person (except notes a manager wrote), and take their words out
-- of company facts nobody else has confirmed yet. Used by the person (Knowledge tab) and by the runtime when the person
-- says "forget everything about me" (then p_person is the run's own message's author, decided by Pulse).
create function pulse.mem_forget_person(p_agent uuid, p_person uuid) returns int language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k int; c int;
begin
  update agent_memory set retired_at = now(), retired_by = p_person, retired_why = 'forgotten'
   where agent_id = p_agent and org_id = current_org() and about_person_id = p_person and retired_at is null and source <> 'manager';
  get diagnostics k = row_count;
  update org_memory set retired_at = now(), retired_by = p_person, retired_why = 'forgotten'
   where org_id = current_org() and retired_at is null and state = 'candidate' and people = array[p_person];
  get diagnostics c = row_count;
  update org_memory set people = array_remove(people, p_person) where org_id = current_org() and retired_at is null and state = 'candidate' and p_person = any(people);
  return k + c;
end $$;

create function pulse.agent_memory_forget_me(p_agent uuid) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if agent_session() is not null or current_viewer() is null or not exists (select 1 from agent_member where person_id = p_agent and org_id = current_org()) then
    raise exception 'Not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('forgotten', mem_forget_person(p_agent, current_viewer()));
end $$;

-- In chat: "what do you remember about me?" and "forget everything about me", for the person who wrote the run's message.
create function pulse.agent_recall_asker(p_run uuid) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); msg chat_message; who person; direct boolean;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  msg := agent_run_message(p_run);
  if msg.id is null then raise exception 'Only a chat message is answered this way' using errcode = '22023'; end if;
  select * into who from person where id = msg.author_id and org_id = current_org();
  if who.side is distinct from 'staff' or who.status <> 'active' then raise exception 'Only colleagues ask what I remember' using errcode = '42501'; end if;
  select kind = 'direct' into direct from chat_channel where id = msg.channel_id;
  -- Private notes are listed only in a direct chat with the person; in a group it says where to look instead.
  return jsonb_build_object('person', jsonb_build_object('id', who.id, 'name', who.display_name), 'direct', direct,
    'items', case when direct then (select coalesce(jsonb_agg(jsonb_build_object('body', e->>'body', 'private', (e->>'private')::boolean, 'by', e->>'by', 'where', e->>'where')), '[]'::jsonb)
                                   from jsonb_array_elements(mem_about(me, who.id)) e) else '[]'::jsonb end,
    'count', (select count(*) from agent_memory where agent_id = me and org_id = current_org() and about_person_id = who.id and retired_at is null));
end $$;

create function pulse.agent_forget_asker(p_run uuid) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); msg chat_message; who person; k int;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  msg := agent_run_message(p_run);
  if msg.id is null then raise exception 'Only a chat message is answered this way' using errcode = '22023'; end if;
  select * into who from person where id = msg.author_id and org_id = current_org();
  if who.side is distinct from 'staff' or who.status <> 'active' then raise exception 'Only colleagues ask me to forget them' using errcode = '42501'; end if;
  k := mem_forget_person(me, who.id);
  return jsonb_build_object('forgotten', k, 'person', who.display_name,
    'kept', (select count(*) from agent_memory where agent_id = me and org_id = current_org() and about_person_id = who.id and retired_at is null and source = 'manager'));
end $$;

-- A manager removes a note it can see (0906); never someone's private note (they forget their own).
create or replace function pulse.agent_memory_retire(p_id uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a uuid;
begin
  select agent_id into a from agent_memory where id = p_id and org_id = current_org() and retired_at is null and not private;
  if a is null or not agent_manage_ok(a) then raise exception 'Its manager or an admin removes a note' using errcode = '42501'; end if;
  update agent_memory set retired_at = now(), retired_by = current_viewer(), retired_why = 'removed' where id = p_id;
end $$;

-- 8. Company memory: leaders and admins add, edit, share a candidate heard in a group, or remove ---------------------------
-- p: {id?, body?, action: save | share | remove}
create function pulse.org_memory_save(p jsonb) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare b text := btrim(regexp_replace(coalesce(p->>'body', ''), '\s+', ' ', 'g')); act text := coalesce(nullif(p->>'action', ''), 'save');
  v_id uuid := case when nullif(p->>'id', '') ~ '^[0-9a-f-]{36}$' then (p->>'id')::uuid end; nid uuid;
begin
  if agent_session() is not null or not viewer_is('admin', 'leadership') then raise exception 'Leaders and admins change company memory' using errcode = '42501'; end if;
  if act not in ('save', 'share', 'remove') then raise exception 'Save, share or remove' using errcode = '22023'; end if;
  if act = 'save' and length(b) not between 3 and 600 then raise exception 'Write the fact in 3 to 600 characters' using errcode = '22023'; end if;
  if v_id is null then
    if act <> 'save' then raise exception 'Not found' using errcode = 'P0002'; end if;
    insert into org_memory (org_id, body, words, state, source, people, created_by, shared_at, shared_by)
    values (current_org(), b, mem_words(b), 'shared', 'leader', array[current_viewer()], current_viewer(), now(), current_viewer()) returning id into nid;
    return nid;
  end if;
  -- A candidate heard only in direct chats is nobody's to read until a second colleague says it.
  update org_memory set
      body = case when act = 'save' then b else body end, words = case when act = 'save' then mem_words(b) else words end,
      edited_at = case when act = 'save' then now() else edited_at end, edited_by = case when act = 'save' then current_viewer() else edited_by end,
      state = case when act in ('save', 'share') then 'shared' else state end,
      shared_at = case when act in ('save', 'share') and state = 'candidate' then now() else shared_at end,
      shared_by = case when act in ('save', 'share') and state = 'candidate' then current_viewer() else shared_by end,
      retired_at = case when act = 'remove' then now() end, retired_by = case when act = 'remove' then current_viewer() end,
      retired_why = case when act = 'remove' then 'removed' end
   where id = v_id and org_id = current_org() and retired_at is null and (state = 'shared' or from_group) returning id into nid;
  if nid is null then raise exception 'Not found' using errcode = 'P0002'; end if;
  return nid;
end $$;

-- 9. The Knowledge tab, with the new levels -------------------------------------------------------------------------------
-- Everyone on the staff: its rules, its shared notes, the conversation notes of groups they are in, what it remembers about
-- them (theirs only), the company's shared facts, and its last learning pass. Leaders and admins also see the company
-- candidates heard in groups (to share or remove) and how many wait for a second colleague.
create or replace function pulse.agent_knowledge(p_agent uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); lead boolean;
begin
  if agent_session() is not null or not exists (select 1 from agent_member where person_id = p_agent and org_id = current_org())
     or not exists (select 1 from person where id = me and org_id = current_org() and side = 'staff' and status = 'active') then
    raise exception 'Not found' using errcode = 'P0002'; end if;
  lead := viewer_is('admin', 'leadership');
  return jsonb_build_object(
    'canEdit', agent_manage_ok(p_agent), 'canRule', agent_rule_setter_ok(p_agent, me), 'canCompany', lead,
    'learns', exists (select 1 from agent_member where person_id = p_agent and 'memory' = any(tools)),
    'rules', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'body', r.body, 'scope', r.scope, 'include', r.include_text, 'source', r.source,
        'setBy', p.display_name, 'setAt', r.set_at, 'editedAt', r.edited_at) order by r.set_at desc)
      from agent_rule r join person p on p.id = r.set_by where r.agent_id = p_agent and r.org_id = current_org() and r.retired_at is null), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'body', a.body, 'source', a.source, 'at', a.created_at, 'by', p.display_name,
        'aboutId', a.about_person_id, 'about', ab.display_name, 'topic', a.topic, 'taskId', a.task_id, 'editedAt', a.edited_at) order by a.created_at desc)
      from agent_memory a join person p on p.id = a.created_by left join person ab on ab.id = a.about_person_id
      where a.agent_id = p_agent and a.org_id = current_org() and a.retired_at is null and a.level in ('agent', 'person') and not a.private), '[]'::jsonb),
    'mine', mem_about(p_agent, me),
    'conversations', coalesce((select jsonb_agg(jsonb_build_object('channelId', c.id, 'name', c.name, 'items', c.items) order by c.name)
      from (select ch.id, ch.name, jsonb_agg(jsonb_build_object('id', a.id, 'body', a.body, 'who', ab.display_name, 'seen', a.seen, 'at', a.created_at)
                                             order by a.seen desc, a.created_at desc) items
              from agent_memory a join chat_channel ch on ch.id = a.channel_id left join person ab on ab.id = a.about_person_id
             where a.agent_id = p_agent and a.org_id = current_org() and a.retired_at is null and a.level = 'conversation'
               and exists (select 1 from chat_member cm where cm.channel_id = ch.id and cm.person_id = me)
             group by ch.id, ch.name) c), '[]'::jsonb),
    'company', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'body', o.body, 'state', o.state, 'source', o.source, 'people', cardinality(o.people),
        'seen', o.seen, 'at', coalesce(o.shared_at, o.created_at), 'by', case when o.source = 'leader' then cb.display_name end) order by o.state desc, o.seen desc, o.created_at desc)
      from org_memory o left join person cb on cb.id = o.created_by
      where o.org_id = current_org() and o.retired_at is null and (o.state = 'shared' or (lead and o.from_group))), '[]'::jsonb),
    'waiting', case when lead then (select count(*) from org_memory where org_id = current_org() and retired_at is null and state = 'candidate' and not from_group) end,
    'lastPass', (select jsonb_build_object('at', s.at, 'reason', s.reason, 'messages', s.messages, 'conversations', s.conversations, 'people', s.people,
        'added', s.added, 'reinforced', s.reinforced, 'replaced', s.replaced, 'faded', s.faded, 'shared', s.shared)
      from agent_memory_pass s where s.agent_id = p_agent and s.org_id = current_org() order by s.at desc limit 1),
    -- Nights in a row it learned (its nightly passes, ending last night or today).
    'streak', (with d as (select distinct (s.at at time zone org_time_zone())::date dd from agent_memory_pass s
                           where s.agent_id = p_agent and s.org_id = current_org() and s.reason = 'nightly' and s.at > now() - interval '120 days'),
                    g as (select dd, dd - (row_number() over (order by dd))::int k from d)
               select count(*) from g where k = (select k from g order by dd desc limit 1)
                 and (select max(dd) from d) >= (now() at time zone org_time_zone())::date - 1),
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name) order by p.display_name)
      from person p where p.org_id = current_org() and p.side = 'staff' and p.status = 'active'), '[]'::jsonb));
end $$;

revoke all on function pulse.agent_memory_level_fit(), pulse.mem_norm(text), pulse.mem_lead(text), pulse.mem_words(text), pulse.mem_overlap(text[], text[]), pulse.mem_sensitive(text), pulse.mem_extract(text),
  pulse.mem_keep(uuid, text, boolean, uuid, uuid, uuid, uuid, text, text, timestamptz),
  pulse.org_mem_hear(uuid, text, uuid, uuid, uuid, boolean, boolean, timestamptz), pulse.agent_memory_learn(uuid, text), pulse.agent_memory_nightly(),
  pulse.agent_memory_for(uuid), pulse.mem_about(uuid, uuid), pulse.agent_memory_mine(uuid), pulse.agent_memory_correct(uuid, text),
  pulse.agent_memory_forget(uuid), pulse.mem_forget_person(uuid, uuid), pulse.agent_memory_forget_me(uuid), pulse.agent_recall_asker(uuid),
  pulse.agent_forget_asker(uuid), pulse.org_memory_save(jsonb) from public;
grant execute on function pulse.mem_extract(text), pulse.agent_memory_learn(uuid, text), pulse.agent_memory_nightly(), pulse.agent_memory_for(uuid),
  pulse.agent_memory_mine(uuid), pulse.agent_memory_correct(uuid, text), pulse.agent_memory_forget(uuid), pulse.agent_memory_forget_me(uuid),
  pulse.agent_recall_asker(uuid), pulse.agent_forget_asker(uuid), pulse.org_memory_save(jsonb) to pulse_api;

-- migrate:down
-- Forward only: what people asked it to forget stays retired, and the learning passes stay auditable.

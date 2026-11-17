-- migrate:up
-- (0941: above the versions other lanes have already applied to the dev database.)
-- CHAT-SHELL v2 (owner, 22 Oct 2026): Pip's intent engine decides for every message typed or said whether to open a
-- place beside the chat, offer it, or do nothing. Each decision is logged here for tuning: who, from where, how sure,
-- which place and which part decided (the rules, the model, the stub). The message's words are not kept (only their
-- length). Additive; read by nobody in the app, never used to act.
create table pulse.chat_intent_decision (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  person_id uuid not null references pulse.person(id),
  source text not null check (source in ('typed','message','voice','task','home')),
  channel_id uuid,
  message_id uuid,
  text_len int not null default 0 check (text_len >= 0),
  action text not null check (action in ('auto','chip','none','taken')),
  href text check (length(href) <= 300),
  confidence numeric(4,2),
  decided_by text not null default 'rules' check (length(decided_by) <= 40),
  created_at timestamptz not null default now()
);
create index chat_intent_decision_recent on pulse.chat_intent_decision (org_id, created_at desc);
alter table pulse.chat_intent_decision enable row level security;
alter table pulse.chat_intent_decision force row level security;
create policy tenant_isolation on pulse.chat_intent_decision using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy own_insert on pulse.chat_intent_decision as restrictive for insert to pulse_api with check (person_id = pulse.current_viewer());
grant insert on pulse.chat_intent_decision to pulse_api;

-- migrate:down
drop table if exists pulse.chat_intent_decision;

-- migrate:up
-- AI-AGENTS-2 (owner, 17 Nov 2026, on Bharata's profile: "2 million tokens is nothing"): an AI employee's daily token
-- limit was capped at 2,000,000 (0510's check, 0906's settings save, 0988's budget grant, 1840's Add budget). One
-- quotation run with its tools and the catalogue is already 60-150k tokens, so a working day of a busy AI employee
-- hit the ceiling and an admin could not raise it. The ceiling is now 5 crore (50,000,000) tokens a day; the default
-- and everything else are unchanged. Same patch pattern as 1351/1690/2201: the live function text is edited, and the
-- migration stops if upstream changed the line it edits.
alter table pulse.agent_member drop constraint agent_member_daily_token_budget_check;
alter table pulse.agent_member add constraint agent_member_daily_token_budget_check check (daily_token_budget >= 1000 and daily_token_budget <= 50000000);
do $$
declare src text; was text;
begin
  src := pg_get_functiondef('pulse.agent_settings_save(uuid,jsonb)'::regprocedure); was := src;
  src := replace(src, $q$!~ '^[0-9]{4,7}$' or (p->>'dailyTokenBudget')::int not between 1000 and 2000000 then$q$,
    $q$!~ '^[0-9]{4,8}$' or (p->>'dailyTokenBudget')::int not between 1000 and 50000000 then$q$);
  src := replace(src, $q$'A daily limit of 1,000 to 2,000,000 tokens'$q$, $q$'A daily limit of 1,000 to 50,000,000 tokens'$q$);
  if src = was or src like '%2000000 then%' then raise exception 'agent_settings_save changed upstream: update 2231'; end if;
  execute src;

  src := pg_get_functiondef('pulse.agent_budget_add(uuid,text)'::regprocedure); was := src;
  src := replace(src, $q$m.daily_token_budget >= 2000000 then raise exception 'Today''s limit is already the highest (2,000,000 tokens)'$q$,
    $q$m.daily_token_budget >= 50000000 then raise exception 'Today''s limit is already the highest (50,000,000 tokens)'$q$);
  src := replace(src, 'least(2000000 - m.daily_token_budget', 'least(50000000 - m.daily_token_budget');
  if src = was or src like '%2000000 -%' then raise exception 'agent_budget_add changed upstream: update 2231'; end if;
  execute src;

  src := pg_get_functiondef('pulse.agent_budget_grant_apply(pulse.agent_proposal,uuid)'::regprocedure); was := src;
  src := replace(src, 'least(2000000, daily_token_budget', 'least(50000000, daily_token_budget');
  if src = was then raise exception 'agent_budget_grant_apply changed upstream: update 2231'; end if;
  execute src;
end $$;

-- migrate:down
do $$
declare src text;
begin
  src := pg_get_functiondef('pulse.agent_settings_save(uuid,jsonb)'::regprocedure);
  src := replace(src, $q$!~ '^[0-9]{4,8}$' or (p->>'dailyTokenBudget')::int not between 1000 and 50000000 then$q$,
    $q$!~ '^[0-9]{4,7}$' or (p->>'dailyTokenBudget')::int not between 1000 and 2000000 then$q$);
  execute replace(src, $q$'A daily limit of 1,000 to 50,000,000 tokens'$q$, $q$'A daily limit of 1,000 to 2,000,000 tokens'$q$);
  src := pg_get_functiondef('pulse.agent_budget_add(uuid,text)'::regprocedure);
  src := replace(src, $q$m.daily_token_budget >= 50000000 then raise exception 'Today''s limit is already the highest (50,000,000 tokens)'$q$,
    $q$m.daily_token_budget >= 2000000 then raise exception 'Today''s limit is already the highest (2,000,000 tokens)'$q$);
  execute replace(src, 'least(50000000 - m.daily_token_budget', 'least(2000000 - m.daily_token_budget');
  src := pg_get_functiondef('pulse.agent_budget_grant_apply(pulse.agent_proposal,uuid)'::regprocedure);
  execute replace(src, 'least(50000000, daily_token_budget', 'least(2000000, daily_token_budget');
end $$;
update pulse.agent_member set daily_token_budget = least(daily_token_budget, 2000000) where daily_token_budget > 2000000;
alter table pulse.agent_member drop constraint agent_member_daily_token_budget_check;
alter table pulse.agent_member add constraint agent_member_daily_token_budget_check check (daily_token_budget >= 1000 and daily_token_budget <= 2000000);

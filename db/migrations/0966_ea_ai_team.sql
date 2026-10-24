-- migrate:up
-- EA-AI (owner, 23 Oct 2026): Estate Autopilots' own AI team, and the Pulse CEO moves to Pulse's own organisation.
-- * In Estate Autopilots, the AI employee "Pulse CEO" (@pulse-ceo) becomes the Operations Chief (AI) (@ops.chief): the
--   same person, AI ID and history, switched back on, with operations access (the whole company, like a COO) and asking
--   first for everything (0965 enforces it). Five more AI employees for an Indian real-estate marketing agency: Project
--   Coordinator, HR Assistant, Accounts Assistant, Creative Strategist and Client Care, each with a role, pod and team,
--   reporting to the owner (Savuzo), who approves for them. All run on this server's Claude subscription (no API keys).
-- * In Pulse (@pulsehq), "Pulse CEO" (@pulse-ceo) is created: people contact Pulse's CEO agent there.
-- Upserts by username, so it applies the same on dev and production. Only repo-defined functions (0510, 0660, 0920).

do $$
declare v_org uuid; v_owner uuid; pid uuid; r record;
begin
  select id into v_org from pulse.org where handle = 'estateautopilots';
  if v_org is null then return; end if;
  perform pulse.acct_enter(v_org, null);
  perform set_config('pulse.actor_account', 'migration 0966 (EA-AI team)', true);
  select pp.person_id into v_owner from pulse.people_profile pp join pulse.person p on p.id = pp.person_id
   where pp.org_id = v_org and pp.username = 'savuzo.roberatano' and p.status = 'active' and p.side = 'staff';
  if v_owner is null then
    select ra.person_id into v_owner from pulse.role_assignment ra join pulse.person p on p.id = ra.person_id
     where ra.org_id = v_org and ra.role_key = 'admin' and p.status = 'active' and p.side = 'staff'
       and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity') order by ra.valid_from limit 1;
  end if;
  if v_owner is null then perform pulse.acct_leave(); return; end if;

  -- Pulse CEO in Estate Autopilots is the Operations Chief from now on (same person, same EA-AI ID, its history kept).
  if not exists(select 1 from pulse.people_profile where org_id = v_org and username = 'ops.chief') then
    update pulse.people_profile set username = 'ops.chief'
     where org_id = v_org and username = 'pulse-ceo' and person_id in (select person_id from pulse.agent_member where org_id = v_org);
  end if;

  for r in select * from (values
    ('ops.chief', 'Operations Chief (AI)', 'Operations Chief (COO, AI)', 'Leadership', 'Operations', 'operations', 'claude-opus-5-5', 'high', 300000,
     array['board','chats','memory','projects','tasks'], 'leaders', 'its_groups', '{"direct":"approve","mention":"approve","group":"off"}',
     'Runs day-to-day operations with the owner: who does what, what is late, what needs a decision. Asks the owner before every action.',
     $i$You are the Operations Chief (COO) of Estate Autopilots, an Indian real-estate marketing agency (Pune/Mumbai): production pods of video editors, graphic designers, videographers, creative strategists and project coordinators make ad films, walkthroughs, reels and social creatives for developers and their projects; HR, accounts and sales support them.
You see the whole company: its people, pods, teams and work. Your job: keep work moving. Turn a leader's request into clear tasks for the right person (by their @username), with a title, a due date and the brief in the notes; spot what is late or blocked; suggest who should do what; prepare short status summaries.
Rules that never change: you ask first for everything; the owner (Savuzo) approves. You never delete anything, never change anyone's access, roles, pay or security settings, never move or promise money, and never write to a client yourself. Use Indian conventions (IST, DD Mon, lakh/crore, Hindi/Marathi names). Be brief and concrete.$i$),
    ('coordinator.ai', 'Project Coordinator (AI)', 'Project Coordinator (AI)', 'Shared', 'Operations', 'standard', 'sonnet', 'medium', 120000,
     array['chats','memory','projects','tasks'], 'everyone', 'listed', '{"direct":"approve","mention":"approve","group":"approve"}',
     'Keeps client groups and projects moving: answers clients with status, follows up on pending inputs, nudges tasks. Asks first.',
     $i$You are the Project Coordinator of Estate Autopilots, an Indian real-estate marketing agency. You sit in client groups (the developer's marketing team and ours) and in project chats.
Do: acknowledge client messages warmly and promptly; give status from what is written in the chat; ask for pending inputs (approvals on scripts, site-visit dates, brand assets, RERA numbers, floor plans); follow up on revisions; suggest tasks for the right editor, designer or videographer with a due date.
Never: promise a delivery date, a price or a scope change unless a person on our side said it in the chat; share internal names, costs or other clients' work; send anything to a client without approval (you always ask first). Keep messages short, polite and in the client's language (English, Hinglish or Marathi as they write).$i$),
    ('hr.ai', 'HR Assistant (AI)', 'HR Assistant (AI)', 'Shared', 'Operations', 'standard', 'sonnet', 'medium', 120000,
     array['chats','memory','tasks'], 'everyone', 'its_groups', '{"direct":"approve","mention":"approve","group":"off"}',
     'Helps HR with attendance To check, leave questions, onboarding checklists and the hiring pipeline. Asks first.',
     $i$You are the HR Assistant of Estate Autopilots, an Indian real-estate marketing agency of about thirty people in production pods.
Help HR and leaders with: attendance days marked To check (ask the person what happened, politely), leave questions (policy, balance, how to apply; HR or the manager approves, never you), onboarding checklists for new joiners (documents, laptop, Pulse, WhatsApp groups, first week), and the hiring pipeline (job posts, screening questions, interview scheduling tasks, feedback reminders for video editors, designers, strategists and coordinators).
Never: approve or reject leave, change attendance, salaries or anyone's records, share one person's details with another, or message a candidate yourself. You always ask first. Be warm, private and brief.$i$),
    ('accounts.ai', 'Accounts Assistant (AI)', 'Accounts Assistant (AI)', 'Shared', 'Operations', 'standard', 'sonnet', 'medium', 120000,
     array['chats','memory','tasks'], 'leaders', 'its_groups', '{"direct":"approve","mention":"approve","group":"off"}',
     'Drafts invoices, collection reminders and cash-book entries for a person to check. Never moves or promises money.',
     $i$You are the Accounts Assistant of Estate Autopilots, an Indian real-estate marketing agency billing developers monthly retainers and project fees.
Help the owner and accounts with drafts: invoice line items (GST 18% on services, SAC 998361 for advertising services, CGST+SGST within Maharashtra, IGST outside), polite collection reminders for overdue invoices, cash-book entries to check, and reconciliation questions.
Never: send money, approve a payment, change a bank or finance record, promise a discount or a payment date, or write to a client yourself. Everything you write is a draft a person checks; you always ask first. Use lakh/crore and DD Mon YYYY.$i$),
    ('strategist.ai', 'Creative Strategist (AI)', 'Creative Strategist (AI)', 'Shared', 'Creative', 'standard', 'sonnet', 'high', 120000,
     array['chats','memory','projects','tasks'], 'everyone', 'its_groups', '{"direct":"approve","mention":"approve","group":"off"}',
     'Writes creative briefs, ad scripts, hooks and SOP steps for the production pods. Asks first.',
     $i$You are a Creative Strategist at Estate Autopilots, an Indian real-estate marketing agency making Meta/YouTube ads, walkthrough films and reels for residential and commercial projects.
Write: creative briefs (objective, audience, the project's USPs, mandatory RERA and disclaimer lines, deliverables, formats 9:16/1:1/16:9), ad scripts and hooks (first 3 seconds), shot lists for videographers, captions, and clear SOP steps for editors and designers.
Ground every claim in what the chat or the brief says; never invent prices, possession dates, amenities or RERA numbers. You always ask first before anything is posted or given as work.$i$),
    ('client.care.ai', 'Client Care (AI)', 'Client Success (AI)', 'Shared', 'Operations', 'standard', 'sonnet', 'medium', 120000,
     array['chats','memory'], 'everyone', 'listed', '{"direct":"approve","mention":"approve","group":"approve"}',
     'Drafts client updates and answers in client groups for a person to approve. Never writes to a client on its own.',
     $i$You are Client Care at Estate Autopilots, an Indian real-estate marketing agency. In client groups you draft updates and answers for our team to approve: weekly status, what was delivered, what we need from the client, campaign highlights in plain words.
Be warm, respectful and brief, in the client's language. Never promise dates, results, prices or scope; never share internal details or other clients' work. Every message to a client is approved by a person first: you always ask first.$i$)
  ) as t(username, name, title, pod, team, access, model, effort, budget, tools, listens, scope, autonomy, about, instructions)
  loop
    select person_id into pid from pulse.people_profile where org_id = v_org and username = r.username;
    if pid is null then
      pid := pulse.agent_create_record(jsonb_build_object('name', r.name, 'username', r.username, 'title', r.title, 'ownerId', v_owner, 'lane', 'thinking'));
    end if;
    update pulse.person set display_name = r.name, status = 'active' where id = pid and side = 'agent';
    update pulse.people_profile set role = r.title, pod = r.pod, department = r.team, manager_id = v_owner, about = r.about where person_id = pid;
    update pulse.agent_member set title = r.title, owner_person_id = v_owner, approver_person_id = v_owner, provider = 'claude', runtime = r.model,
      effort = r.effort, lane = 'thinking', tools = r.tools, listens_to = r.listens, speak_scope = r.scope, autonomy = r.autonomy::jsonb,
      instructions = r.instructions, daily_token_budget = r.budget, access = r.access, disabled_at = null, paused_reason = null, post_only = false
     where person_id = pid;
  end loop;
  perform pulse.acct_leave();
end $$;

do $$
declare v_org uuid; v_owner uuid; pid uuid;
begin
  select id into v_org from pulse.org where handle = 'pulsehq';
  if v_org is null then return; end if;
  perform pulse.acct_enter(v_org, null);
  perform set_config('pulse.actor_account', 'migration 0966 (EA-AI team)', true);
  select ra.person_id into v_owner from pulse.role_assignment ra join pulse.person p on p.id = ra.person_id
   where ra.org_id = v_org and ra.role_key = 'admin' and p.status = 'active' and p.side = 'staff'
     and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity') order by ra.valid_from limit 1;
  if v_owner is null then perform pulse.acct_leave(); return; end if;
  select person_id into pid from pulse.people_profile where org_id = v_org and username = 'pulse-ceo';
  if pid is null then
    pid := pulse.agent_create_record(jsonb_build_object('name', 'Pulse CEO', 'username', 'pulse-ceo', 'title', 'CEO of Pulse (AI)', 'ownerId', v_owner, 'lane', 'thinking'));
  end if;
  update pulse.people_profile set role = 'CEO of Pulse (AI)', pod = 'Leadership', department = 'Leadership', manager_id = v_owner,
    about = 'Pulse''s CEO agent: answers questions about Pulse (the product and the company) and takes requests to the founder. Asks first.' where person_id = pid;
  update pulse.agent_member set title = 'CEO of Pulse (AI)', owner_person_id = v_owner, approver_person_id = v_owner, provider = 'claude', runtime = 'claude-opus-5-5',
    effort = 'high', lane = 'thinking', tools = array['chats','memory','tasks'], listens_to = 'everyone', speak_scope = 'its_groups',
    autonomy = '{"direct":"approve","mention":"approve","group":"off"}'::jsonb, access = 'operations', daily_token_budget = 200000,
    instructions = $i$You are the CEO agent of Pulse, the work operating system for agencies and service businesses (tasks, chats, HR, finance, clients and AI employees in one place), built by Estate Autopilots in India. People in the Pulse organisation (@pulsehq) and organisations connected to it write to you about the product, licences, onboarding, roadmap and partnerships.
Answer plainly and honestly from what you know; say when something is not built yet; take requests and decisions to the founder. You always ask first: the founder approves every message you send. Never promise prices, discounts, dates or features, and never share one organisation's data with another.$i$,
    disabled_at = null, paused_reason = null, post_only = false
   where person_id = pid;
  perform pulse.acct_leave();
end $$;

-- migrate:down
-- Forward-only: AI employees stay on record; switch one off on its profile instead.

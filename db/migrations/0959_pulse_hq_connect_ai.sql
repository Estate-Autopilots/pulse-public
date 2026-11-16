-- migrate:up
-- CONNECT-AI (owner, 23 Oct 2026): the Pulse HQ feature catalogue (0944/0945, links 0948) gains what shipped today and
-- says what changed: Connect AI (subscriptions, API keys, agent workspaces), AI employees v2 (one profile card, the AI
-- tab, ask-first proposals), client connections (client requests, cross-organisation groups and tasks, referrals) and
-- the licence register. Upserted by key in the Pulse organisation only; new entries are drafts until the founder reviews
-- them, entries that exist keep their draft flag, sort and creator. Plain SQL over the catalogue table: no function from
-- outside the repository's migrations is called. Safe on a live install: where the Pulse organisation does not exist,
-- nothing happens.
do $$
declare v_org uuid;
begin
  select id into v_org from pulse.org where handle = 'pulsehq';
  if v_org is null then return; end if;
  perform set_config('pulse.org_id', v_org::text, true);
  insert into pulse.hq_feature as f (org_id, key, category, name, promise, what, who, status, icon, proof, screenshot, sort, draft, href)
  select v_org, x.key, x.category, x.name, x.promise, x.what, x.who, x.status, x.icon, x.proof, x.shot, x.sort, true, x.href from (values
    ('connect-ai', 'admin', 'Connect AI: subscriptions', 'Run your AI employees on the Claude or ChatGPT plan you already pay for',
     'Settings → AI: sign in once with Claude (Pro, Max or Team, through Claude Code''s own long-lived sign-in) or ChatGPT (Codex device code shown in Pulse). Each connection shows who it is signed in as, connected / out of quota until / signed out, a Test button and Disconnect. The token is encrypted at rest and never shown again. Gemini CLI and Antigravity are listed honestly as not available for servers yet.',
     'Admins & leadership', 'beta', 'Sparkles', '/settings?tab=ai, connect-ai.ts, 0958_connect_ai.sql', '/home/eadev/ea-research/ux/journeys/CONNECT-AI/shots/02-connect-claude-1440-light.png', 30, '/settings?tab=ai'),
    ('ai-api-keys', 'admin', 'Connect AI: API keys of any provider', 'Bring a key from Anthropic, OpenAI, Gemini, OpenRouter, Groq, Mistral, DeepSeek or your own model',
     'Add an API key for any provider, or any OpenAI-compatible address (vLLM, Ollama, LiteLLM). Pulse lists the models the key can use and sends one tiny test before keeping it, encrypted and shown only as its last four characters. An optional monthly token limit per key; usage this month on every card. Organisations that run on subscriptions only keep paid keys switched off.',
     'Admins & leadership', 'beta', 'KeyRound', '/settings?tab=ai, ai-providers.ts, services/coworker/providers.mjs', '/home/eadev/ea-research/ux/journeys/CONNECT-AI/shots/05-key-connected-1440-light.png', 31, '/settings?tab=ai'),
    ('agent-workspaces', 'admin', 'Agent workspaces', 'Let your AI employees run on your own server',
     'Add a VPS over SSH: Pulse makes a key and shows the one command to authorise it (or takes your deploy key), checks the server (system, CPUs, memory, disk, Docker, Node, Python, Claude Code, Codex) and pins its host key. The Pulse cloud workspace is the default. Private keys are encrypted at rest and never shown.',
     'Admins & leadership', 'beta', 'Server', '/settings?tab=ai, sshRun in connect-ai.ts and runtime.mjs', '/home/eadev/ea-research/ux/journeys/CONNECT-AI/shots/08-workspace-healthy-1440-light.png', 32, '/settings?tab=ai'),
    ('ai-employees', 'chats', 'AI employees', 'AI team members on the same profile as everyone, asking a person before they speak',
     'An AI employee has the same profile card as a person (role, pod, reports to, projects) plus an AI tab: the AI it uses (a connected subscription or API key), model, Fast to Deep thinking, where it runs, tools, training and daily limit. For each kind of message it replies on its own, asks first or stays out; asking first, it DMs its approver with Send it / Edit / Don''t and posts only after a yes.',
     'Owners & leadership', 'live', 'Bot', '/people/[id]?tab=ai, agents.ts, services/coworker, 0952', '/home/eadev/ea-research/ux/journeys/CONNECT-AI/shots/10-ai-tab-1440-light.png', 6, '/people'),
    ('ai-ask-first', 'chats', 'Ask-first proposals', 'An AI drafts the reply; a person approves it with one tap',
     'When an AI employee is set to ask first, it never posts in the group by itself: its approver gets a direct message with the client''s message, the proposed reply and why, on a card with Send it, Edit and Don''t (or a reply like "fine, send it"). Every proposal keeps who decided, how and when, on the AI''s profile.',
     'Owners & leadership', 'live', 'MessageSquareShare', 'agent_proposal (0952), chats/conversation.tsx ProposalCard', '/home/eadev/ea-research/ux/journeys/AI-EMP/shots/08-dm-proposal.png', 7, '/chats'),
    ('client-connections', 'clients', 'Client connections', 'Invite a client into a shared space with your team',
     'Connections → Invite a client: a private link, QR code and e-mail text with everything pre-filled. The client sets up their own Pulse, uses one they run, or joins as an individual. Each side''s point of contact gets a seat in the other organisation; only what you share crosses over.',
     'Owners, leadership & HR', 'beta', 'Handshake', '/connections, connect.ts, 0953_connect_clients.sql', null, 20, '/connections'),
    ('cross-org-groups', 'clients', 'Groups and tasks across organisations', 'Chat and give tasks to a client''s team as easily as your own',
     'A group with another organisation is an ordinary Pulse group (replies, files, voice, tasks from messages); the other side finds it in their own Chats under With other organisations. Give a task to their contact, or they give one to yours; both see its state on Connections and in Work.',
     'Everyone working with clients', 'beta', 'Users', '/connections, pulse_priv.connect_share (0953)', null, 21, '/connections'),
    ('referrals', 'network', 'Referrals', 'Every client you bring onto Pulse is credited to you',
     'When a client accepts your invitation, Pulse records the referral: who referred them, and whether a new organisation or a new account was opened, next to the connection.',
     'Owners & the Pulse team', 'beta', 'Share2', 'pulse_priv.org_referral (0953)', null, 5, '/connections'),
    ('licences-register', 'network', 'Licences register', 'Every Pulse install and hosted company in one register',
     'Pulse HQ keeps the licence of every organisation: hosted or self-hosted, address, plan, seats, status, issue and renewal dates, and how many people each hosted organisation has today. The Pulse organisation holds it; Estate Autopilots is the founding customer.',
     'The Pulse team', 'live', 'BadgeCheck', '/hq (Licences), 0943, 0946, 0949', null, 4, '/hq')
  ) as x(key, category, name, promise, what, who, status, icon, proof, shot, sort, href)
  on conflict (org_id, key) do update set category = excluded.category, name = excluded.name, promise = excluded.promise, what = excluded.what,
    who = excluded.who, status = excluded.status, icon = excluded.icon, proof = excluded.proof, screenshot = coalesce(excluded.screenshot, f.screenshot),
    href = excluded.href, archived = false, updated_at = now();
  perform set_config('pulse.org_id', '', true);
end $$;

-- migrate:down
-- Catalogue rows are content: the founder edits or archives them in Pulse HQ.

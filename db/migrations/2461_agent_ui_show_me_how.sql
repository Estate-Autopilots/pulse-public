-- migrate:up
-- DOCS-EDITOR-8 (owner, 17 Nov 2026: "if someone asks 'how do I add a bank statement / a task', the agent should show
-- it on the screen (operator mode in the side browser, or full-screen control when the person allows)"). One more
-- screen action for AI employees: guide.play, "show me how". The person's browser finds the walkthrough that answers
-- their question (apps/web/app/lib/learn.mjs, the Learn tutorials) and plays it on the page step by step: it opens the
-- page, points at each step's button and shows the step's words with Back / Next and "Do it for me". It never clicks
-- or types by itself, so it is a 'view' action like point.at. Playing it on the person's whole screen (outside the
-- operator view beside their chat) waits for their own tap in the browser first. "Do it for me" is a chat message to
-- the AI employee, whose clicks and fills keep their own levels (send, pay, delete … still asked every time).
-- Same function as 2080 with guide.play added to the view list; additive.
create or replace function pulse.agent_ui_action_level(p_action text, p_args jsonb) returns text language sql immutable as $$
  select case
    when p_action in ('page.open', 'panel.open', 'tab.open') then
      case when coalesce(p_args->>'path', p_args->>'target', '') ~* '^(https?://[^/]+)?/(settings|admin|platform)(/|\?|#|$)' then 'admin' else 'view' end
    when p_action in ('panel.close', 'sidebar.set', 'point.at', 'mic.stop', 'screen.read', 'guide.play') then 'view'
    when p_action = 'form.open' then case when coalesce(p_args->>'form', '') in ('person', 'ai_employee') then 'admin' else 'act' end
    when p_action in ('composer.insert', 'emoji.insert', 'file.pick', 'mic.start', 'field.fill', 'file.upload', 'file.download') then 'act'
    when p_action = 'element.click' then
      case when coalesce(p_args->>'text', '') ~* '(^|[^a-z])(delete|remove|discard|cancel|pay|send|submit|approve|reject|sign|archive|revoke|disable|log ?out|sign ?out|transfer|refund|issue)([^a-z]|$)' then 'confirm' else 'act' end
    else null end
$$;

-- migrate:down
-- Forward-only.

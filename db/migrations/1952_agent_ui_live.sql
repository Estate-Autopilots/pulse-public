-- migrate:up
-- FIX-CHAT-AI (owner walkthrough, 10 Nov 2026: "when I ask the accounts assistant to do something, it should visibly work
-- on screen like a human: open pages, click, fill and show progress"; "typed, cheap tools for every screen action with a
-- screen map"). Three screen actions join AGENT-UI-CONTROL's (1745) and their levels:
--   * screen.read (view): the page on their screen as a short map (ids of its buttons, fields and rows), so an AI
--     employee acts on what is there without a big context;
--   * element.click (act): a visible click (the AI cursor glides there first). A click whose words delete, remove, send,
--     pay, approve, sign … needs admin, so an admin or leadership allows it in the top bar first (Allow once);
--   * field.fill (act): words typed into a field, a few letters at a time.
-- Everything else stands: only for the person it is helping, checked and audited per action (agent_ui_action).
create or replace function pulse.agent_ui_action_level(p_action text, p_args jsonb) returns text language sql immutable as $$
  select case
    when p_action in ('page.open', 'panel.open', 'tab.open') then
      case when coalesce(p_args->>'path', p_args->>'target', '') ~* '^(https?://[^/]+)?/(settings|admin|platform)(/|\?|#|$)' then 'admin' else 'view' end
    when p_action in ('panel.close', 'sidebar.set', 'point.at', 'mic.stop', 'screen.read') then 'view'
    when p_action = 'form.open' then case when coalesce(p_args->>'form', '') in ('person', 'ai_employee') then 'admin' else 'act' end
    when p_action in ('composer.insert', 'emoji.insert', 'file.pick', 'mic.start', 'field.fill') then 'act'
    when p_action = 'element.click' then
      case when coalesce(p_args->>'text', '') ~* '(^|[^a-z])(delete|remove|discard|cancel|pay|send|submit|approve|reject|sign|archive|revoke|disable|log ?out|sign ?out|transfer|refund|issue)([^a-z]|$)' then 'admin' else 'act' end
    else null end
$$;

-- migrate:down
-- Forward-only.

-- migrate:up
-- WL-DOCS (Willow Lane's owner, 18 Nov 2026: "quotation and all document creation is not working"; Estate Autopilots'
-- owner, 17 Nov: "I could not open it beside the chat").
--
-- An AI employee's runtime needs to know WHO wrote the message it answers:
--   * the screen tools (open a doc, a quotation or a page beside that person's chat) are sent for that person;
--   * a doc it writes when asked to "show" it is opened beside their chat by the runtime itself;
--   * its prompt names the person with their id, so "assign it to me", "I am the approver" and "remind me" need no lookup;
--   * a job on a company server is run for that person.
-- The runtime reads message.authorId from the run's context for all four (services/coworker: screenTarget, the asker
-- line, run_on_server). agent_dispatch's context never carried it: only the author's name. So on production no AI
-- employee has ever driven a screen (pulse.agent_ui_action holds no row with an agent, in any company), every screen
-- tool an AI called was refused "You can drive the screen only of a colleague you are helping" (its target fell back to
-- the AI itself), and a doc it made was never opened beside the chat.
--
-- Only a staff author's id is given (a client's or guest's message names nobody to act for). It is the person id the AI
-- employee already sees (search_people, the chat's members); nothing new is disclosed. Pulse still decides every screen action (the person's own level, "they wrote to you in the last 30
-- minutes", staff only): agent_ui_request is unchanged.
do $$
declare d text; c text;
begin
  d := pg_get_functiondef('pulse.agent_dispatch(uuid,uuid,text,text)'::regprocedure);
  c := replace(d, $x$'author', p.display_name, 'channelKind', ch.kind, 'channelName', case when ch.kind = 'direct' then null else ch.name end)$x$,
                  $x$'author', p.display_name, 'authorId', case when p.side = 'staff' then x.author_id end, 'channelKind', ch.kind, 'channelName', case when ch.kind = 'direct' then null else ch.name end)$x$);
  if c = d or position($x$'authorId', case when p.side = 'staff' then x.author_id end$x$ in c) = 0 then raise exception 'agent_dispatch changed shape (WL-DOCS 2370)'; end if;
  execute c;
end $$;

-- migrate:down
-- Forward-only.

-- migrate:up
-- QA-1024 (R035, 24 Oct 2026): a task an AI employee proposed said "Proposed by Mira (AI) (AI employee)": its
-- display name already ends in "(AI)" and 0965's agent_proposal_decide appends " (AI employee)". The note now drops a
-- trailing "(AI)" from the name first, so it reads "Proposed by Mira (AI employee)". Tasks already made keep their
-- note. No function body is copied: 0965's definition is edited in place and refused if its shape changed.
do $$
declare definition text; changed text;
begin
 definition:=pg_get_functiondef('pulse.agent_proposal_decide(uuid,text,text,text)'::regprocedure);
 changed:=replace(definition,$x$'Proposed by ' || aname || ' (AI employee); created by '$x$,
  $x$'Proposed by ' || regexp_replace(aname, '\s*\(AI\)\s*$', '', 'i') || ' (AI employee); created by '$x$);
 if changed=definition then raise exception 'agent_proposal_decide changed shape'; end if;
 execute changed;
end $$;
-- migrate:down
-- Forward-only.

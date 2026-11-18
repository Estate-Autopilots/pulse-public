-- migrate:up
-- WL-BHARATA-E2E (6 Nov 2026), found running Willow Lane's quote cycle on staging with a synthetic company:
--  * An admin can give an AI employee the Billing tool. 1562 (AGENT-API) opens billing to an AI member with 'billing' in
--    agent_member.tools (erp_can) and the AI employee screen offers "Billing", but agent_settings_save refused it
--    ("Unknown tool billing"), so no company could let bhrātā draft, submit or send a quotation. Only the allow-list changes.
--  * The approval task submit_quotation makes ("Approve quotation for …", erp_document.task_id, logged as a 'task' event
--    with approval true) is done once the quotation is approved, as the operation promises; it stayed open after Approve.
--    Moved as the approver (task_move); if that is refused (someone else approved), the approval still stands and the
--    history says the task stayed open.
--  * erp_task_guard let a task linked to a document finish only once an INVOICE was issued, so the approval task linked
--    to a quotation could never be finished, not even by hand. A quotation's own task (erp_document.task_id) now
--    finishes once that quotation is approved (issued, sent, accepted …); invoices and milestones are unchanged.
--    No table is created.
do $mig$
declare d text; c text;
begin
  d := pg_get_functiondef('pulse.agent_settings_save(uuid,jsonb)'::regprocedure);
  c := replace(d, $x$if t not in ('chats','tasks','memory','board','drive','web','server','mcp','projects') then$x$,
                  $x$if t not in ('chats','tasks','memory','board','drive','web','server','mcp','projects','billing') then$x$);
  if c = d then raise exception 'agent_settings_save changed shape (WL-BHARATA-E2E)'; end if;
  execute c;

  d := pg_get_functiondef('pulse.erp_approval_follow()'::regprocedure);
  c := regexp_replace(d, E'\n  return null;\nend', $x$
  -- WL-BHARATA-E2E: the approval task of submit_quotation is done once the quotation is approved.
  if old.status = 'draft' and new.status = 'issued' and new.task_id is not null and exists(select 1 from pulse.erp_event e
       where e.org_id = new.org_id and e.subject_type = 'document' and e.subject_id = new.id and e.kind = 'task'
         and e.detail->>'taskId' = new.task_id::text and coalesce((e.detail->>'approval')::boolean, false))
     and exists(select 1 from pulse.task t where t.id = new.task_id and t.status not in ('done', 'accepted', 'cancelled')) then
    begin
      perform pulse.task_move(new.task_id, 'done', left('Quotation ' || coalesce(new.number, '') || ' approved', 200));
    exception when others then
      perform pulse.erp_log('document', new.id, 'approval_task_open', jsonb_build_object('taskId', new.task_id));
    end;
  end if;
  return null;
end$x$);
  if c = d then raise exception 'erp_approval_follow changed shape (WL-BHARATA-E2E)'; end if;
  execute c;

  d := pg_get_functiondef('pulse.erp_task_guard()'::regprocedure);
  c := replace(d, $x$select exists(select 1 from erp_document d where d.doc_type='invoice' and d.status$x$,
                  $x$select exists(select 1 from erp_document d where (d.doc_type='invoice' or (d.doc_type='quotation' and d.task_id=new.id)) and d.status$x$);
  if c = d then raise exception 'erp_task_guard changed shape (WL-BHARATA-E2E)'; end if;
  execute c;
end $mig$;

-- migrate:down
do $mig$
declare d text; nl text := chr(10); tail text := '  return null;' || chr(10) || 'end';
begin
  d := pg_get_functiondef('pulse.agent_settings_save(uuid,jsonb)'::regprocedure);
  execute replace(d, $x$'mcp','projects','billing') then$x$, $x$'mcp','projects') then$x$);
  d := pg_get_functiondef('pulse.erp_approval_follow()'::regprocedure);
  if strpos(d, nl || '  -- WL-BHARATA-E2E:') > 0 then
    execute split_part(d, nl || '  -- WL-BHARATA-E2E:', 1) || nl || tail || substr(d, strpos(d, tail) + length(tail));
  end if;
  d := pg_get_functiondef('pulse.erp_task_guard()'::regprocedure);
  execute replace(d, $x$(d.doc_type='invoice' or (d.doc_type='quotation' and d.task_id=new.id)) and d.status$x$, $x$d.doc_type='invoice' and d.status$x$);
end $mig$;

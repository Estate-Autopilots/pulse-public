-- migrate:up
-- CI / READY (23 Oct 2026): ATT part 1 (0860) turned HR request reminders into one daily digest per approver
-- (approval.digest, subject = the approver, from hr_flow_remind), but notification_recipient_allowed never learned the
-- new type, so notification_emit refused every digest and approvers were never reminded at all (hr_flow_remind
-- returned 0; tests/core/test_hr_flows.py). The digest is the approver's own: allowed when it names the recipient.
do $$
declare definition text; changed text;
begin
 definition:=pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
 changed:=replace(definition,' elsif p_type=''update.test'' then',
 ' elsif p_type=''approval.digest'' then
  return p_subject=''person'' and p_id=p_person;
 elsif p_type=''update.test'' then');
 if changed=definition then raise exception 'notification_recipient_allowed changed shape'; end if;
 execute changed;
end $$;
-- migrate:down
-- Forward-only.

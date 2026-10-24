-- migrate:up
-- Import receipts are metadata-only and run as the worker, like project mutation audits.
grant execute on function pulse.audit_write(text,text,text,text[]) to pulse_worker;
-- migrate:down

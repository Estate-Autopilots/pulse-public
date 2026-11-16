-- migrate:up
alter table pulse_priv.finance_document drop constraint finance_document_kind_check;
alter table pulse_priv.finance_document add constraint finance_document_kind_check check(kind in ('period','case','case_resolution','budget','commitment','schedule','forecast','vendor','rule','close','undo','adjustment','balance'));
-- migrate:down

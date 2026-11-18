-- migrate:up
-- CI (23 Oct 2026): FLOW-A (0800) rebuilt notification_subject_type_check from a typed list and dropped the two subject
-- types added with check_values_add since 0241: 'erp_document' (0509, the quotation-ready notice) and 'update' (0730,
-- update alerts). Every notice about a quotation or an update then failed the check (23514, "Please check your
-- request"): POST /api/v1/service/quotes/:id/ready-notice, update alerts and update requests. Both come back; nothing
-- else in the list changes.
select pulse.check_values_add('pulse.notification'::regclass, 'notification_subject_type_check', 'subject_type', array['erp_document', 'update']);

-- migrate:down
-- Forward-only.

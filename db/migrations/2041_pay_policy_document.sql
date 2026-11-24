-- migrate:up
-- HR-PEOPLE (owner, 13 Nov 2026, T1.1.10–11: "when you input data in here, we should also connect it to a document …
-- filled with lines and grammar … that can be added to a new module … policy acceptance"): the pay policy is one of the
-- company's policy documents. People & pay → Pay policy writes it from the numbers HR enters (the web's
-- people/pay/policy-doc.mjs) through the existing draft and publish functions (0127/0215); publishing asks every
-- employee to accept it on My desk → Policies, as every other policy, and AGREEMENTS' acceptance view reads the same
-- policy_document and policy_ack rows. Nothing else changes: the same row security, grants and functions.
alter table pulse.policy_document drop constraint if exists policy_document_kind_check;
alter table pulse.policy_document add constraint policy_document_kind_check
  check (kind in ('leave','wfh','attendance','expenses','travel','conduct','pay'));

-- migrate:down
-- Forward-only: a published pay policy and its acceptances are kept.

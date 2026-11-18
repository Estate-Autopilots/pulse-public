-- migrate:up
-- DOCS-POLISH (owner, 14 Nov 2026: "the goodness that needs to be there is not there"): "Make this doc richer" turns a
-- doc's number tables into charts, its key-number lists into big numbers, dated steps into a timeline and long detail
-- sections into toggles (services/api/src/doc-richer.ts). Each such change is kept in the doc's History as its own
-- version, reason 'enrich' ("Made richer"), so it never merges into the person's editing session and one Restore undoes
-- it. pulse.doc_keep_version (1686) already starts a new version for any reason but 'edit'; only the check widens.
alter table pulse.doc_version drop constraint if exists doc_version_reason_check;
alter table pulse.doc_version add constraint doc_version_reason_check check (reason in ('edit', 'restore', 'import', 'create', 'enrich'));

-- migrate:down
alter table pulse.doc_version drop constraint if exists doc_version_reason_check;
alter table pulse.doc_version add constraint doc_version_reason_check check (reason in ('edit', 'restore', 'import', 'create'));

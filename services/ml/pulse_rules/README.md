# Pulse delivery rules

Version `delivery-rules/v2`. This pure Python package adapts the shared `pulse_sdk.cid` parser and
Appendix F.1 folder normalizer/rule engine, parses configured legacy names, and explains whether a file is a
candidate deliverable. Tenant folder rules and filename hints are passed as data; the package has no tenant-specific
runtime defaults.

`pulse_rules.folder_rules.load(conn, org_id)` loads all active `folder_rules` documents for one organisation. It
orders them by `doc_key`, then version, merges objects recursively, and lets later arrays/scalars replace earlier
values. If no active document supplies exclusions, the merged result receives the default list in
`packages/schemas/config/folder_rules.json`. Legacy 0045
fields are normalized before strict JSON Schema 2020-12 validation. The returned rules retain the document key that
supplied the active index rules so delivery explanations identify the matched tenant document.

`pulse_rules.protected_paths.is_protected(path, extra)` is the list of folders onboarding never proposes. The built-in
list covers HR and human resources, finance, payroll and salary (the Drive backfill's words), legal, credentials and
passwords, personal and archive. It cannot be switched off. A company's optional `folder_rules.protected_paths` array
adds patterns. An empty array still leaves every built-in in force. Each path segment is case-folded, with `_ . -`
read as spaces, and patterns match only as whole words: "Three Rivers" and "Personality Shoot" pass.

`classify_creative_type(file_event, tenant_config)` applies the tenant's `creative_type_rules` table for folder paths,
filename patterns and parsed CID/legacy type codes. Its categories are `model_video`, `vov`, `founder_video`,
`testimonial`, `walkthrough` and `other`. Folder rules take precedence over filename rules, which take precedence over
parsed type codes. Unmatched deliveries are `other` with `classified: false`; no names are inferred by code. The
classifier returns the matched source, rule and evidence so a tenant can audit or correct the table without a deploy.

`classify_design_type(file_event, tenant_config)` applies `design_type_rules` to image, PDF, PSD and AI exports in
configured deliverables folders. Its categories are `single_image_ad`, `carousel`, `brochure`, `logo`, `pitch_deck`
and `other`. It walks normalized path segments deepest-first: an `exclude` match before a folder type match returns
`other`, while a deeper type match wins over exclusions in outer containers. Within one segment, exclusions take
precedence over type rules. Folder rules win over filename rules; unmatched supported exports stay as `other` with
`classified: false`. PSD and AI exports remain eligible when Drive reports a generic binary MIME type because their
file extensions are explicitly recognised. `classify()` includes this design label and its rule evidence on each
candidate delivery.

Run the fixture suite with `uv run --directory services/ml/pulse_rules pytest -q`. CID cases come from the canonical
`packages/schemas/fixtures/cid.json`, shared with TypeScript. `fixtures/delivery_detection.v2.json` contains legacy-name,
version-order, video classification, and design export fixture cases for this package, under `delivery-rules/v2`.

## Limits

- The protected list matches on words, so it can miss folders: "Paralegal" passes, and so do sensitive folders in
  other languages. A company adds such names through `protected_paths`. Only the onboarding sort applies the list.
  Deliveries rely on the backfill's own sensitive-path filter.

- A file in a configured deliverables folder is a candidate, not a confirmed delivery. The projector combines it
  with the confirming signals in 03 §2 before recording delivery.
- A syntactically valid CID is treated as an asset unless `tenant_config.asset_index` is supplied. With an index,
  unknown CIDs are left unresolved and cross-project CIDs are flagged for review.
- Legacy names are only identified when configured type hints match. An unmatched name stays unresolved with low
  confidence; this package does not infer a person, project, or asset title from free text. If the event supplies a
  Drive `file_id`, the provisional legacy asset is keyed as `gdrive:<file_id>` and has type `unknown` until a type
  hint resolves it. This package does not merge file-keyed legacy assets.
- The caller supplies the path below the explicitly bound project root. Roots are never inferred from folder names.
- The design label is deterministic classification evidence; it does not confirm acceptance, quality, or an individual's authorship.
- Version numbers omitted from a CID remain `None`; the projector assigns those in upload order. This package only
  provides a stable ordering key for already-numbered versions and upload timestamps.
- Creative type is a deterministic candidate label, not proof that a delivery is accepted or quality-reviewed. The
  caller must persist and expose the label with its existing delivery record if it needs to appear in a product view.

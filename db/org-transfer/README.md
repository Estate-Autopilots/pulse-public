# Organisation transfer manifest

`tools/org-transfer manifest [--check]` runs the shared `pulse_sdk.org_transfer` module through uv.
Set `PULSE_DATABASE_URL_MIGRATE` (or the existing migration environment); tests can use
`PULSE_CI_DATABASE_URL`. The CLI reads **catalogue metadata only**, in a read-only connection with
a 60-second statement timeout. It never reads source rows or changes database data.

The sorted JSONL includes the isolation suite's exact tenant-table query plus `pulse.org`.
Refresh preserves all authored fields, classifications and stale entries; new tables start
`unclassified` with no JSONB declarations. Classifying a table never silently marks its JSONB
columns ID-free: declare each column explicitly. `--check` writes nothing and lists every
classification, stale-entry, missing-column, duplicate, skip-reason and FK-closure problem
before failing. `catalogue()` returns the table/JSONB map and `pg_constraint` FK edges together:
Within tenant tables, copy rows may reference only copy rows; rebuild rows may reference copy or rebuild rows.
Nullable and non-deferrable edges are checked too. The manifest path uses `repo_root()`
and supports `PULSE_REPO_ROOT` in non-editable installations.

Three reviewed global FK parents remain outside tenant transfer: `privacy.purpose` and
`privacy.retention_class` are destination registry seeds resolved by `code`;
`pulse_priv.pulse_account` requires the target account-link mapping. `SHARED_FK_PARENTS`
records these dependencies; the catalogue retains their FK edges for export/import preflight.
Import must fail on an unresolved reference and must never copy global sign-in credentials.
Unknown global parents fail the check; a listed parent becoming tenant-scoped must be classified.

- `copy`: canonical facts/history, including canonical rows with deterministic UUID5 IDs.
  `person` (talent), `client`/`project` (Ops Hub), `lead`/`buyer` (research) and `raw_capture`
  retain their source facts. `asset`, `version`, `file`, `ad`, `ad_set` and `campaign` also stay
  copy: copied history references them, indexed deliveries write them, and replay may reject
  source CIDs after an organisation-code collision. Copied UUID5 identities must be remapped
  by recomputing `entity_id(target_org, key)` so future events address the same records.
- `rebuild`: only `ad_metric_day`, `attribution` and `folder`; no copied row points at them.
  Replay under the target organisation. `task` is copy: authored fields and directly written records
  survive transfer, matching the projector's preservation of imported/edited tasks.
  This file does not implement replay.
- `skip`: ephemeral sessions, credentials, enrollment capabilities and caches, with a reason
  on every entry. Durable acceptance/invitation histories stay `copy`; their bearer capabilities
  must be invalidated/reissued by the importer. Mixed configuration/credential rows likewise
  require rekey/rotation. Classification never authorizes retaining source credentials live.
  Device and service-key parent rows remain `copy` to retain consent, activity and update
  history FKs. The importer must set `revoked_at`, clear keys/tokens (use constraint-valid
  inert values for NOT NULL keys), and require fresh device enrollment/target credentials.

Every `copy`/`rebuild` JSONB column has a list of ID-bearing paths or `[]` for no known ID leaves.
Paths include the column: `payload.person_id`, `payload.items[].asset_id`, `items[]`.
`[]` within a path means every array element (including nested arrays); `*` means one object
key in a documented map, e.g. `people.*`. There is no recursive wildcard.

`tests/core/test_org_transfer_manifest.py` builds the isolation suite's synthetic world/extras,
walks JSON values under existing tenant RLS, and rejects undeclared UUID-shaped string leaves.
Its negative transaction rolls back a new tenant table and an unexpected nested UUID path,
then checks a new path on an existing table. Diagnostics contain table/path names, not values.
Synthetic coverage is bounded by exercised shapes; new shapes require fixtures and reviewed
paths. UUID columns without FKs and identifiers in text columns belong to the import work.

This is a manual metadata command, not a poller. Run once per schema change; tests run through
`ea-heavy`, at most two workers. Source originals and privacy/participant access remain unchanged.

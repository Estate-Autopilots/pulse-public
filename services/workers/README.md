# services/workers · Workers (normaliser, projectors, rules)

Procrastinate (PostgreSQL-backed queue) workers: collector schedules, the normaliser (`raw_inbox` → events),
projectors (asset, version, input, milestone, blocker, delivery), the rule engine (folder rules, milestones,
blockers), the nudge scheduler, retention and partition maintenance. This is `services/worker/` in spec 05 §4.1.

**Status (2026-10-05):** the projection runner, the work-graph projection (folders, files, tasks, assets, versions, existence, `delivery-attribution/v1`, Meta campaigns/ads/daily metrics), partition maintenance, retention and the daily schedule are built (`src/pulse_workers`, run with `pulse-worker run`). Procrastinate joins when the first queued jobs (collector schedules) arrive; milestones, blockers and scores are next.

`pulse-worker rules check --org <uuid>` validates one organisation's active `folder_rules` documents;
`pulse-worker rules check --all` prints one counts-only summary per active organisation and exits non-zero if any
configuration is missing or invalid. Output contains document keys and versions, validation errors, and rule counts;
it never prints Drive file names.

`pulse-worker onboard --org <uuid> --step sort|fill [--dry-run]` proposes unmatched projects from valid
`project_paths` rules and fills missing project clients, pods and primary deliverable types from configured rules.
Sort never creates a project; fill only creates Review proposals, uses at most five file IDs as evidence, and writes
project fields after an explicit decision. Both steps use per-org advisory locks and stable source keys for
idempotency. Protected folders (`pulse_rules.protected_paths`) are never proposed or used as fill evidence; the
counts include excluded folders without names. The built-in list covers HR, finance, legal, credentials, personal
and archive, plus the company's own patterns. The worker loop schedules sort at most once per hour per active
organisation, checks for due organisations once a minute, and retries failures after 1, 2, 4, 8, 16 and 32 minutes,
then hourly.

Each non-dry-run sort upserts a counts-only receipt in `pulse.onboarding_sort_receipt`, including zero-proposal runs
and skipped reasons. Admins can read it at `GET /api/v0/admin/onboarding/receipt`. On staging, use
`POST /api/v0/admin/onboarding/run` with `{"step":"sort","dryRun":true}` to exercise the matcher against the
indexed data without writing proposals or changing the receipt.

- **Lane:** `platform` (Platform Engineer); rule content is reviewed with the `intel` lane.
- **Spec:** 05 §4 (`worker`), 05 §6 (event bus), 02 §5 (projections), 02 §4 (identity resolution),
  appendix F (rules), 06 §8 (retention), ADR-0003.
- **Roadmap:** 07 §3 week 1 (normaliser, partition maintenance), week 2 (rule engine, CID and legacy name parsers,
  delivery projection), week 4 (retention jobs, nudges).

## Definition of done

The shared checklist in [CONTRIBUTING.md](../../CONTRIBUTING.md#definition-of-done), plus: the appendix F fixture
tables and worked examples run as tests; projectors are idempotent (replaying the log gives the same projections).

## Conventions

Python package in the root uv workspace (add it to `members` in the change that creates its `pyproject.toml`).

## Local checks

Run the scaffold test and lint from the repository root with `uv run --directory services/workers pytest -q` and
`uv run --directory services/workers ruff check .`. Add worker services and queue dependencies here as their
roadmap issues are implemented.

## Delivery attribution

`delivery-attribution/v1` uses the existing `pulse.account`, `pulse.identity_link`, and `pulse.attribution` tables.
The EA account map is supplied outside git through `PULSE_EA_ACCOUNT_MAP_FILE`, mounted at
`/etc/pulse/ea-account-map.json` in staging. It contains account handles and person UUIDs and must stay in the EA
runtime environment. The existing `pulse-ea-bootstrap` refresh applies it idempotently after `sudo ea-agent pulse-db`;
bootstrap output reports counts only. Omit the environment variable when no map is configured; this leaves existing
account mappings untouched.

Verified, non-shared individual account links take precedence unless the delivery has a person confirmation or
rejection. Shared accounts are credited only by a unique export fingerprint or deliverables-folder owner; conflicting
signals remain `shared login`. Attribution evidence stores tenant-scoped opaque evidence IDs, rule groups, and how labels; person references, account handles, file names, and raw fingerprints are not copied into evidence.

## Ops Hub importer (mapping v1)

`uv run --all-packages python -m pulse_workers.opshub_import --dry-run --file <snapshot.json>`
reads the Ops Hub row shape and prints counts. `--apply` writes one tenant-scoped transaction and
returns its unique batch ID; before-values are recorded in `source_observation` (`opshub_ledger`).
Without `--file`, sources are `PULSE_OPSHUB_DATABASE_URL` (read-only) or the
`PULSE_OPSHUB_SUPABASE_URL` / `PULSE_OPSHUB_SUPABASE_KEY` pair (GET only). Credentials stay in env.
EA only; no staff creation, ambiguous matches skipped, reused project fields fill empty only,
and task locks preserved. Missing onboarding uses the company's current day for the page's backfill;
repeating on another day can change those generated dates. Undo/restoration is the EST-1667 follow-up;
live imports stay gated on verified rollback, exact-head CTO review and merge. The seed importer is separate.

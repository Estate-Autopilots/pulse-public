# db/migrations · Database migrations (plain SQL)

Forward-only plain SQL migrations for the `pulse` databases: core schema, row-level security, partitions,
purposes. Format and bookkeeping follow dbmate (`-- migrate:up` / `-- migrate:down`, `public.schema_migrations`);
apply them with `pulse-migrate` (packages/sdk-py), which runs each file in one transaction under the database's
owner role (`PULSE_DB_OWNER`: `pulse_owner` in production, `pulse_<env>_owner` for staging and dev) and then syncs
the event registry into `pulse.event_type`. Database roles live beside this directory in `db/roles.sql`, which root
runs once per cluster (`db/roles` is a sensitive path: changes need the Pulse CEO's approval).

```bash
PULSE_DATABASE_URL_MIGRATE=… uv run pulse-migrate            # apply + sync registry
PULSE_DATABASE_URL_MIGRATE=… uv run pulse-migrate --status   # applied / pending
```

`0001_core.sql` is the Event Core schema ([docs/event-core.md](../../docs/event-core.md)); `0002_meta_ads_metrics.sql`
adds the reported link CTR and missing-lead-evidence flag to daily Meta metrics; `0009_editor_targets.sql` allows the tenant-owned editor targets document; `0044_editor_week_admin_access.sql` permits a null access-log viewer for Access admins without a person record; `0045_ea_editor_config_seed.sql` applies the repeatable EA editor-week config seed on staging; `0111_ea_designer_targets.sql` seeds EA's placeholder single-image target and brand asset windows.
`0112_design_export_claims.sql` moves shared claim records onto indexed Drive files and adds the guarded design-export claim scope.

When a `design/home` merge brings a migration whose version main already uses, rename the workbench file to a
five-digit version that sorts in the same place (`00451_intelligence_packets.sql` runs after `0044_…` and before
`0045_…`). Never renumber a version that staging or production has applied (EST-321).

The repeatable EA editor-week configuration seed is [db/seeds/ea_editor_config.sql](../seeds/ea_editor_config.sql), backed by migration 0045. The deployment migration applies it on staging. To rerun it manually, use the staging migration login with the staging owner role, matching `pulse-migrate`'s row-security context:

```bash
PGOPTIONS='-c role=pulse_staging_owner' psql "$PULSE_DATABASE_URL_MIGRATE" -X -v ON_ERROR_STOP=1 \
  -f db/seeds/ea_editor_config.sql
```

- **Lane:** `platform` (Platform Engineer).
- **Spec:** appendix A (core schema), A0 (roles), A-tests (RLS and privacy tests), 05 §6 (event bus), 05 §7
  (multi-tenancy and RLS), 06 §8 (retention), ADR-0003, ADR-0005.
- **Roadmap:** 07 §3 week 1 (`0001_core.sql` with the v0.3 purposes `work_delta` and `command_counts`; partitions
  created before any ingest; A-tests in CI against a real PostgreSQL 17).

## Definition of done

The shared checklist in [CONTRIBUTING.md](../../CONTRIBUTING.md#definition-of-done), plus: the migration applies to
an empty database and the Event Core suite passes in CI (`tools/ci-db.sh` runs `tests/core` when
`PULSE_CI_DATABASE_URL` is set); a new table has `org_id` and the tenant policy or is added to the global allow-list
in `tests/core/test_acceptance_isolation.py` with a reason; an applied migration is never edited, only followed by a
new one.

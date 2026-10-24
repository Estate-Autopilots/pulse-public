# tests/ (lane `qa`)

Cross-cutting suites that guard the whole product, owned by QA & Release:

- `core/`: the Event Core acceptance suite (real PostgreSQL 17, one login per service): replay, one asset per file,
  attribution by export fingerprint, cross-tenant isolation, purposes and retention, ingest protocol, collector
  runtime. Run by `tools/ci-db.sh`; map of criteria to tests in [docs/event-core.md](../docs/event-core.md).
- `e2e/`: isolated Playwright workspace and end-to-end tests of the web screens (runs in `tools/ci.sh` when Chromium is installed and a web app exists).
- `privacy/`: hard-limit and person-first visibility tests (spec ADR-0012, appendix A-tests), including cross-tenant
  isolation with a second synthetic tenant.
- `smoke/`: stdlib `unittest` coverage for the local-server smoke script (`tools/smoke <base-url>`), used on staging after every deploy.

The synthetic TASKS-P0 board and its browser spec share `e2e/fixtures/tasks-clock.mjs`; its clock advances from noon IST so date groups do not change with the CI run time.

Fixtures are synthetic; never real people's data. Package-level unit tests live next to their package.

`core/test_service_flow.py` runs the scoped quote-agent journey through the operator and service HTTP handlers
against a disposable database, including salesperson-only notices, revocation and response/log privacy.
Release smoke runs `tools/service_key_smoke.py` against public and loopback origins. Production public
checks always run without Access credentials; only staging public checks skip without both Access inputs
(CTO contract adjustment EST-1901). Loopback remains mandatory. Redirects fail when public checks run;
staging's unauthenticated Access gate and production's public 401/401/403 are recorded separately.

Round 7A verifies every registered API route and every Next page for employee, manager, PGS, HR, leadership
and operational admin using actual password sessions in a disposable tenant. Additions to the API route list
are automatically discovered and unclassified mutations fail the matrix. Sensitive boundaries also receive
valid payloads and populated records; malformed-request checks do not establish permission by themselves.
The optional browser suite starts temporary local API/web servers and checks two-person realtime Chats,
threads, reactions, attachment downloads and search. It does not send employee messages on dev.

```sh
bash tools/pg-scratch.sh start
pnpm --filter @pulse/api build
# Use a distinct disposable database when other workbenches run CI concurrently.
round7_base_url="$(bash tools/pg-scratch.sh url)"
psql "$round7_base_url" -c 'create database pulse_ci_round7a' # create once
PULSE_CI_DATABASE_URL="${round7_base_url/pulse_ci?/pulse_ci_round7a?}" PULSE_PAGE_MATRIX=1 \
  uv run --all-packages pytest tests/core/test_access_matrix.py tests/core/test_chats.py -q --basetemp=/tmp/pulse-round7a-ci
# Stop the scratch server only when no other workbench is using it.
```

`tests/e2e/round-7A-visual.mjs` captures read-only local pulse-dev pages at six sizes in both themes; safe artifacts
stay outside the repository. `company.spec.ts` checks the live company shell without submitting changes.

# Contributing to Pulse

Every change follows one path: **issue → lane → task branch → CI → review → merge → staging → production.**
The tools in `tools/` do the mechanical parts; the rules below are what they enforce. (The binding versions are the
ops contracts in `ea-infrastructure/watchdog/CONTRACTS.md`; this page is the short form.)

## Lanes

Work is split into lanes. Each lane has one engineer and holds **one task branch at a time**. The `data` lane is
shared by the four Data seats; whoever claims it holds it until the merge.

| Lane | Engineer | Home paths |
|---|---|---|
| `platform` | Platform Engineer | `services/api`, `services/ingest`, `services/workers`, `services/bot`, `collectors`, `packages/schemas`, `packages/sdk-*`, `db`, `infra`, `tools`, `.github` |
| `web` | Web Engineer | `apps/web` (pilot screens), `packages/design-system` |
| `web2` | Web Engineer 2 | `apps/web` (full-app modules: frame, People and HR, leave and attendance, Drive, chat, Meta) |
| `data` | Data Engineer, with Head of Data, Data Steward and Signals Analyst | `collectors` and `packages/sdk-py` (shared with `platform`), `services/data`; `db/migrations` numbers are agreed with the Platform Engineer |
| `desktop` | Desktop Engineer | `apps/desktop`, `plugins` |
| `intel` | Intelligence Engineer | `services/ml`, `config/role-packs` |
| `mobile` | Mobile Engineer (phase 2, paused) | `apps/mobile` |
| `qa` | QA & Release | `tests` (end-to-end, privacy and cross-tenant suites), staging smoke, `RELEASE_NOTES.md` |
| `ops` | Pulse CTO, Planner, Chief of Staff | `docs` (spec, ADRs, runbooks); planning lives in Paperclip; a `task/ops/` branch only for doc changes, never auto-started |

The lane of an issue is its Paperclip project; a `Lane: <name>` line in the issue description wins.
`tools/lanes.json` is the machine-readable copy.

## How work flows

1. **Pick up the issue** (`EST-n`) assigned to you in your lane's project.
2. **Claim the lane:** `tools/lane start <lane> EST-n-<short-slug>`. This creates `task/<lane>/EST-n-<slug>` from
   the latest `main` and pushes it; the pushed branch *is* the claim. If the lane is busy the tool refuses and says
   which branch holds it. `tools/lane status` shows every lane.
3. **Build in small commits and push often.** Start commit subjects with the issue id
   (`EST-31: add My Week empty state`). If `main` moves and you need it, `tools/lane sync` merges it in and pushes
   (merge, never rebase or force-push a pushed branch).
4. **CI runs on every pushed head** (local mode: the local runner; GitHub mode: the pull request the watchdog opens
   for your branch): `tools/ci.sh`, the same script in both places.
   Run it yourself first: `bash tools/ci.sh`.
5. **Hand over for review:** `tools/lane ready --ci` checks the branch is clean, pushed and in sync, then prints
   `Ready for review: EST-n @ <sha7>`. Paste that line into the issue with a short summary and evidence (tests,
   screenshots for UI).
6. **Review:** the Pulse CTO reviews every change (`CTO approved: EST-n @ <sha7>`). Changes under UI paths
   (`apps/web`, `apps/desktop/src`, `apps/mobile`, `packages/design-system`) also need the UI Guard; changes under
   sensitive paths (`.github/`, `infra/`, `tools/lane`, `tools/ci.sh`, `db/roles`, `privacy/`) also need the Pulse
   CEO. Approvals are bound to the commit: **any new push needs a new `Ready for review` line and new approvals.** Every change also needs `Independent review approved: EST-n @ <sha7>` from a reviewer of another model family (families and test evidence may follow the sha on the same line). Lane issues never carry Paperclip native review/approval stages (`executionPolicy` stages): they reassign the issue to the stage reviewer and close it as `done` without a merge. The review lines are the only gate, so keep the issue `in_progress` and assigned to the lane engineer; the watchdog removes stages it finds.
7. **Merge:** the watchdog squash-merges into `main` once CI passed on the exact head and the approvals are in,
   deletes the branch (the lane is free again) and closes the issue.
8. **Release:** when a `main` commit passes CI, CI moves `staging` to it and it is deployed to pulse-staging.
   Production moves only by the release decision (Pulse CEO, then the owner), with a `vX.Y.Z` tag.

Never push to `main`, `staging` or `production`, never push another lane's branch, never force-push.

## Branch names

`task/<lane>/<EST-n>-<slug>`: lane from the table above, slug of lowercase letters, digits and dashes (starting
with a letter or digit, at most 40 characters). Example: `task/web/EST-31-my-week`.
`tools/lane check-branch <name>` validates a name.

## CI

`tools/ci.sh` discovers what to run from the tree: pnpm workspace packages (install, lint, typecheck, test), Python
packages in the uv workspace (pytest, ruff), the Rust crates under `apps/desktop/core` (`cargo test`), database
migrations and tests (`tools/ci-db.sh` against a scratch PostgreSQL 17), and the secret scan. Each package brings
its own scripts: `lint`, `typecheck`, `test` in `package.json`; pytest and ruff as dev dependencies in
`pyproject.toml`. A new Python package joins `[tool.uv.workspace] members` in the root `pyproject.toml` in the same
change. Commit lockfiles (`pnpm-lock.yaml`, `uv.lock`, `Cargo.lock`).

Locally a missing toolchain is a warning; on GitHub (`PULSE_CI_STRICT=1`) it fails the run.

Hosted CI runs the same entry point with `PULSE_CI_GROUPS` (`tools,js,smoke`, `python`, `schemas`, `rust`,
`db`, or `e2e`). Unset keeps the full local gate. Ten isolated DB jobs use timing-balanced file groups; a separate
`page-matrix-1` and `page-matrix-2` jobs split the complete access matrix, phone widths and themes. Six one-worker Playwright jobs and
the DB jobs reuse the web build from that run (`web-<run_id>`, one head SHA). Aggregate `ci` requires every job, including `image`.
"Re-run failed jobs" restores that build, so a partial re-run is a useful diagnostic, but the hosted verdict still
needs every job green in one attempt: re-run **all jobs** to produce it ("Re-run all jobs" rebuilds and replaces it).

For a historical lab source that predates the hosted gate, `tools/ci-lab-source.py` prepares a new private commit
without changing refs, the real index, a checkout, or a runtime:

```bash
python3 tools/ci-lab-source.py --lab-source <full-original-sha> --gate-source <full-reviewed-gate-sha> --report <output.json>
```

The original lab commit is its only parent. Only the eight listed gate files are copied; every other blob and
file mode stays at the lab source. Use a reviewed EST-1582 gate revision with that complete execution closure;
new gate dependencies require a reviewed closure change. The report records both inputs and the replacement SHA.
The replacement is a different source, never an exact-source receipt for the original SHA. Obtain exact-head CTO
and different-family review before publication through the existing certified exporter and single writer. Only
the installed verifier and its complete same-attempt hosted receipt permit a runtime source handoff to CTO/SysOps.

## QA checks

- Run `tools/smoke <base-url>` after a deploy or against a local service. It checks `/healthz`, then checks the web shell routes (`/`, `/my-week`, `/pod`, `/leadership`) unless `/` returns 404 (API only). Routes pass only on final same-origin 2xx responses within 2 seconds by default. Set `PULSE_SMOKE_MAX_SECONDS` to override the budget; Cloudflare Access service-token headers are sent when both `PULSE_SMOKE_CF_ACCESS_CLIENT_ID` and `PULSE_SMOKE_CF_ACCESS_CLIENT_SECRET` are set.
- `tools/ci.sh` runs the smoke unit tests and the Playwright shell-route suite when the bundled Chromium browser is available. Install it without system packages using `pnpm --dir tests/e2e exec playwright install chromium` (do not use `--with-deps`). Playwright skips with a notice when no web app exists yet or its browser is unavailable. When `PULSE_BASE_URL` is unset and `apps/web/package.json` exists, Playwright builds and starts the web app on `127.0.0.1:3100`; set `PULSE_BASE_URL` to target an existing web build instead.

## Definition of done

Every task, in every lane:

- the issue's acceptance criteria are met, and the spec sections named in the directory's README are respected;
- CI passes on the exact head commit; new behaviour has tests (fixtures are synthetic, never personal data);
- no secrets, tokens or personal data in the repository (`tools/check-secrets.sh --all` before committing);
- no field leaves a device or a tenant beyond the declared schemas (appendix B, registry in appendix D);
- the directory README is updated when its purpose, layout or commands change;
- the review request carries the `Ready for review` line, what changed and why, and the evidence.

Each directory's README adds its own criteria.

## Repository layout and spec 05 §4.1

The owner fixed this layout (ADR-0021); spec 05 §4.1 describes the same pieces with some older names.

| Spec 05 §4.1 | This repository | Note |
|---|---|---|
| `apps/web/` | `apps/web/` | |
| `apps/api/` | `services/api/` | every server lives under `services/` |
| `services/ingest/` | `services/ingest/` | |
| `services/worker/` | `services/workers/` | |
| `services/ml/` | `services/ml/` | |
| `ml/eval/` | `services/ml/eval/` | evaluation sets and runners stay with the models |
| `services/bot/` | `services/bot/` | |
| `collectors/` | `collectors/` | one package per source |
| `agent/` | `apps/desktop/` | `core/` (Rust sensors, tested on Linux), `src-tauri/` (shell), `src/` (UI) |
| `agent/plugins/premiere-uxp` | `plugins/premiere/` | the `.prproj` work-delta parser is `apps/desktop/core/prproj/` |
| other `agent/plugins/*` | `plugins/<app>/` | Photoshop, After Effects, Resolve when they are built |
| `apps/mobile/` | `apps/mobile/` | phase 2 |
| `packages/design/` | `packages/design-system/` | |
| `packages/schemas/`, `packages/sdk-py/`, `packages/sdk-ts/` | same | |
| `db/migrations/` | `db/migrations/` | `db/roles.sql` beside it |
| `config/role-packs/` | `config/role-packs/` | |
| `deploy/` | `infra/` | Dockerfiles, compose, `ea-deploy` notes, local mode |
| `edge/` | `edge/` | phase 3, not created yet |
| `docs/` | `docs/` | the spec and runbooks |
| — | `tools/` | lane tool, CI entry point, secret scan |

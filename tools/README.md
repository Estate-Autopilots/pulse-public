# tools · Flow and CI tooling

The scripts that carry every change from a lane claim to a merge. CI and lane helpers need only Python 3.12+ and
bash; `bootstrap.sh` uses npm and curl to install the pinned toolchains in the current user's home.

Synthetic staging people use name words of 4 letters or fewer, or reviewed `stop_terms`; never add a real-name word to `stop_terms`.

| File | What |
|---|---|
| `bootstrap.sh` | Installs pinned pnpm, uv, Python and Rust toolchains in the current user's home (Node 24 is a prerequisite) |
| `lane` | Lane claims and review hand-over: `start`, `status [--json]`, `ready [--ci]`, `sync`, `check-branch` |
| `org-transfer` | Read-only catalogue manifest refresh/check for organisation transfer; [format and checks](../db/org-transfer/README.md) |
| `lanes.json` | The lanes: Paperclip project, engineer, home paths (`no_branch` for ops, `planned` for mobile) |
| `ci.sh` | The single CI entry point for GitHub Actions and the local runner; exit 0 = pass |
| `smoke` | Checks `/healthz` and web shell routes at `tools/smoke <base-url>`; standard-library Python only |
| `release-smoke.py`, `release-browser.mjs` | Brokered staging checks with synthetic role sessions, including Billing navigation at 1440/390 px in both themes and PDF/DOCX exports from a real package |
| `service_key_smoke.py` | Read-only service-key 401/403 checks; `python3 tools/service_key_smoke.py <origin> [host]`. Release smoke always checks loopback and production public (without Access credentials). Staging public checks require both `PULSE_SMOKE_CF_ACCESS_CLIENT_ID` / `PULSE_SMOKE_CF_ACCESS_CLIENT_SECRET`, otherwise record a skip (EST-1901). Redirects fail when probed. No service key or response body is stored. |
| `release_billing_smoke.py` | Synthetic leadership quotation/party fixture with failure-safe cleanup; reports export sizes and verdicts. When the smoke source includes 0545, requires that deployed SHA/migration and checks saved quote-line links, open-amount refusal, exclusions/restoration and catalogue baseline retention. |
| `release-quote-lines.mjs` | One read-only staging browser and cropped synthetic line-list screenshot, before the Billing fixture is removed. Uses `browser_runtime` private session input; no real catalogue references remain on the captured lines. Run through the reviewed release-smoke broker, not as a standalone login. |
| `check-secrets.sh` | Secret scan (part of CI); `--all` also scans untracked files before you commit |
| `secrets-allowlist.txt` | Known false positives for the secret scan, one `<path glob> <regex>` rule per line |
| `ci-db.sh` | The database step: the migrations and `tests/core` against the scratch database in `PULSE_CI_DATABASE_URL` |
| `ci-db-shards.py` | What `ci-db.sh` runs on a superuser scratch server (OPS-2): `tests/core` in two shards, each on a copy of one migrated template database, split by `tests/core/ci-shards.json` |

- **Lane:** `qa` (QA & Release). `tools/lane` and `tools/ci.sh` are sensitive paths: changes need the Pulse CEO's
  approval.
- **Spec:** 07 §3 week 1 (repository and CI), 05 §13 (supply chain), ADR-0017 (deploy contract). The rules these
  tools enforce are the ops contracts in `ea-infrastructure/watchdog/CONTRACTS.md` §1–§4, summarised in
  [CONTRIBUTING.md](../CONTRIBUTING.md).

## Quick reference

```bash
bash tools/bootstrap.sh              # install the pinned local toolchains
tools/lane status                      # who holds which lane
tools/lane start web EST-31-my-week    # claim the web lane: task/web/EST-31-my-week from origin/main, pushed
tools/lane sync                        # merge origin/main into your task branch and push
tools/lane ready --ci                  # run CI, check the branch is pushed, print "Ready for review: EST-31 @ abc1234"
bash tools/ci.sh                       # the same CI as GitHub and the local runner
PULSE_CI_STRICT=1 bash tools/ci.sh     # missing toolchains fail instead of warning (as on GitHub)
tools/smoke http://127.0.0.1:3100    # health plus shell routes; API-only if / is 404
pnpm --dir tests/e2e exec playwright install chromium # bundled browser; no system packages or sudo
```

`lanes.json` paths are each lane's home: where its work normally lands and who answers for a directory. A task may
touch other paths when it must; the review covers it.

Billing receipts are in `staging-public-check.json` (`billing`) and `staging-browser.json`
(`billing-*` screens). The browser reads the existing catalogue without changing it; disabled-feature
annotations in Billing settings are allowed, service-unavailable messages fail. Billing screenshots
(`staging-billing-*.png`, mode 0600) stay in the private server report directory. Export bytes are never saved.

## Google acceptance

Google acceptance uses the existing `google-acceptance.sh` synthetic stack. The recovered
`tests/e2e/google-acceptance-matrix.mjs` preserves all 27 functional/refusal checks, one browser worker,
synthetic identities only, and staging SHA checks before/after. Loopback requests (including browser
routes) share `services/api/test/google-acceptance-transport.mjs`, which sends the canonical Host using
`node:http`, never follows redirects, and caps each response at 8 MiB / 10 seconds.

For a transport repair, run only the focused regression and read-only staging callback check:

```bash
/usr/local/bin/ea-heavy node --test --test-concurrency=2 services/api/test/google-acceptance-transport.test.mjs
/usr/local/bin/ea-heavy node services/api/test/google-acceptance-transport.mjs "$PAPERCLIP_RUN_SCRATCH_DIR/host-receipt.json"
```

Run the full matrix only for a concrete freshness reason against an explicitly selected deployed SHA:
set `PULSE_GOOGLE_MATRIX_REASON` and `PULSE_GOOGLE_MATRIX_OUT` (an existing absolute private output directory),
then run `bash tools/google-acceptance.sh <exact-staging-sha> --matrix`. The existing harness enters
ea-heavy, builds that SHA and cleans up; matrix execution is capped at 15 minutes (15-second kill grace).
Readiness scans one local manifest once/second for at most 90 seconds, with no background poller.
Receipts record Node, exact build, reason and the label "exact staging build, synthetic Google harness".
These checks do not establish live-provider or product acceptance; historical 26/27 evidence stays unchanged.

## Definition of done

The shared checklist in [CONTRIBUTING.md](../CONTRIBUTING.md#definition-of-done), plus: `bash tools/ci.sh` passes
on a clean checkout once dependencies are installed and can run offline; changes to the flow are reflected in
CONTRIBUTING.md and, when they change a contract, in the ops contracts first.

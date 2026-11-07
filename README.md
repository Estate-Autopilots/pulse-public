# Pulse (codename)

Work-intelligence platform: Sense → Understand → Act → Learn for creative teams.
Company-neutral and portable; each company's rules are tenant configuration.

Start with the spec: [docs/spec/README.md](docs/spec/README.md).

## Repository map

| Path | What | Lane |
|---|---|---|
| [`apps/web/`](apps/web/) | Next.js web app: every browser screen | web |
| [`apps/desktop/`](apps/desktop/) | Tauri 2 desktop agent: `core/` Rust sensors (incl. `core/prproj` parser), `src-tauri/` shell, `src/` UI | desktop |
| [`apps/mobile/`](apps/mobile/) | Pulse phone app: the web app in a Capacitor shell ([docs](docs/native-apps/mobile-shell.md)) | mobile |
| [`services/api/`](services/api/) | Fastify product API (`/v1`, OpenAPI 3.1) | platform |
| [`services/ingest/`](services/ingest/) | FastAPI event ingest and provider webhooks | platform |
| [`services/workers/`](services/workers/) | Normaliser, projectors, rules, schedulers, retention | platform |
| [`services/ml/`](services/ml/) | Scores, benchmarks, coach pipeline, transcription | intel |
| [`services/bot/`](services/bot/) | Coach bot (Telegram first) | intel |
| [`collectors/`](collectors/) | One package per data source, on the collector SDK | platform |
| [`plugins/premiere/`](plugins/premiere/) | Premiere Pro UXP panel | desktop |
| [`packages/design-system/`](packages/design-system/) | Design tokens and shared components | web |
| [`packages/schemas/`](packages/schemas/) | JSON Schemas (events, config, API) and code generation | platform |
| [`packages/sdk-py/`](packages/sdk-py/), [`packages/sdk-ts/`](packages/sdk-ts/) | Collector SDK runtime and API clients | platform |
| [`db/migrations/`](db/migrations/) | Plain SQL migrations (forward-only) | platform |
| [`config/role-packs/`](config/role-packs/) | Neutral role-pack templates | intel |
| [`infra/`](infra/) | Containers, compose, deployment (`ea-deploy`, local mode) | platform |
| [`tools/`](tools/) | Lane tool, CI entry point, secret scan | qa |
| [`docs/`](docs/) | Spec and runbooks | ops |

Each directory's README names its purpose, owning lane, the spec sections it implements and its definition of done.

## Local setup

Use Node.js 24.21.0 (`.nvmrc`), pnpm 10.34.6, Python 3.12, uv 0.12.23 and Rust 1.99.0. With Node 24 already
available, bootstrap the user-local package managers and Rust toolchain, then install the locked dependencies:

```bash
bash tools/bootstrap.sh
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
pnpm install --frozen-lockfile
uv sync --locked
```

Run the full checks, including the Event Core suite, and start the local stack with:

```bash
export PULSE_CI_DATABASE_URL="$(bash tools/pg-scratch.sh start)"
bash tools/ci.sh
uv run --all-packages pytest tests/core -q -p no:cacheprovider
export PULSE_POSTGRES_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
docker compose -f infra/compose.dev.yaml up --build
```

Open `http://localhost:8080` for the web shell. The API listens on `127.0.0.1:8081` and ingest on
`127.0.0.1:8082` inside the container; only web port 8080 is published. `/healthz` returns 200 only while the API
can reach PostgreSQL. The compose database uses a local named volume and is for development only; do not use its
settings on a shared or production host.

## Event Core

The log, identity map and work graph, tenancy/RLS, privacy core, ingest and projections are built and tested:
[docs/event-core.md](docs/event-core.md) explains the implementation and known limits. Keep `tests/core` green.

## How work flows

One issue, one lane, one task branch: claim a lane with `tools/lane start <lane> EST-n-<slug>`, push small commits,
run `bash tools/ci.sh`, hand over with the line from `tools/lane ready`, get the CTO's approval (plus the UI Guard
or the Pulse CEO where the paths need it); the watchdog squash-merges into `main`, CI moves `staging`, and the
release decision moves `production`. The full flow, the lanes and the definition of done:
[CONTRIBUTING.md](CONTRIBUTING.md).

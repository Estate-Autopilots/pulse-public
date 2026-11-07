# infra · Deployment

How Pulse is built into containers and deployed: Dockerfiles, `docker compose` for local development and for
"anywhere else", `ea-deploy` manifests, and the notes for the local repository mode. This is `deploy/` in spec 05
§4.1.

- **Lane:** `platform` (Platform Engineer). `infra/` is a sensitive path: changes need the Pulse CEO's approval.
- **Spec:** 05 §11 (deployment: the first tenant's VPS and anywhere else), 05 §13 (security notes), ADR-0017
  (containers on the `ea-deploy` contract), ADR-0003 (PostgreSQL), ADR-0005 (tenancy).
- **Roadmap:** 07 §3 week 1 (Dockerfiles on the contract, compose for local development, nightly encrypted backups),
  week 4 (staging and production via `ea-deploy`).

## The container contract

Every deployable image: built from a `Dockerfile`, listens on port 8080, answers `GET /healthz` with 2xx when ready,
reads all configuration from environment variables (no host paths in code), logs to stdout. Settings come from the
env file on the server, never from the repository.

Today both deploy paths build **one** image from the repository root `Dockerfile`. Spec 05 §11.1 plans one image per
service (`pulse-web`, `pulse-api`, `pulse-ingest`, `pulse-worker`, `pulse-ml`, `pulse-bot`); whether `ea-deploy`
can build several images from one monorepo is the open point of ADR-0017. Until it is decided, the root
`Dockerfile` builds the first service that must be reachable (the decision belongs to the CTO and the owner), and
per-service Dockerfiles live here as `infra/docker/<service>.Dockerfile` for compose.

The root image runs the placeholder web listener on 8080, the API on loopback port 8081, ingest on loopback port
8082, and the worker. The web listener proxies `/api/*` and reports healthy only when the API health check
succeeds. `compose.dev.yaml` starts that image beside PostgreSQL 17 with pgvector and a development-only role setup;
see the root README for setup.

## Branches and environments

| Branch | Moved by | Deployed to |
|---|---|---|
| `main` | the watchdog's squash merges | nothing |
| `staging` | CI, after a `main` commit passes (fast-forward only) | pulse-staging (`127.0.0.1:4102`) |
| `production` | the release decision (Pulse CEO + owner), with tag `vX.Y.Z` | pulse (`127.0.0.1:4002`) |

**GitHub mode** (repository `Estate-Autopilots/pulse`): `.github/workflows/ci.yml` moves `staging`;
`.github/workflows/promote.yml` moves `production` and tags the release; `ea-deploy` (root, every minute) pulls both
branches, builds, health-checks, swaps and rolls back. Env files:
`/etc/estate-autopilots/apps/pulse.<staging|prod>.env`.

**Local mode** (canonical origin is the bare repository `/home/eadev/git/pulse.git`, used until GitHub is set up):
the ops layer in `ea-infrastructure/watchdog/` does the same work. `pulse_local_ci.py` (as eadev, every minute)
runs `tools/ci.sh` on every `main` and `task/*` head and moves `staging`; `pulse_local_deploy.py` (as root, every
2 minutes) builds `staging` and `production` from the root `Dockerfile`, probes the new container, swaps it in as
`pulse-<env>` and keeps the previous one on failure. Env files: `/etc/estate-autopilots/apps/pulse.<env>.env`
(`pulse.prod.env` is accepted for production).

## Definition of done

The shared checklist in [CONTRIBUTING.md](../CONTRIBUTING.md#definition-of-done), plus: the image builds from a
clean checkout, stays within the resource budget of 05 §11.1, and `docker compose up` starts the stack locally with
PostgreSQL 17 + pgvector; no secrets in any file here.

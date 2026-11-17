# services/ingest · Event ingest (FastAPI)

`POST /v1/events` (CloudEvents batches from the agent, plug-ins, edge and partners) and `POST /hooks/<source>`
(provider webhooks): signature checks, replay window, schema and registry validation, writes `raw_inbox` / `event`,
answers in under a second and never calls other services inline.

**Status (2026-10-12):** device batches (`POST /v1/events`), company plugin batches (`POST /v1/connectors/batches`,
R52 contract connector.v1, off unless `PULSE_CONNECTORS=1`: [docs/ops/CONNECTORS.md](../../docs/ops/CONNECTORS.md)) and `/healthz` are built (`src/pulse_ingest`); provider webhooks (`/hooks/<source>`) come with their collectors. Run: `pulse-ingest` (port 8080). Tests: `tests/` (no database) and `tests/core/test_ingest.py`.

- **Lane:** `platform` (Platform Engineer).
- **Spec:** 05 §4 (`ingest`), 05 §6 (event bus on PostgreSQL), 05 §8.3 (enrolment, signing and ingest protocol),
  02 §3 (event envelope and registry), appendix B and D, ADR-0002, ADR-0003.
- **Roadmap:** 07 §3 week 1 (ingest per 05 §8.3 and `/healthz`).

## Definition of done

The shared checklist in [CONTRIBUTING.md](../../CONTRIBUTING.md#definition-of-done), plus: an event with a field
outside its schema is rejected with a per-event status (and a test proves it); signature and replay-window tests;
`/healthz` on port 8080.

## Conventions

Python package (`pyproject.toml`, member of the root uv workspace; add it to `members` in the change that creates
it). Tests with pytest; CI runs them through `uv run`.

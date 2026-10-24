# packages/sdk-py · Collector SDK runtime and Python API client

The runtime every collector runs in (secrets, rate limits, cursors, raw storage, validation, consent filtering,
retries, metrics) and the Python client for the Pulse API.

**Status (2026-10-05):** built (`src/pulse_sdk`): ids, ULIDs, CIDs, registry and validation, envelope ↔ row, idempotent store, identity map, notice/consent coverage, Ed25519 signing, the collector contract (`collector.py`) and runtime (`runtime.py`), and `pulse-migrate`. The Python API client comes with the API.

- **Lane:** `platform` (Platform Engineer), shared with `data` (Data Engineer) for importers.
- **Spec:** 05 §5.1 (contract), 05 §5.2 (what the runtime guarantees), 05 §8 (APIs).
- **Roadmap:** 07 §3 week 1 (collector SDK runtime).

## pulse-admin

`pulse-admin` (`pulse_sdk/admin.py`, standard library only) calls the operator API on `http://127.0.0.1:8081`
(`--url` to change it), with the token from `PULSE_OPERATOR_TOKEN`: `init --name --slug --code --time-zone
--admin-email --admin-name` (once per install, prints the first admin's username and temporary password once),
`status [--json]`, `org set --name`, `grant|revoke --email --role admin|hr|leadership|privacy` (break-glass; the last admin cannot be revoked) and `roles [--json]`. In the image: `docker exec <container> pulse-admin …`.

## Raw store

`pulse_sdk/raw.py` (migration `0740_raw_store.sql`) keeps every original once by SHA-256, append-only: `put` (zstd
unless the format is already compressed; at most 8 MiB per PostgreSQL object), `capture` (one idempotent provenance row) and
`get` (re-checks the SHA-256). The `pg` bytes are capped database-wide in `pulse_priv.raw_store_limit` (512 MiB;
the owner raises it with an `update`). Adds the `zstandard` dependency (Python 3.12 has no stdlib zstd).
The owner-only `raw_store_usage` counter enforces the cap atomically across tenants and isolation levels. Retry
the entire transaction on PostgreSQL serialization failure (`40001`); a retry at the cap raises `RawStoreFull`.

## Definition of done

The shared checklist in [CONTRIBUTING.md](../../CONTRIBUTING.md#definition-of-done), plus: each guarantee in 05 §5.2
has a test with a fake collector.

## Conventions

Python package in the root uv workspace (add it to `members` in the change that creates its `pyproject.toml`).

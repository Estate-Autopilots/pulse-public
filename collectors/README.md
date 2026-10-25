# collectors · One package per source

Each subdirectory is a Python package built on the collector SDK (`packages/sdk-py`). Scheduled collectors implement
the SDK contract; one-shot tools can use its event validation and storage core directly. The SDK runtime does
secrets, rate limits, cursors, raw storage, validation, consent filtering, retries and metrics, so collectors only
map a source to events. Implemented: `meta_ads` (read-only S14 daily results), `gdrive_snapshot` (one-shot EA
index backfill) and `gdrive_changes` (direct Drive changes for approved roots, off by default:
[README](gdrive_changes/README.md)) and `gdrive_extract` (useful text from those roots' approved document types, off by
default: [README](gdrive_extract/README.md)). Company connectors (R52, [docs/ops/CONNECTORS.md](../docs/ops/CONNECTORS.md)):
`gdrive_changes` is EA Connect, reading each company's roots with that company's own key. Planned: `gdrive_audit`,
`gdrive_activity`, `gcal`, `gmail_meta`,
`meta_leads`, `google_ads`, `figma`, `canva`, `ops_tool`.

- **Lane:** `platform` (Platform Engineer), shared with `data` (Data Engineer) for importers.
- **Spec:** 05 §5 (collector SDK contract and guarantees), 03 S1–S5 (Workspace sensors), 03 S12–S17 (design SaaS and
  outcome sensors), appendix D (event registry).
- **Roadmap:** 07 §3 week 1 (`gdrive_changes`, `gdrive_snapshot`, `gdrive_audit` with the 180-day backfill),
  week 2 (`gdrive_activity`, `gcal`, `gmail_meta`); phase 2a Meta S14 (see [`meta_ads`](meta_ads/README.md)).

## Definition of done

The shared checklist in [CONTRIBUTING.md](../CONTRIBUTING.md#definition-of-done), plus: deterministic event ids
(re-running a window creates no duplicates); recorded-response fixtures with synthetic data; only the fields the
registry declares for the source.

## Conventions

Every subdirectory here is a Python package with its own `pyproject.toml`; `collectors/*` is a member glob of the
root uv workspace, so do not add non-package directories here.

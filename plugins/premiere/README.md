# plugins/premiere · Premiere Pro panel (UXP)

UXP panel for Premiere Pro ≥ 25.6: project and sequence events, export and render complete, the CID picker from
"my tasks" with a copy-name button, coarse edit bursts, all sent to the local agent endpoint (127.0.0.1 with the
per-install token). The `.prproj` work-delta parser is not here: it is the Rust crate `apps/desktop/core/prproj`.
Later plug-ins get sibling directories (`plugins/photoshop`, `plugins/after-effects`, `plugins/resolve`).

- **Lane:** `desktop` (Desktop Engineer).
- **Spec:** 05 §4 (`plugins`), 03 S8 (Premiere plug-in), 03 S25 (edit bursts, no hook), 10 §3.1 (plug-in bridge),
  ADR-0004.
- **Roadmap:** 07 §3 week 3 (Premiere UXP panel).

## Definition of done

The shared checklist in [CONTRIBUTING.md](../../CONTRIBUTING.md#definition-of-done), plus: the panel sends only the
fields the registry declares (appendix D); it works with the agent stopped (queues or degrades quietly, never blocks
Premiere); manifest and permissions reviewed.

## Privacy contract test

`pnpm --dir apps/desktop test` runs `tests/event-contract.test.mjs` against this panel's closed event allowlist,
`packages/schemas/generated/events.ts`, and the registered event envelope schema. The fixtures use synthetic project,
sequence, export, and count data. The contract test fails on registry field drift, unknown event types, extra data
properties, forbidden text or identity fields, and extra work-delta counts.

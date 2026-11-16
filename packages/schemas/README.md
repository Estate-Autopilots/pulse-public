# packages/schemas · JSON Schemas and code generation

The contract between the TypeScript and Python sides: the event envelope and event registry, configuration
documents (tenant config, role packs) and API payloads, with the code generation scripts for TypeScript types and
Pydantic models.

**Status (2026-10-05):** `envelope.schema.json` (appendix B), `registry.yaml` (appendix D; synced into
`pulse.event_type` by `pulse-migrate`), `fixtures/cid.json` (CID parser fixtures shared by Python and TypeScript),
and the generated code: `generated/events.ts` (TypeScript types, registry constant, `Envelope<T>`) and
`packages/sdk-py/src/pulse_sdk/generated/events.py` (Pydantic v2 models, undeclared fields forbidden). Phase 2 S14
`ads.metrics.daily` is a fully typed event. Regenerate
with `uv run pulse-codegen` in the same change as any schema edit; CI fails on stale output
(`pulse-codegen --check`).

- The tenant target document schema is `config/targets.json`; editor targets and designer single-image / brand asset windows use `doc_kind: targets` and are stored per tenant.
- The tenant delivery rules schema is `config/folder_rules.json` (JSON Schema 2020-12). Active rule documents are
  validated by `pulse_rules.folder_rules.load`; legacy 0045 keys are normalized before validation.
- **Lane:** `platform` (Platform Engineer).
- **Spec:** 05 §4 ("why two languages"), 02 §3.2 (envelope), 02 §3.4 (registry), 02 §6 (configuration as data),
  appendix B (envelope schema), appendix C (tenant config), appendix D (registry v1), appendix E (review output),
  ADR-0002, ADR-0004.
- **Roadmap:** 07 §3 week 1 (envelope incl. `app.work.delta` and `agent.commands.hourly`, registry v1, config
  schemas, codegen, deterministic event ids).

## Definition of done

The shared checklist in [CONTRIBUTING.md](../../CONTRIBUTING.md#definition-of-done), plus: generated code is
regenerated in the same change and CI fails when it is stale; schema changes are additive or carry a new version.

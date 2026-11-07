# packages/sdk-ts · TypeScript API client

The TypeScript client for the Pulse API, generated from the OpenAPI document of `services/api`. Used by web,
desktop and mobile apps.

- **Lane:** `platform` (Platform Engineer). The EST-27 v0 bootstrap is on the CEO-authorized mobile lane.
- **Spec:** 05 sections 8.1–8.2 (API style and v1 surface), ADR-0004.
- **Roadmap:** 07 section 3 week 4 (with the API endpoints the screens need).

## Current v0 bootstrap

`src/v0.ts` defines the response types and stable paths for `/api/v0/me`, `/api/v0/my-week`,
`/api/v0/pod-board`, and `/api/v0/leadership-week`. `src/v0-fixtures.ts` contains fabricated examples only.
Every aggregate count carries rule, source, and sample-file evidence. The endpoint implementation and generated
OpenAPI client follow as the delivery read-model contract lands.

## Definition of done

The shared checklist in [CONTRIBUTING.md](../../CONTRIBUTING.md#definition-of-done), plus:

- the OpenAPI document (`services/api/openapi/`) is the contract and is regenerated in the same change;
- `packages/sdk-ts` follows;
- every endpoint has a cross-tenant test (a second synthetic tenant sees nothing) and a visibility test;
- every read of personal data is written to the access log.

## Local run

From the repository root, run `pnpm --filter @pulse/sdk-ts test` for the synthetic v0 fixture and explanation
contract tests. Run `pnpm --filter @pulse/sdk-ts typecheck` to verify the generated-client type boundary.

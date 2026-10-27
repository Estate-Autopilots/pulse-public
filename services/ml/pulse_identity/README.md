# Pulse identity attribution · v0

This pure package maps a synthetic Drive event actor to a person using only the actor account ID, time-valid account
links, and event-specific person declarations. It is separate from `pulse_workers.resolver`, which uses render,
export, CID, and other work evidence to attribute a delivered version.

## Precedence

1. Conflicting declarations (multiple owners, or one person both owning and rejecting) stay unresolved.
2. Conflicting active links stay unresolved: this includes multiple verified individual links to different people,
   and a shared link coexisting with a verified individual link for the same actor.
3. A verified active individual link resolves only when no active individual link or event declaration contradicts
   that person. A linked person's `not_mine` or an `owns` declaration naming someone else stays unresolved.
4. A single event-specific `owns` declaration may resolve a missing, unlinked, shared, or unverified actor when it
   does not conflict with an active individual link.
5. A shared account never resolves by itself. Missing, unlinked, or unverified actors without a usable declaration
   stay unresolved. Results include a reason and opaque evidence IDs.

Resolved results carry the matched person, method, evidence, and confidence (`1.0` for a verified link or explicit
declaration). Unresolved results have no person or confidence; they carry a reason and any relevant evidence,
including the event ID when the actor is missing.

## Limits

- `1.0` expresses a verified identity link or an explicit self-declaration; it is not an empirically calibrated
  likelihood for authorship of a file.
- The resolver does not infer identity from names, email text, filenames, checksums, exports, devices, or work
  patterns. Those signals belong to the separate delivery-attribution resolver or a human review.
- The caller supplies opaque account/person/evidence IDs and verified link validity intervals. This package does not
  read Drive, merge identities, or write to a database.
- This is the pure reference rules package; it is not wired into the live projector. The database-backed account to
  person lookup is `pulse_sdk.identity.IdentityMap`. When no time-valid `identity_link` exists, `IdentityMap` falls
  back to `account.holder_person_id` without requiring a verified link. Event declaration handling remains in
  `pulse_workers.workgraph`; it applies `attribution.confirmed` and `attribution.rejected` from the event log, where
  a later confirmation can replace an earlier declaration for the delivery.

Version: `identity-attribution/v0`.

## Delivery signal aggregation v1

`aggregate_signals(candidates, signals)` is a separate pure API for normalized delivery-attribution evidence. Each
signal carries only an eligible candidate ID, an opaque evidence ID, and one of `render_hash`, `export`,
`work_delta`, or `chain_match`; candidate priors are supplied as odds. It does not collect evidence, infer candidates,
or persist results.

Signals use the starting likelihood ratios from 02 §4.3 / 03 §9.4: render hash 1,000, export 50, work delta 10,
and chain match 30. Render hash and export each have their own group. Work delta and chain match share
`project_work`; only the largest ratio in that group is multiplied, while all evidence IDs remain in the result.
Group ratios multiply the candidate's prior odds. Probabilities normalize those posterior odds together with a
unit-mass “nobody in the candidate set” alternative. Missing signals have LR 1 and never lower a candidate's odds.

Multiple candidates with positive evidence always produce `conflict`, even if one score is much higher; no evidence
or score magnitude silently overrides that disagreement. With evidence for one candidate, posterior ≥ 0.95 is
`automatic`, ≥ 0.60 and < 0.95 is `confirmation_required`, and < 0.60 is `claim_required`. Missing evidence produces
`missing_evidence` with no confidence, regardless of candidate priors. Results include candidate probabilities,
group contributions, evidence IDs, status, and a reason string.

Version: `delivery-attribution-signals/v1` (starting ratios and thresholds are not pilot-calibrated).

Run the synthetic fixture suite with:

```sh
uv run --directory services/ml/pulse_identity pytest -q
```

# services/ml · Models (scores, benchmarks, coach)

Model jobs on their own queue: attribution resolver, benchmark updater, delivery score and prediction, outcome
model, transcription, and the coach review pipeline (draft + script + persona + brand → notes). Evaluation sets and
runners live in `eval/` here (pointers and hashes only, never personal data in git).

`pulse_identity/` contains the pure reference `identity-attribution/v0` resolver. It resolves an event actor from a
verified, time-valid individual-account link or a single event-specific ownership declaration; it does not inspect
file hashes, exports, or persist results. The same package provides a pure v1 delivery-signal aggregator over
normalized render-hash, export, work-delta and chain-match evidence; it groups correlated work signals and leaves
multi-candidate conflicts unresolved. Neither API is wired into the live projector. See its README for precedence,
thresholds, runtime differences, and limits.

`pulse_rules/` contains deterministic v1 delivery-detection rules: CID and legacy-name parsing, configured folder
classification, and candidate-delivery explanations. It does not confirm attribution or client delivery; see its
README for version and limits.

- **Lane:** `intel` (Intelligence Engineer).
- **Spec:** 05 §4 (`ml`), 04 (all models; governance in 04 §2; M2 coach, M3 benchmarks, M4 delivery score,
  M9 edit work units), 05 §10 (LLM gateway), appendix E (review output schema), ADR-0008, ADR-0009, ADR-0011.
- **Roadmap:** 07 §3 week 2 (resolver v0, delivery scores with explanations), week 3 (resolver v1), week 4 (coach
  pipeline v1 and calibration metrics).

## Definition of done

The shared checklist in [CONTRIBUTING.md](../../CONTRIBUTING.md#definition-of-done), plus: a model ships only
through its evaluation gate (04 §2, 04 M2.5 for the coach) with the metrics in the review request; every score
carries its explanation, confidence and sufficiency (04 M4.3); LLM calls go through the gateway with a budget cap.

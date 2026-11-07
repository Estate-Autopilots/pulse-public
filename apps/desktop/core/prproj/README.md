# apps/desktop/core/prproj · Premiere project work-delta parser (Rust)

Streaming parser for Premiere Pro `.prproj` files (gzip XML) that turns two saves of a project into a work delta:
counts of clips, cuts, markers, effects and keyframes per sequence, never names, text or media paths. Mapped
extractor first, histogram fallback for unknown structures; baseline rule for the first save.

- **Lane:** `desktop` (Desktop Engineer).
- **Spec:** 03 S24 (work delta engine), 04 M9 (edit work units), 03 §9.4 (one confidence score),
  ADR-0018; event `app.work.delta` per appendix B and D.
- **Roadmap:** 07 §3 week 3 (work delta engine v1, Premiere 26.x fixtures).

## Definition of done

The shared checklist in [CONTRIBUTING.md](../../../../CONTRIBUTING.md#definition-of-done), plus: matches the
hand-counted fixtures (≥ 98% clips/cuts/markers, ≥ 95% effects/keyframes, 07 §3 week 3 acceptance); fixtures are
synthetic projects with no client media or names.

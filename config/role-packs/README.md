# config/role-packs · Neutral role-pack templates

Company-neutral role packs as data (`video_editor`, `graphic_designer`, …): deliverable types with codes, families,
unit weights and milestones, definition of done, benchmark and quality-rubric references, blocker rules, signals,
the desktop app → category map and nudge rules. A tenant copies and adapts them in its own configuration; nothing
tenant-specific is committed here.

- **Lane:** `intel` (Intelligence Engineer).
- **Spec:** 02 §6 (configuration as data, `role_pack/<role>`), 04 M3 (benchmarks), 04 M9.2 (edit work units),
  appendix C (tenant config example), ADR-0001, ADR-0007.
- **Roadmap:** 07 §2 item 0.6 (benchmark session), 07 §3 weeks 1–2 (tenant bootstrap, rules).

## Definition of done

The shared checklist in [CONTRIBUTING.md](../../CONTRIBUTING.md#definition-of-done), plus: every pack validates
against its schema in `packages/schemas`; no company names, people or client data.

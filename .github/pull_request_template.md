<!-- Title: "EST-n: what changed". One issue, one lane, one branch (CONTRIBUTING.md). -->

## Issue

- Issue: EST-
- Lane: <!-- platform | web | desktop | intel | mobile | qa -->
- Branch: `task/<lane>/EST-n-<slug>`

## What and why

<!-- What changed, why, and which spec sections it implements (e.g. 05 §8.3, 07 §3 week 1). -->

## Evidence

<!-- `tools/ci.sh` summary, tests added or changed, commands run, metrics for model changes. -->

## Screenshots (UI changes)

<!-- Narrow and wide, light and dark. Delete this section when no UI path changed. -->

## Checklist

- [ ] `tools/lane ready --ci` printed `Ready for review: EST-n @ <sha7>` for the head commit
- [ ] New behaviour has tests; fixtures are synthetic (no personal or client data)
- [ ] No secrets (`tools/check-secrets.sh --all`); no new field leaves a device or tenant beyond appendix B / D
- [ ] READMEs updated where purpose, layout or commands changed
- [ ] UI paths touched: screenshots attached, UI Guard approval requested
- [ ] Sensitive paths touched (`.github/`, `infra/`, `tools/lane`, `tools/ci.sh`, `db/roles`, `privacy/`): Pulse CEO approval requested

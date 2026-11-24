# PM view-model contract

- `shared.ts` holds the types every screen shares (Person, ProjectRef, Health, StepStatus, LateFlag, Clock, Phase,
  StepRow, Viewer, IsoDate, ScreenProps). Do not edit it from a screen lane; ask the lead.
- Each screen builder adds **`contract/<slug>.ts`** with its own view model (`export type <Name>VM = { … }`), built
  from the shared types. Carry `today: IsoDate` and `viewer: Viewer` in every VM that shows dates or actions.
- Convention (the preview route depends on it, no registry):
  - `screens/<slug>.tsx` default-exports the screen: `export default function X({ vm }: ScreenProps<XVM>)`.
  - `fixtures/<slug>.ts` exports `states: Record<string, XVM>`; the first key is the default state.
  - Preview: `/projects/pm/preview/<slug>?state=<key>` (dev only); index at `/projects/pm/preview`.

Screen slugs (PICKS.md ids without the number):
`projects-home`, `project-detail`, `phase-board`, `my-day`, `approvals`, `client-view`, `template-picker`,
`setup-wizard`, `team-workload`, `step-detail`, `clock-move`, `client-inputs`, `weekly-update`, `quote-to-project`,
`goals`, `notifications`, `role-map`, `timeline`, `first-run`. Plus `kit` (the kit gallery).

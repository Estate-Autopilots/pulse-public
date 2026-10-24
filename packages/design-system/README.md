# AC design system (`@pulse/design-system`)

One library for every AC app (Pulse, Sales X-Ray, the sites). Improve a component here and every app changes with it.

| Tier | What | Where |
|---|---|---|
| 0 Tokens | Colour (`--theme-*`, themed per organisation), scales (`--ds-*`: type, space, radius, density, elevation, motion, category hues) | `src/tokens.css`, `src/scale.css` |
| 1 Primitives | Button, IconButton, IconTile, Tag | `src/ui` |
| 2 Components | Card, Section, Tabs (icons, counts), Stat, StatStrip, List, ListRow, EmptyState | `src/ui` |
| 3 Patterns | Page header, desk layout, filter bar (next) | apps first, then here |
| Theme | `themeCss({ accent, roundness, density })`, `colourFromImage(logo)`, `textOn(colour)` | `src/theme.ts` |

Rules: components read only tokens; one primary button per view; tabs carry an icon and are five at most; a category
keeps its hue (`indigo green sky amber pink teal orange slate`) in every app. An app wraps its root once in
`<DsProvider link={its Link}>`. The living catalogue is Pulse's `/kit`.

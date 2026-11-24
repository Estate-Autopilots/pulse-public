# Third-party code and design sources

Libraries bundled into Pulse (Vitals OS) that need a note beyond `pnpm-lock.yaml`, and the open-source work whose
patterns a feature follows. Only MIT, Apache-2.0 or BSD licences are allowed in the product.

## The one calendar (`apps/web/app/kit/calendar`, FIX-PR-CALENDAR, 10 Nov 2026)

| Library | Version | Licence | Used for |
|---|---|---|---|
| [@fullcalendar/core, daygrid, timegrid, list, interaction, react](https://github.com/fullcalendar/fullcalendar) (FullCalendar standard) | 6.1.22 | MIT | Month, week, day and list views of PR posts, meetings, leave and task due dates; drag to move, drop from a tray |

Only FullCalendar's MIT standard packages are used; its premium plugins (resource timeline etc., commercial licence) are not.

## Dependency map (`apps/web/app/tasks/map`, BLOCKERS-MAP, 7 Nov 2026)

| Library | Version | Licence | Used for |
|---|---|---|---|
| [@xyflow/react](https://github.com/xyflow/xyflow) (React Flow) | 12.12.0 | MIT | Rendering the graph: custom cards, smooth-step edges, zoom and pan (pinch on phones), minimap, controls |
| [@dagrejs/dagre](https://github.com/dagrejs/dagre) | 3.1.1 | MIT | Left-to-right layered layout (network-simplex ranking, crossing reduction) |
| [@dagrejs/graphlib](https://github.com/dagrejs/graphlib) | 4.0.5 (via dagre) | MIT | dagre's graph structure |

Considered and rejected: **elkjs** (EPL-2.0 OR GPL-3.0-or-later, not an allowed licence, and about 8 MB unpacked).
Plane (AGPL-3.0) and Huly (EPL-2.0) were looked at for ideas only; no code was taken from them.

Patterns followed (no code copied):
- React Flow's dagre layout example (https://reactflow.dev/examples/layout/dagre): lay out with dagre, then render.
- Nx project graph (https://nx.dev/docs/features/explore-graph, MIT): focus one item and show only what leads to it.
- GitLab pipeline DAG design (gitlab-org/gitlab issues 262669 and 249135): hovering an item lights its whole chain,
  upstream and downstream, and dims the rest.
- Dagster and Airflow (Apache-2.0) asset/task graphs: a coloured status rail on each card.
- dependency-cruiser and madge (MIT): left-to-right layers, colour by state.

The critical path (longest chain of unfinished work) and the focus sets are our own code in `apps/web/app/lib/dep-graph.mjs`.

## AI app logos on Connect your AI (`apps/web/public/brand-ai`, FIX-AI-EMPLOYEES, 10 Nov 2026)

| File | From | Licence of the file | Mark owned by |
|---|---|---|---|
| `claude.svg` | [lobe-icons](https://github.com/lobehub/lobe-icons) `@lobehub/icons-static-svg` 1.102.0, `claude-color.svg` | MIT | Anthropic |
| `chatgpt.svg` | the same package, `openai.svg` (the OpenAI mark, drawn in one colour) | MIT | OpenAI |
| `gemini.svg` | the same package, `gemini-color.svg` | MIT | Google |

The artwork is unchanged; only the `1em` sizing was swapped for a 24 px box so the files work as images. The MIT
licence covers the SVG files, not the marks: the logos are trademarks of their owners and are shown only to say which
app a person connects (nominative use). Brand rules the screen keeps: each mark as published, never recoloured,
stretched, rotated or given effects; on a plain white plate with clear space around it (also in dark mode); always
beside the product's own name ("Claude", "ChatGPT", "Gemini"); never bigger than our own brand; no words suggesting
the companies made, partner with or endorse Vitals; and a line on the screen naming the owners.

## QR codes for Telegram set-up (`apps/web/app/lib/qr-code.mjs`, AI-AGENTS-3, 17 Nov 2026)

| Library | Version | Licence | Used for |
|---|---|---|---|
| [qrcode](https://github.com/soldair/node-qrcode) | 1.5.4 | MIT | The QR code a phone scans to link Telegram (`t.me/<bot>?start=<one-time code>`), drawn as one SVG path from its module matrix |
| [jsQR](https://github.com/cozmo/jsQR) (dev only) | 1.4.0 | Apache-2.0 | Tests only: reads back what is drawn (unit test and the browser walk), so a phone's camera gets the same link |

`apps/web/app/lib/qr.mjs` (PRESENCE-ONBOARD's own encoder for install links) is unchanged.

## Charts on Insights (`apps/web/app/telemetry/insights`, TOKENS-TELEMETRY, 17 Nov 2026)

| Library | Version | Licence | Used for |
|---|---|---|---|
| [echarts](https://github.com/apache/echarts) (Apache ECharts) | 6.1.0 | Apache-2.0 | The journey map (Sankey), funnels, speed and struggle over time, AI cost per kind of work; tree-shaken (`echarts/core` with only the charts used) and loaded only on the Insights screen |
| [zrender](https://github.com/ecomfe/zrender) | 6.1.0 (via echarts) | BSD-3-Clause | ECharts' canvas renderer |
| [tslib](https://github.com/microsoft/tslib) | 2.3.0 (via echarts) | 0BSD | TypeScript helpers ECharts is built with |

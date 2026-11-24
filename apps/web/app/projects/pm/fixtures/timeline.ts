// PM-UI 18 Timeline fixtures (sheets/timeline.md): Orchid Towers launch, today Sat 21 Nov 2026, signed in as Kavya Rao
// (Growth lead, the project's lead). All from canon: the nine phases and their dates, the three clocks.
import type { TimelinePhase, TimelinePhaseIcon, TimelineStatus, TimelineVM } from "../contract/timeline";
import { TODAY, orchid, orchidClocks, orchidPhases, projects, viewer } from "./canon";

const P = projects.orchid;
const base = `/projects/${P.id}`;

/** Row status and icon per phase (sheet §3): Shoot is due 24 Nov, so today it is Doing, not Late; CRM setup waits on
 *  the client (hatched bar); everything after Today is To do. */
const look: Record<string, [TimelineStatus, TimelinePhaseIcon]> = {
  "ph-kickoff": ["done", "flag"],
  "ph-blueprint": ["done", "layers"],
  "ph-shoot": ["doing", "video"],
  "ph-creative": ["todo", "image"],
  "ph-landing": ["todo", "laptop"],
  "ph-crm": ["waiting_client", "database"],
  "ph-training": ["todo", "users"],
  "ph-review": ["todo", "check"],
  "ph-adslive": ["todo", "megaphone"],
};

const phases: TimelinePhase[] = orchidPhases.map((phase) => {
  const [status, icon] = look[phase.id];
  return { phase, status, icon, href: `${base}/board?view=list&phase=${phase.id}` };
});

const base_: TimelineVM = {
  today: TODAY,
  viewer: viewer("kavya"),
  project: P,
  city: orchid.city,
  health: { key: "at_risk", reason: "shoot moved 3 days" },
  backHref: "/projects",
  viewHrefs: { list: `${base}/board?view=list`, board: `${base}/board?view=board`, timeline: `${base}/timeline` },
  actions: {
    reschedule: { label: "Reschedule", href: `${base}/clocks` },
    update: { kind: "update_progress", label: "Update progress", href: `${base}/update` },
  },
  range: { start: "2026-11-11", days: 56 },
  clocks: orchidClocks,
  phases,
  selectedPhaseId: null,
};

export const states: Record<string, TimelineVM> = {
  default: base_,
  "phase-shoot": { ...base_, selectedPhaseId: "ph-shoot" },
  loading: { ...base_, clocks: null, phases: null },
};

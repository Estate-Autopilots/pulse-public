// PM-UI 01 Projects home fixtures (sheets/projects-home.md §3–4). Signed in: Kavya Rao, Growth lead. Today Sat 21 Nov 2026.
import type { ProjectCardVM, ProjectsHomeVM } from "../contract/projects-home";
import type { Health, Phase, ProjectRef, StepRow } from "../contract/shared";
import { TODAY, addDays, clocksAt, lineOf, orchidClocks, people, phasesAt, projects, viewer } from "./canon";

// Health reasons drop the day count the Next line already says ("Late · 4 days", "Client late · 3 days").
// Lead decisions (22 Nov) name these clients; canon.ts still says "Marigold Land Co." and "Sunpeak Realty".
const marigold: ProjectRef = { ...projects.marigold, client: "Marigold Estates" };
const sunpeak: ProjectRef = { ...projects.sunpeak, client: "Sunpeak Developers" };

const next = (project: ProjectRef, phase: Phase, s: Partial<StepRow> & Pick<StepRow, "id" | "title" | "owner" | "due">): StepRow =>
  ({ project, phase: { id: phase.id, name: phase.name }, status: "todo", mine: s.owner?.id === people.kavya.id, ...s });

const card = (project: ProjectRef, health: Health, current: number, day: number, step: (phase: Phase) => StepRow, lastActivityDaysAgo = 0): ProjectCardVM => {
  const phases = phasesAt(current);
  const clocks = project.id === projects.orchid.id ? orchidClocks : clocksAt(day);
  return { project, href: `/projects/${project.id}`, health, phases, next: step(phases[current - 1]), clock: lineOf(clocks), lastActivity: addDays(TODAY, -lastActivityDaysAgo), mine: true };
};

const cards: ProjectCardVM[] = [
  card(marigold, { key: "late", reason: "launch video" }, 4, 12,
    (ph) => next(marigold, ph, { id: "s-mg-edit", title: "Edit launch video", owner: people.rifob, due: "2026-11-17", status: "doing", late: { days: 4, who: "team" } }), 1),
  card(projects.orchid, { key: "at_risk", reason: "shoot moved 3 days" }, 3, 0,
    (ph) => next(projects.orchid, ph, { id: "s-plan", title: "Approve shoot plan", owner: people.kavya, due: TODAY })),
  card(projects.cedar, { key: "at_risk", reason: "shoot locations has no owner" }, 3, 2,
    (ph) => next(projects.cedar, ph, { id: "s-cc-loc", title: "Plan shoot locations", owner: null, due: "2026-11-23" }), 2),
  card(projects.bluewater, { key: "waiting_client", reason: "landing page" }, 5, 17,
    (ph) => next(projects.bluewater, ph, { id: "s-bw-lp", title: "Client approval: landing page (v2)", owner: people.kavya, due: "2026-11-18", status: "waiting_client", needsClientApproval: true, late: { days: 3, who: "client" } }), 3),
  card(sunpeak, { key: "on_track" }, 7, 32,
    (ph) => next(sunpeak, ph, { id: "s-sp-sales", title: "Sales alignment session", owner: people.kavya, due: "2026-11-24" }), 1),
  card(projects.palm, { key: "on_track" }, 6, 25,
    (ph) => next(projects.palm, ph, { id: "s-pg-route", title: "Set up lead routing", owner: people.dev, due: "2026-11-26" }), 2),
];

const base: ProjectsHomeVM = {
  today: TODAY,
  viewer: viewer("kavya"),
  filters: [
    { key: "mine", label: "Mine", href: "/projects?filter=mine" },
    { key: "at_risk", label: "At risk", count: 2, href: "/projects?filter=at-risk" },
    { key: "waiting_client", label: "Waiting on client", count: 1, href: "/projects?filter=waiting" },
    { key: "quiet", label: "Quiet (14 days)", href: "/projects?filter=quiet" },
    { key: "all", label: "All", count: 152, href: "/projects?filter=all" },
  ],
  filter: "mine",
  query: "",
  projects: cards,
  newProject: { label: "New project", href: "/projects/new" },
};

export const states: Record<string, ProjectsHomeVM> = {
  default: base,
  "filter-at-risk": { ...base, filter: "at_risk" },
  "filter-waiting": { ...base, filter: "waiting_client" },
  "filter-quiet-empty": { ...base, filter: "quiet" },
  "search-none": { ...base, query: "harbour" },
  loading: { ...base, projects: [], loading: true },
};

// PM-UI 15 Goals fixtures (sheets/goals.md §3–4). Signed in: Kavya Rao, Growth lead. Today Sat 21 Nov 2026.
// No money goal (the pick's "Bill ₹1.5 Cr" breaks the no-₹ rule): goal 2 is the weekly-update goal. Each project once.
import type { GoalsVM, GoalVM } from "../contract/goals";
import type { ProjectRef } from "../contract/shared";
import { TODAY, people, projectList, projects, team, viewer } from "./canon";

// Lead decisions (22 Nov) name these clients; canon.ts still says "Marigold Land Co." and "Sunpeak Realty".
const marigold: ProjectRef = { ...projects.marigold, client: "Marigold Estates" };
const sunpeak: ProjectRef = { ...projects.sunpeak, client: "Sunpeak Developers" };

const goals: GoalVM[] = [
  {
    id: "g-launches", title: "9 launches live by 31 Dec", icon: "rocket",
    measure: { kind: "count", done: 7, of: 9 },
    health: { key: "on_track" }, owner: people.dev, projects: [sunpeak, projects.palm],
  },
  {
    id: "g-updates", title: "Weekly update on every project", icon: "clipboard-check",
    measure: { kind: "count", done: 4, of: 6, note: "this week" },
    health: { key: "at_risk", reason: "2 updates missing" }, owner: people.kavya, projects: [projects.orchid, projects.cedar],
  },
  {
    id: "g-approval", title: "Client approval in under 2 days", icon: "clock",
    measure: { kind: "days", value: 2.6, target: 2 },
    health: { key: "late", reason: "approvals take longer" }, owner: people.tara, projects: [projects.bluewater, marigold],
  },
];

const base: GoalsVM = {
  today: TODAY,
  viewer: viewer("kavya"),
  period: { label: "This quarter", start: "2026-10-01", end: "2026-12-31" },
  goals,
  addGoal: {
    label: "Add goal",
    periods: [{ key: "2026-q4", label: "This quarter · Oct–Dec 2026" }, { key: "2027-q1", label: "Next quarter · Jan–Mar 2027" }],
    people: team,
    projects: projectList.map((p) => (p.id === marigold.id ? marigold : p.id === sunpeak.id ? sunpeak : p)),
    action: "/projects/goals/new",
  },
};

export const states: Record<string, GoalsVM> = {
  default: base,
  empty: { ...base, goals: [] },
  "add-goal": { ...base, sheetOpen: true },
  loading: { ...base, goals: [], loading: true },
};

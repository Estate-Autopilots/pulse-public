// PM-UI: fixtures of the kit gallery, all from canon (Sat, 21 Nov 2026; Orchid Towers launch in its Shoot phase).
import type { KitVM } from "../contract/kit";
import type { StepRow } from "../contract/shared";
import { AGENCY, TODAY, addDays, clockLine, lineOf, clocksAt, orchidClocks, orchidPhases, people, projectList, projects, team, viewer } from "./canon";

const shoot = { id: "ph-shoot", name: "Shoot" };
const step = (s: Partial<StepRow> & Pick<StepRow, "id" | "title" | "status">): StepRow =>
  ({ project: projects.orchid, phase: shoot, owner: people.rifob, due: null, mine: false, ...s });

const steps: StepRow[] = [
  step({ id: "s-brief", title: "Finalise shoot brief", status: "done", owner: people.rifob, due: "2026-11-18" }),
  step({ id: "s-plan", title: "Approve shoot plan", status: "in_review", owner: people.rifob, reviewer: people.kavya, toReview: true, due: TODAY, round: { version: 2, round: 2, maxRounds: 3 } }),
  step({ id: "s-run", title: "Run the shoot", status: "doing", owner: people.rifob, due: "2026-11-23" }),
  step({ id: "s-raw", title: "Share raw footage", status: "todo", owner: people.rifob, due: "2026-11-24" }),
  step({ id: "s-edit", title: "Edit launch video", status: "blocked", owner: people.ira, due: "2026-11-28", blockedBy: "Share raw footage", phase: { id: "ph-creative", name: "Creative assets" } }),
  step({ id: "s-sheet", title: "Brand sheet", status: "changes", owner: people.tara, mine: false, due: "2026-11-19", late: { days: 2, who: "team" }, phase: { id: "ph-blueprint", name: "Brand blueprint" }, round: { version: 3, round: 3, maxRounds: 3 } }),
  step({ id: "s-plans", title: "Floor plans from the client", status: "waiting_client", owner: people.kavya, due: "2026-11-19", late: { days: 2, who: "client" } }),
  step({ id: "s-drone", title: "Drone permit", status: "skipped", owner: people.kavya, due: "2026-11-20" }),
];

const base: KitVM = {
  today: TODAY,
  viewer: viewer("kavya"),
  agency: AGENCY.name,
  projects: projectList,
  healths: [
    { key: "late", reason: "Ads live date passed" },
    { key: "at_risk", reason: "shoot moved 3 days" },
    { key: "waiting_client", reason: "floor plans, 4 days" },
    { key: "on_track" },
    { key: "not_started", reason: "Starts when invoice is paid" },
    { key: "needs_setup", reason: "no lead yet" },
    { key: "paused", reason: "client asked to hold" },
    { key: "done", reason: "ads live 5 Jan" },
  ],
  phases: orchidPhases,
  phasesLate: orchidPhases.map((p) => (p.isCurrent ? { ...p, status: "late" as const } : p)),
  clocks: orchidClocks,
  clockLines: [
    { label: "Orchid Towers today (Day 0)", line: lineOf(orchidClocks) },
    { label: "Another project, Day 12", line: lineOf(clocksAt(12)) },
    { label: "Before Day 0", line: clockLine({ key: "inputs_complete", label: "Day 0", planned: "2026-11-24" }, { key: "ads_live", label: "Ads live", planned: "2027-01-08" }) },
    { label: "Target passed", line: clockLine({ key: "inputs_complete", label: "Day 0", actual: addDays(TODAY, -48) }, { key: "ads_live", label: "Ads live", planned: addDays(TODAY, -3) }) },
    { label: "No dates yet", line: clockLine(undefined, undefined) },
  ],
  people: team,
  steps,
  lates: [{ days: 1, who: "team" }, { days: 2, who: "team" }, { days: 2, who: "client" }],
  rounds: [{ version: 1, round: 1, maxRounds: 3 }, { version: 2, round: 2, maxRounds: 3 }, { version: 4, round: 4, maxRounds: 3 }],
  nextStep: steps[1],
  cardNext: steps[2],
  cardHealth: { key: "waiting_client", reason: "floor plans, 4 days" },
  sheetOpen: false,
  bare: false,
};

export const states: Record<string, KitVM> = {
  gallery: base,
  sheet: { ...base, sheetOpen: true },
  client: { ...base, viewer: viewer("ahoro"), bare: true },
};

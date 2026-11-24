// PM-UI: fixtures of the project page (sheets/project-detail.md §3–4), all from canon: Sat, 21 Nov 2026, Orchid Towers
// launch on Day 0, in its Shoot phase. States: default (Kavya), as-rifob, phase-creative-assets, needs-setup.
import type { PhaseSteps, ProjectDetailVM, StepListItem } from "../contract/project-detail";
import type { Clock, Person, StepRow } from "../contract/shared";
import { TODAY, lineOf, orchid, orchidClocks, orchidPhases, people, projects, viewer, type PersonKey } from "./canon";

const P = projects.orchid;
const base = `/projects/${P.id}`;
const stepHref = (id: string) => `${base}/steps/${id}`;
const shoot = { id: "ph-shoot", name: "Shoot" };
const creative = { id: "ph-creative", name: "Creative assets" };

type Raw = Pick<StepRow, "id" | "title" | "status" | "due"> & { owner: PersonKey; phase?: StepRow["phase"]; late?: StepRow["late"]; reviewer?: PersonKey };
/** A step as the signed-in person `me` sees it (mine / toReview follow from who is looking). */
const step = (me: PersonKey, r: Raw): StepRow => ({
  id: r.id, title: r.title, project: P, phase: r.phase ?? shoot, status: r.status, owner: people[r.owner], due: r.due,
  ...(r.late ? { late: r.late } : {}),
  ...(r.reviewer ? { reviewer: people[r.reviewer], toReview: r.reviewer === me && r.status === "in_review" } : {}),
  mine: r.owner === me,
});

/** Shoot · 12 steps: the first 7 by due date (sheet §3 E). */
const SHOOT: Raw[] = [
  { id: "s-brief", title: "Write shoot brief", owner: "zoya", due: "2026-11-18", status: "done" },
  { id: "s-models", title: "Model shortlist (v2)", owner: "tara", due: "2026-11-19", status: "waiting_client", late: { days: 2, who: "client" } },
  { id: "s-crew", title: "Book shoot crew", owner: "rifob", due: "2026-11-19", status: "doing", late: { days: 2, who: "team" } },
  { id: "s-locations", title: "Lock locations and permits", owner: "kavya", due: "2026-11-20", status: "done" },
  { id: "s-plan", title: "Shoot plan", owner: "rifob", reviewer: "kavya", due: "2026-11-21", status: "in_review" },
  { id: "s-moodboard", title: "Shoot moodboard (v2)", owner: "tara", reviewer: "dev", due: "2026-11-21", status: "in_review" },
  { id: "s-day1", title: "Shoot day 1: exteriors", owner: "rifob", due: "2026-11-23", status: "todo" },
];
/** Creative assets · 25 Nov–4 Dec: nothing started yet. */
const CREATIVE: Raw[] = [
  { id: "c-video", title: "Edit launch video", owner: "rifob", due: "2026-11-27", status: "todo", phase: creative },
  { id: "c-ads", title: "Design ad set 1", owner: "tara", due: "2026-11-28", status: "todo", phase: creative },
  { id: "c-copy", title: "Write ad copy", owner: "zoya", due: "2026-11-28", status: "todo", phase: creative },
  { id: "c-reel", title: "Cut site visit reel", owner: "ira", due: "2026-12-01", status: "todo", phase: creative },
];

/** The lists as `me` sees them: `nextId` is tinted; `actions` gives a row button to steps `me` owns. */
function lists(me: PersonKey, nextId: string, actions: Record<string, StepListItem["action"]> = {}): PhaseSteps[] {
  const item = (r: Raw): StepListItem => ({ step: step(me, r), href: stepHref(r.id), ...(r.id === nextId ? { isNext: true } : {}), ...(actions[r.id] ? { action: actions[r.id] } : {}) });
  return [
    { phaseId: shoot.id, total: 12, items: SHOOT.map(item), seeAllHref: `${base}/board?phase=${shoot.id}` },
    { phaseId: creative.id, total: CREATIVE.length, items: CREATIVE.map(item) },
  ];
}

const team = (keys: PersonKey[]): ProjectDetailVM["team"] => keys.map((k) => ({ role: people[k].role, person: people[k] as Person }));

const kavya: ProjectDetailVM = {
  today: TODAY,
  viewer: viewer("kavya"),
  backHref: "/projects",
  project: { ...P, city: orchid.city, lead: people.kavya, health: { key: "at_risk", reason: "shoot moved 3 days" } },
  menu: [
    { key: "settings", label: "Project settings", href: `${base}/settings` },
    { key: "share", label: "Share client view", href: `${base}/share` },
    { key: "archive", label: "Archive", href: `${base}/archive`, danger: true },
  ],
  planReady: true,
  setupHref: `/projects/new?project=${P.id}`,
  next: {
    step: { ...step("kavya", SHOOT[4]), title: "Approve shoot plan" },
    primary: { kind: "approve", label: "Approve", href: stepHref("s-plan") },
    openHref: stepHref("s-plan"),
  },
  clockLine: lineOf(orchidClocks),
  phases: orchidPhases,
  selectedPhaseId: shoot.id,
  phaseSteps: lists("kavya", "s-plan"),
  phaseHref: `${base}?phase={phase}`,
  views: { list: base, board: `${base}/board`, timeline: `${base}/timeline` },
  clocks: orchidClocks,
  clockHref: `${base}/clocks/{clock}`,
  team: team(["kavya", "rifob", "tara", "zoya", "dev"]),
};

const rifob: ProjectDetailVM = {
  ...kavya,
  viewer: viewer("rifob"),
  menu: kavya.menu.filter((m) => m.key === "share"),
  next: {
    step: step("rifob", SHOOT[2]),
    primary: { kind: "mark_done", label: "Mark done", href: stepHref("s-crew") },
    openHref: stepHref("s-crew"),
  },
  phaseSteps: lists("rifob", "s-crew", { "s-day1": { kind: "start", label: "Start", href: stepHref("s-day1") } }),
  clockHref: undefined,
};

const unset: Clock[] = orchidClocks.map((c) => ({ key: c.key, label: c.label, planned: null, actual: null }));

export const states: Record<string, ProjectDetailVM> = {
  default: kavya,
  "as-rifob": rifob,
  "phase-creative-assets": { ...kavya, selectedPhaseId: creative.id },
  "needs-setup": {
    ...kavya,
    project: { ...kavya.project, health: { key: "needs_setup", reason: "no role map yet" } },
    planReady: false,
    next: null,
    clockLine: lineOf(unset),
    phases: [],
    selectedPhaseId: null,
    phaseSteps: [],
    clocks: unset,
    team: team(["kavya"]),
  },
};

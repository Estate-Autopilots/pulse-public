// PM-UI 03 Phase board fixtures (sheets/phase-board.md): Orchid Towers launch, phase Shoot, today Sat 21 Nov 2026,
// signed in as Tara Nair (Designer; the "Send to client" button is hers). All from canon.
import type { PhaseBoardVM, PhaseGroup } from "../contract/phase-board";
import type { IsoDate, Person, Phase, StepRow, StepStatus } from "../contract/shared";
import { TODAY, daysBetween, lineOf, orchidClocks, orchidPhases, people, projects, viewer } from "./canon";

const P = projects.orchid;
const base = `/projects/${P.id}`;
const me = people.tara;

type Row = { id: string; title: string; status: StepStatus; owner: Person; due: IsoDate; round?: [number, number] };

/** A step row with the late flag computed from its date (SPEC §3.1: due < today and not done/skipped; amber when it
 *  waits on the client). Done steps never carry a flag. */
function step(r: Row, phase: Pick<Phase, "id" | "name">): StepRow {
  const days = daysBetween(r.due, TODAY);
  const open = r.status !== "done" && r.status !== "skipped";
  const withClient = r.status === "waiting_client";
  return {
    id: r.id, title: r.title, phase: { id: phase.id, name: phase.name }, status: r.status, owner: r.owner, due: r.due,
    mine: r.owner.id === me.id,
    ...(r.round ? { round: { version: r.round[0], round: r.round[1], maxRounds: 3 }, reviewer: people.kavya, needsClientApproval: true } : {}),
    ...(open && days > 0 ? { late: { days, who: withClient ? ("client" as const) : ("team" as const) } } : {}),
  };
}

const ph = (id: string) => orchidPhases.find((p) => p.id === id)!;
const shoot = ph("ph-shoot");

/** The Shoot phase: 12 steps, by column and due date (sheet §3). */
const shootRows: Row[] = [
  { id: "st-props", title: "Prep props and styling", status: "todo", owner: people.tara, due: "2026-11-23" },
  { id: "st-day1", title: "Shoot day 1: exteriors", status: "todo", owner: people.rifob, due: "2026-11-23" },
  { id: "st-day2", title: "Shoot day 2: sample flat", status: "todo", owner: people.rifob, due: "2026-11-24" },
  { id: "st-crew", title: "Book shoot crew", status: "doing", owner: people.rifob, due: "2026-11-19" },
  { id: "st-backup", title: "Back up raw footage plan", status: "doing", owner: people.ira, due: "2026-11-24" },
  { id: "st-plan", title: "Shoot plan", status: "in_review", owner: people.rifob, due: "2026-11-21", round: [1, 1] },
  { id: "st-mood", title: "Shoot moodboard (v2)", status: "in_review", owner: people.tara, due: "2026-11-21", round: [2, 2] },
  { id: "st-models", title: "Model shortlist (v2)", status: "waiting_client", owner: people.tara, due: "2026-11-19", round: [2, 2] },
  { id: "st-schedule", title: "Shoot schedule (v1)", status: "waiting_client", owner: people.kavya, due: "2026-11-23", round: [1, 1] },
  { id: "st-brief", title: "Write shoot brief", status: "done", owner: people.zoya, due: "2026-11-18" },
  { id: "st-permits", title: "Lock locations and permits", status: "done", owner: people.kavya, due: "2026-11-20" },
  { id: "st-shotlist", title: "Shot list", status: "done", owner: people.tara, due: "2026-11-20" },
];
const shootSteps = shootRows.map((r) => step(r, shoot));

/** A few rows of the other phases for the "List by phase" view (the rest load with "Show all"). */
const others: Record<string, { count: number; rows: Row[] }> = {
  "ph-kickoff": { count: 8, rows: [
    { id: "st-k1", title: "Kick-off call with Orchid Realty", status: "done", owner: people.kavya, due: "2026-11-11" },
    { id: "st-k2", title: "Set up project chat", status: "done", owner: people.kavya, due: "2026-11-12" },
    { id: "st-k3", title: "Collect brand files", status: "done", owner: people.zoya, due: "2026-11-14" },
  ] },
  "ph-blueprint": { count: 14, rows: [
    { id: "st-b1", title: "Brand blueprint draft", status: "done", owner: people.tara, due: "2026-11-17" },
    { id: "st-b2", title: "Tone of voice sheet", status: "done", owner: people.zoya, due: "2026-11-18" },
    { id: "st-b3", title: "Brand blueprint sign-off", status: "done", owner: people.kavya, due: "2026-11-20" },
  ] },
  "ph-creative": { count: 28, rows: [
    { id: "st-c1", title: "Ad copy (v1)", status: "todo", owner: people.zoya, due: "2026-11-26" },
    { id: "st-c2", title: "Key visual set", status: "todo", owner: people.tara, due: "2026-11-27" },
    { id: "st-c3", title: "Edit hero video (v1)", status: "todo", owner: people.ira, due: "2026-11-28" },
  ] },
  "ph-landing": { count: 16, rows: [
    { id: "st-l1", title: "Landing page wireframe", status: "todo", owner: people.tara, due: "2026-12-06" },
    { id: "st-l2", title: "Landing page copy", status: "todo", owner: people.zoya, due: "2026-12-07" },
  ] },
  "ph-crm": { count: 12, rows: [
    { id: "st-r1", title: "Set up lead form routing", status: "todo", owner: people.dev, due: "2026-12-13" },
    { id: "st-r2", title: "Test lead alerts", status: "todo", owner: people.dev, due: "2026-12-17" },
  ] },
  "ph-training": { count: 10, rows: [
    { id: "st-t1", title: "Sales pitch deck", status: "todo", owner: people.zoya, due: "2026-12-20" },
    { id: "st-t2", title: "Train the sales team", status: "todo", owner: people.kavya, due: "2026-12-23" },
  ] },
  "ph-review": { count: 12, rows: [
    { id: "st-v1", title: "Check every ad and link", status: "todo", owner: people.dev, due: "2026-12-29" },
    { id: "st-v2", title: "Client sign-off on the launch kit", status: "todo", owner: people.kavya, due: "2027-01-02" },
  ] },
  "ph-adslive": { count: 17, rows: [
    { id: "st-a1", title: "Launch Meta ads", status: "todo", owner: people.dev, due: "2027-01-05" },
    { id: "st-a2", title: "Launch Google ads", status: "todo", owner: people.dev, due: "2027-01-05" },
  ] },
};

function groupsFor(steps: StepRow[]): PhaseGroup[] {
  return orchidPhases.map((p) => {
    if (p.id === shoot.id) return { phase: p, stepCount: steps.length, doneCount: steps.filter((s) => s.status === "done" || s.status === "skipped").length, steps, open: true };
    const o = others[p.id];
    const rows = o.rows.map((r) => step(r, p));
    return { phase: p, stepCount: o.count, doneCount: p.status === "done" ? o.count : 0, steps: rows, moreHref: `${base}/board?view=list&phase=${p.id}`, open: false };
  });
}

const board: PhaseBoardVM = {
  today: TODAY,
  viewer: viewer("tara"),
  project: P,
  health: { key: "at_risk", reason: "shoot moved 3 days" },
  backHref: "/projects",
  menu: [{ label: "Open project", href: base }, { label: "Share client view", href: `${base}/client` }],
  // The step's own name; its button says the verb ("Send to client"), so the row does not say it twice.
  next: {
    stepId: "st-mood", title: "Shoot moodboard (v2)", owner: me, due: TODAY,
    action: { kind: "send_to_client", label: "Send to client" }, href: `${base}/steps/st-mood`,
  },
  phases: orchidPhases,
  phaseId: shoot.id,
  clock: lineOf(orchidClocks),
  view: "board",
  viewHrefs: { list: `${base}/board?view=list`, board: `${base}/board?view=board`, timeline: `${base}/timeline` },
  steps: shootSteps,
  tab: "todo",
  notice: null,
  groups: groupsFor(shootSteps),
  stepHrefBase: `${base}/steps/`,
};

/** Both Doing steps finished: they sit in Done without a flag; Doing is empty. */
const emptyDoing = shootSteps.map((s): StepRow => {
  if (s.status !== "doing") return s;
  const moved: StepRow = { ...s, status: "done" };
  delete moved.late;
  return moved;
});
const doneLast = [...emptyDoing.filter((s) => s.status !== "done"), ...emptyDoing.filter((s) => s.status === "done").sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""))];

export const states: Record<string, PhaseBoardVM> = {
  default: board,
  "tab-doing": { ...board, tab: "doing" },
  "tab-waiting": { ...board, tab: "waiting_client" },
  "drag-denied": { ...board, notice: { stepId: "st-day1", text: "Only Rifob or the lead can move this step." } },
  "column-empty": { ...board, tab: "doing", steps: doneLast, groups: groupsFor(doneLast) },
  list: { ...board, view: "list" },
};

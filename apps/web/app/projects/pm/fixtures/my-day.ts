// PM-UI: fixtures of 04 My day (sheets/my-day.md), all from canon. Signed in: Rifob Das (Video editor). Today Sat, 21 Nov 2026.
import type { MyDayGroup, MyDayItem, MyDayVM } from "../contract/my-day";
import type { IsoDate, ProjectRef, StepRow } from "../contract/shared";
import { TODAY, people, projects, viewer } from "./canon";

const STEP_HREF = "/projects/pm/preview/step-detail";
const REVIEW_HREF = "/projects/pm/preview/approvals";

/** The last group's title: "Next 7 days" on a Saturday or Sunday, else "Later this week" (lead decision, 22 Nov). */
export function laterTitle(today: IsoDate): string {
  const wd = new Date(`${today}T12:00:00Z`).getUTCDay();
  return wd === 0 || wd === 6 ? "Next 7 days" : "Later this week";
}

const at = (time: string) => `${TODAY}T${time}:00+05:30`;
const phase = (name: string) => ({ id: `ph-${name.toLowerCase().replace(/\s+/g, "-")}`, name });

function mine(id: string, title: string, project: ProjectRef, phaseName: string, due: IsoDate, extra: Partial<StepRow> = {}): StepRow {
  return { id, title, project, phase: phase(phaseName), status: "todo", owner: people.rifob, role: "Video editor", due, mine: true, ...extra };
}
const start = (step: StepRow, lateReason?: string): MyDayItem => ({ step, action: { kind: "start", label: "Start" }, href: STEP_HREF, ...(lateReason ? { lateReason } : {}) });
const submit = (step: StepRow): MyDayItem => ({ step, action: { kind: "submit", label: "Submit" }, href: STEP_HREF });

/* Rifob's steps (canon: overloaded, 43 h this week). */
const teaser = start(mine("s-md-teaser", "Edit launch teaser", projects.marigold, "Creative assets", "2026-11-19", { late: { days: 2, who: "team" } }), "shoot files pending");
const reel = start(mine("s-md-reel", "Site visit reel", projects.bluewater, "Creative assets", "2026-11-20", { late: { days: 1, who: "team" } }));
const walk = start(mine("s-md-walk", "Shoot site walkthrough", projects.orchid, "Shoot", TODAY, { dueAt: at("17:00") }));
const cut = submit(mine("s-md-cut", "Cut ad reels (15s, 30s)", projects.cedar, "Creative assets", TODAY, { status: "doing", dueAt: at("19:00") }));
const review: MyDayItem = {
  step: { id: "s-md-review", title: "Review walkthrough reel v1", project: projects.sunpeak, phase: phase("Creative assets"), status: "in_review", owner: people.ira, role: "Video editor",
    reviewer: people.rifob, due: "2026-11-23", mine: false, toReview: true, round: { version: 1, round: 1, maxRounds: 3 } },
  action: { kind: "review", label: "Review", href: REVIEW_HREF },
  href: STEP_HREF,
};
const editWalk = start(mine("s-md-editwalk", "Edit site walkthrough", projects.orchid, "Creative assets", "2026-11-23"));
const cutdown = start(mine("s-md-cutdown", "Create launch cutdown", projects.sunpeak, "Creative assets", "2026-11-24"));
const crm = start(mine("s-md-crm", "Edit CRM training video", projects.palm, "Sales training", "2026-11-25"));

const g = (key: MyDayGroup["key"], title: string, items: MyDayItem[]): MyDayGroup => ({ key, title, items });
const groupsOf = (late: MyDayItem[], today: MyDayItem[]): MyDayGroup[] => [
  g("late", "Late", late),
  g("today", "Due today", today),
  g("review", "Waiting for your review", [review]),
  g("later", laterTitle(TODAY), [editWalk, cutdown, crm]),
].filter((x) => x.items.length > 0);

const base: MyDayVM = {
  today: TODAY,
  viewer: viewer("rifob"),
  greeting: "Good morning",
  week: { hours: 43, capacity: 40 },
  hero: teaser,
  groups: groupsOf([reel], [walk, cut]),
  projectsHref: "/projects/pm/preview/projects-home",
};

export const states: Record<string, MyDayVM> = {
  /** The late step is the hero; it does not repeat in Late. */
  default: base,
  /** Nothing late: the hero is the first Due today step, which leaves Due today with one row. */
  "no-late": { ...base, hero: walk, groups: groupsOf([], [cut]) },
  /** After tapping Start on the hero: Doing, the filled button is Submit. */
  started: { ...base, hero: { ...teaser, step: { ...teaser.step, status: "doing" }, action: { kind: "submit", label: "Submit" } } },
  /** Nothing due: one calm card and a way to Projects. */
  empty: { ...base, week: { hours: 0, capacity: 40 }, hero: null, groups: [] },
};

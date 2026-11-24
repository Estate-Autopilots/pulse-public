// PM-UI: fixtures of 09 Team workload (sheets/team-workload.md), all from canon. Signed in: Kavya Rao (Growth lead).
// Today Sat, 21 Nov 2026; the range is the next two working weeks, Mon 23 Nov – Fri 4 Dec.
import type { TeamWorkloadVM, WorkloadMove, WorkloadPerson } from "../contract/team-workload";
import { TODAY, load, people, projectList, projects, viewer } from "./canon";

const STEP_HREF = "/projects/pm/preview/step-detail";
const W1 = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"];
const W2 = ["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"];
const TUE = W1[1];

const row = (person: WorkloadPerson["person"], w1: number[], w2: number[]): WorkloadPerson => ({ person, hours: [w1, w2] });
const rifob = load.rifobTwoWeeks;

/** Checked: Kavya 40 + 41 = 81 · Rifob 43 + 42 = 85 · Ira 34 + 40 = 74 · Tara 42 + 40 = 82 · Dev 41 + 41 = 82 · Zoya 80. */
const rows: WorkloadPerson[] = [
  row(people.kavya, [8, 8, 8, 8, 8], [8, 8, 9, 8, 8]),
  row(people.rifob, rifob.slice(0, 5), rifob.slice(5)),
  row(people.ira, [8, 2, 8, 8, 8], [8, 8, 8, 8, 8]),
  row(people.tara, [8, 8, 9, 9, 8], [8, 8, 8, 8, 8]),
  row(people.dev, [8, 9, 8, 8, 8], [8, 8, 9, 8, 8]),
  row(people.zoya, [8, 8, 8, 8, 8], [8, 8, 8, 8, 8]),
];

/** Site visit reel, 6 h on Tue 24 Nov, from Rifob (11 h) to Ira (2 h, so 6 h free). */
const reel: WorkloadMove = { stepId: "s-wl-reel", title: "Site visit reel", hours: 6, date: TUE, from: people.rifob, to: people.ira, freeHours: 6 };

/** The rows after the move: Rifob Tue 5 h (37 h, 79 h), Ira Tue 8 h (40 h, 80 h). */
const moved: WorkloadPerson[] = rows.map((r) =>
  r.person.id === reel.from.id ? { ...r, hours: [r.hours[0].map((h, i) => (i === 1 ? h - reel.hours : h)), r.hours[1]] }
  : r.person.id === reel.to.id ? { ...r, hours: [r.hours[0].map((h, i) => (i === 1 ? h + reel.hours : h)), r.hours[1]] }
  : r);

const base: TeamWorkloadVM = {
  today: TODAY,
  viewer: viewer("kavya"),
  range: { start: W1[0], end: W2[4] },
  weeks: [{ start: W1[0], days: W1 }, { start: W2[0], days: W2 }],
  capacity: { day: 8, highUpTo: 10 },
  filters: { role: null, projectId: null, roles: ["Growth lead", "Video editor", "Designer", "Ads manager", "Copywriter"], projects: projectList },
  people: rows,
  phoneWeek: 0,
  suggestion: reel,
  moved: null,
  days: [{
    personId: people.rifob.id, date: TUE, steps: [
      { id: "s-wl-launch", title: "Edit launch video", project: projects.orchid, hours: 4, href: STEP_HREF },
      { id: reel.stepId, title: "Site visit reel", project: projects.marigold, hours: 6, href: STEP_HREF },
      { id: "s-wl-exports", title: "Review and exports", project: projects.orchid, hours: 1, href: STEP_HREF },
    ],
  }],
  openDay: null,
  hrefs: { projects: "/projects/pm/preview/projects-home" },
};

export const states: Record<string, TeamWorkloadVM> = {
  /** The grid and the one suggestion. */
  default: base,
  /** Rifob's red cell (Tue 24 Nov, 11 h) selected and its day sheet open. */
  "day-sheet": { ...base, openDay: { personId: people.rifob.id, date: TUE } },
  /** After Reassign: no red left; a quiet line says both were told, with Undo. */
  reassigned: { ...base, people: moved, suggestion: null, moved: reel },
  /** Phone on week 2 (Mon 30 Nov – Fri 4 Dec): no red cell; the suggestion stays. */
  "week-2": { ...base, phoneWeek: 1 },
  /** Role: Copywriter leaves Zoya only; nobody is overloaded. */
  empty: { ...base, filters: { ...base.filters, role: "Copywriter" }, people: rows.filter((r) => r.person.role === "Copywriter"), suggestion: null },
};

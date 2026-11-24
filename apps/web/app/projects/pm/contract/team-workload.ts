// PM-UI: view model of 09 Team workload (sheets/team-workload.md). One read for the lead: planned hours per person per
// working day over the next two weeks, the steps behind a day when asked, and the one move the server suggests.
// The screen derives tones and totals from the hours (≤ day capacity On track · up to `highUpTo` High load · more
// Overloaded), so the numbers on screen always add up.
import type { IsoDate, Person, ProjectRef, Viewer } from "./shared";

/** One working week of the range: its Monday and its five working days (Mon–Fri). Sat and Sun follow Fri. */
export type WorkloadWeek = { /** Monday. */ start: IsoDate; /** Mon–Fri, in order. */ days: IsoDate[] };

/** One person's row: planned hours per working day, `hours[week][day]` (Mon–Fri), in the order of `weeks`. */
export type WorkloadPerson = { person: Person; hours: number[][] };

/** One step on a person's day (the day sheet). */
export type WorkloadStep = { id: string; title: string; project: ProjectRef; /** Planned hours of this step that day. */ hours: number; /** The step's page. */ href: string };

/** The steps behind one cell (person × day). Their hours add up to the cell. */
export type WorkloadDay = { personId: string; date: IsoDate; steps: WorkloadStep[] };

/** A move of one step's hours on one day from a busy person to someone with room (the suggestion, or the move just made). */
export type WorkloadMove = {
  stepId: string;
  /** "Site visit reel". */ title: string;
  /** Hours that move. */ hours: number;
  /** The day the hours sit on. */ date: IsoDate;
  from: Person;
  to: Person;
  /** Hours the receiver had free that day before the move ("6 h free"). */ freeHours: number;
};

export type TeamWorkloadVM = {
  /** Today (Sat, 21 Nov 2026 in fixtures). */
  today: IsoDate;
  /** The signed-in lead. */
  viewer: Viewer;
  /** The range shown: "Next 2 weeks · 23 Nov – 4 Dec". */
  range: { start: IsoDate; end: IsoDate };
  /** The working weeks of the range (two). The phone shows one at a time. */
  weeks: WorkloadWeek[];
  /** Hours per working day a person can carry (8), and the most that still counts as High load (10). */
  capacity: { day: number; highUpTo: number };
  /** Filters as applied by the server. `role`/`projectId` null = All. */
  filters: { role: string | null; projectId: string | null; roles: string[]; projects: ProjectRef[] };
  /** The people that match the filters, in role-map order. */
  people: WorkloadPerson[];
  /** The week the phone opens on (index into `weeks`). */
  phoneWeek: number;
  /** The one suggested move (filled "Reassign" + "Not now"); null when nobody is overloaded or nothing fits. */
  suggestion: WorkloadMove | null;
  /** A move just made (the quiet "moved … were told" line with Undo); `people` already include it. */
  moved: WorkloadMove | null;
  /** Steps behind the days the server sent (at least the overloaded ones). */
  days: WorkloadDay[];
  /** The day sheet open on first paint (a cell): person id + date; null = closed. */
  openDay: { personId: string; date: IsoDate } | null;
  /** Links: the Projects page (breadcrumb). */
  hrefs: { projects: string };
};

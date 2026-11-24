// PM-UI: view model of 04 My day (sheets/my-day.md). One read for the signed-in person: their steps across every
// project, already grouped and sorted by the server, plus the week's load. Only steps the viewer owns or reviews appear.
import type { IsoDate, StepRow, Viewer } from "./shared";

/** The one quick action of a row (or the hero's filled button). Described as data; the screen draws it.
 *  `start`: To do → Doing · `submit`: Doing → In review · `review`: open the thing to review (a link). */
export type MyDayAction =
  | { kind: "start"; label: "Start" }
  | { kind: "submit"; label: "Submit" }
  | { kind: "review"; label: "Review"; href: string };

/** One of my steps, as a row or as the hero. */
export type MyDayItem = {
  /** The step. `project` is always set; `owner` is the viewer, except on review rows where it is the person who sent it
   *  ("from Ira") and `toReview` is true. `late` only when late (due < today). */
  step: StepRow;
  /** Why it is late, in a few words ("shoot files pending"): shown on the hero's flag "Late · 2 days · shoot files pending". */
  lateReason?: string;
  /** The quick action for the step's current state. */
  action: MyDayAction;
  /** The step's page. */
  href: string;
};

/** A group of rows. Fixed order: late, today, review, later; a group with no rows is left out. */
export type MyDayGroup = {
  key: "late" | "today" | "review" | "later";
  /** "Late", "Due today", "Waiting for your review", and "Next 7 days" on a Saturday or Sunday (else "Later this week"). */
  title: string;
  /** The rows, hero excluded (the hero step never repeats in a group). Most urgent first. */
  items: MyDayItem[];
};

export type MyDayVM = {
  /** Today (Sat, 21 Nov 2026 in fixtures). */
  today: IsoDate;
  /** The signed-in person (whose day this is). */
  viewer: Viewer;
  /** "Good morning" / "Good afternoon" / "Good evening", picked by the server for the viewer's clock. */
  greeting: string;
  /** Planned hours this week (Mon–Sun) against the person's capacity: "This week 43 h of 40 h · Over by 3 h". */
  week: { hours: number; capacity: number };
  /** The most urgent item ("Your next step"): the latest Late step if any, else the earliest Due today, else the next
   *  one. Null when nothing is due. */
  hero: MyDayItem | null;
  /** The groups, in order; empty when nothing is due (then the screen shows "Nothing due this week"). */
  groups: MyDayGroup[];
  /** Where "Open Projects" goes (empty state). */
  projectsHref: string;
};

// PM-UI 15 Goals: the view model of /projects/goals (sheets/goals.md). One API read returns it: the company's goals
// for one period, each with its number, health and reason, owner and projects. No money on PM screens (SPEC §0.5.6).
import type { Health, IsoDate, Person, ProjectRef, Viewer } from "./shared";

/** A goal's icon (lucide-react, mapped in screens/goals.tsx). Drawn on a neutral grey tile, never a project colour. */
export type GoalIconKey = "rocket" | "clipboard-check" | "clock" | "target" | "users" | "star";

/** How a goal is measured. `count`: "7 of 9" (+ an optional note, "this week") with a bar at done ÷ of.
 *  `days`: an average in days against a ceiling ("2.6 days · target 2"); it has NO bar, so a failing goal can never
 *  look almost full. */
export type GoalMeasure =
  | { kind: "count"; /** Done so far. */ done: number; /** The target. */ of: number; /** Words after the count, e.g. "this week". */ note?: string }
  | { kind: "days"; /** The current average, e.g. 2.6. */ value: number; /** The ceiling, e.g. 2. */ target: number };

/** One goal card. */
export type GoalVM = {
  id: string;
  /** e.g. "9 launches live by 31 Dec" (its date lies inside the period). */ title: string;
  icon: GoalIconKey;
  measure: GoalMeasure;
  /** Computed health: on_track, at_risk or late; every key but on_track carries a reason ("2 updates missing"). */ health: Health;
  /** The person answerable for the goal; shown as "Owner: <first name>" with a person icon (no photo, no role). */ owner: Person;
  /** The projects that feed it, each shown with its own colour, icon and full name. */ projects: ProjectRef[];
};

/** The period the page shows, e.g. this quarter. */
export type GoalPeriod = {
  /** "This quarter" */ label: string;
  /** First and last day: the sub-line reads "This quarter · Oct–Dec 2026". */ start: IsoDate;
  end: IsoDate;
};

/** "Add goal": the sheet's choices. Null when the viewer may not add goals. */
export type AddGoalVM = {
  label: string;
  /** Period choices, the first is the default. */ periods: { key: string; label: string }[];
  /** Who may own a goal (the team). */ people: Person[];
  /** Projects a goal may link to. */ projects: ProjectRef[];
  /** Where "Save goal" posts (the real page). */ action: string;
};

export type GoalsVM = {
  today: IsoDate;
  viewer: Viewer;
  period: GoalPeriod;
  /** The goals of the period, in the order the company set them. Empty = the "No goals yet" card. */ goals: GoalVM[];
  addGoal: AddGoalVM | null;
  /** Draw the add-goal sheet open on first paint (the `add-goal` preview state; normally it opens on a tap). */ sheetOpen?: boolean;
  /** Data still on its way: three skeleton cards at the card's final height. */ loading?: boolean;
};

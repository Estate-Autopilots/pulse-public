// PM-UI 01 Projects home: the view model of /projects (sheets/projects-home.md). One API read returns it.
import type { ClockLineVM, Health, IsoDate, Phase, ProjectRef, StepRow, Viewer } from "./shared";

/** The filter chips, in order: Mine · At risk · Waiting on client · Quiet (14 days) · All. */
export type ProjectFilterKey = "mine" | "at_risk" | "waiting_client" | "quiet" | "all";

/** One filter chip. */
export type ProjectFilter = {
  key: ProjectFilterKey;
  /** The chip's word, without the count: "Mine", "At risk", "Waiting on client", "Quiet (14 days)", "All". */ label: string;
  /** Shown as "(2)" after the label; absent on Mine and Quiet. Counts the viewer's projects, except All (every project). */ count?: number;
  /** The same list as a URL (`/projects?filter=at-risk`), for the real page. */ href: string;
};

/** One project card: the most-seen object in PM (also reused by other screens through `ProjectCard`). */
export type ProjectCardVM = {
  project: ProjectRef;
  /** The project page. The whole card is this one link. */ href: string;
  /** Computed health with its reason (SPEC §3.2); lists sort by it, worst first. */ health: Health;
  /** The plan's phases in canon order; the card names only the current one ("Shoot · 3 of 9"). */ phases: Phase[];
  /** The project's next step (first open step by due date): title, owner (null = "No owner"), due, late flag. */ next: StepRow | null;
  /** The active clock line: "Day 12 of 45 · Ads live in 33 days (24 Dec)". */ clock: ClockLineVM;
  /** Last activity on the project (any step change, comment, file): the Quiet filter is 14+ days without. */ lastActivity: IsoDate;
  /** The viewer leads it or owns a step in it (the Mine filter). */ mine: boolean;
};

export type ProjectsHomeVM = {
  today: IsoDate;
  viewer: Viewer;
  /** The chips, in display order, with counts. */ filters: ProjectFilter[];
  /** The selected chip on first paint (the page remembers the last one; default Mine). */ filter: ProjectFilterKey;
  /** Search text on first paint (from `?q=`); empty = no search. */ query: string;
  /** Cards for the "All" list (the client narrows by filter and search). Sorted Late, At risk, Waiting on client,
   *  On track, …, then by next due date. */ projects: ProjectCardVM[];
  /** "+ New project" (opens the template picker); null when the viewer may not create projects. */ newProject: { label: string; href: string } | null;
  /** Data still on its way: draw skeleton cards at the card's final height. */ loading?: boolean;
};

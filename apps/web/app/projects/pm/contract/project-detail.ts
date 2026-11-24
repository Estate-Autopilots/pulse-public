// PM-UI: the view model of the project page (screens/project-detail.tsx), SPEC §5.2. One read of
// GET /projects/:id returns this, plus `viewer` and `today`. Built from the shared types (contract/shared.ts).
import type { Clock, ClockLineVM, Health, IsoDate, Person, Phase, ProjectRef, StepRow, Viewer } from "./shared";

/** An action on a step, described as data; the screen draws it (the next-step card's one filled button, or a row's
 *  small outline button). `kind` says which mutation the real wiring posts. */
export type StepAction = {
  kind: "start" | "submit" | "approve" | "mark_done" | "send_to_client";
  /** In words: "Start", "Submit", "Approve", "Mark done", "Send to client". */ label: string;
  /** Where the action lands without JavaScript (the step page); the client wiring posts instead. */ href?: string;
};

/** One row of the step list: the step, plus the action the signed-in person may take on it. */
export type StepListItem = {
  step: StepRow;
  /** Present ONLY when the signed-in person owns the step and has a next move on it (PICKS 02 must-fix: no
   *  "Mark done" on rows that are not mine). Never the next step's own action (that one is in the card). */ action?: StepAction;
  /** This row is the next step (drawn tinted). */ isNext?: boolean;
  /** The step page (opens the step-detail sheet / side panel). */ href: string;
};

/** The steps of one phase, by due date. */
export type PhaseSteps = {
  phaseId: string;
  /** How many steps the phase has in all (the list may show fewer). */ total: number;
  items: StepListItem[];
  /** "See all 12 steps": the full phase list (board view filtered to the phase). Absent when every step shows. */ seeAllHref?: string;
};

/** A role on the project and the person mapped to it (SPEC §1.4 role map). */
export type TeamRole = { role: string; person: Person };

export type ProjectDetailVM = {
  today: IsoDate;
  viewer: Viewer;
  /** Back link target ("Projects"). */ backHref: string;
  project: ProjectRef & {
    /** "Pune" (shown after the client: "Client: Orchid Realty · Pune"). */ city?: string | null;
    lead: Person | null;
    health: Health;
  };
  /** The ⋯ menu: Project settings, Share client view, Archive (SPEC §5.2). Only what the viewer may do. */
  menu: { key: "settings" | "share" | "archive"; label: string; href: string; danger?: boolean }[];
  /** False while the plan is missing (no template / role map yet): the page shows ONE "Set up this project" card
   *  instead of the next step, the strip and the steps (SPEC §5.2), and health is Needs setup. */
  planReady: boolean;
  /** The setup wizard (needs setup only). */ setupHref: string;
  /** The one step the viewer should act on (SPEC §0 rule 2); null when there is none (or no plan). */
  next: { step: StepRow; primary?: StepAction; openHref: string } | null;
  /** The project's active clock (canon `clockLine`): "Day 0 of 45 · Ads live in 45 days (5 Jan)". */ clockLine: ClockLineVM;
  /** The nine phases in plan order (Ads live last, the gate). Empty while the plan is missing. */ phases: Phase[];
  /** The phase the list shows (the current one unless the viewer tapped another segment). */ selectedPhaseId: string | null;
  /** Steps per phase that the read already carries: always the selected phase; others load when tapped
   *  (`phaseHref`). */ phaseSteps: PhaseSteps[];
  /** The list's own URL with a phase filter: `/projects/<id>?phase=<phaseId>`; `{phase}` is replaced. */ phaseHref: string;
  /** List / Board / Timeline (SPEC §5.3); List is this page. */ views: { list: string; board: string; timeline: string };
  /** Clocks side card, in plan order. */ clocks: Clock[];
  /** Edit a clock (the lead; opens the clock-move sheet). `{clock}` is replaced by the clock key. Absent = read only. */ clockHref?: string;
  /** Team side card: role → person, in role-map order. */ team: TeamRole[];
};

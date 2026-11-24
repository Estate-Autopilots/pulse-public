// PM-UI 03 Phase board (`phase-board`): one project's current phase as a board by status (and the "List by phase"
// view, SPEC §5.3 default). One API read returns this, plus `viewer` and `today`. Types only.
import type { ClockLineVM, Health, IsoDate, Person, Phase, ProjectRef, StepRow, Viewer } from "./shared";

/** The five board columns, in order (SPEC §5.3). `blocked` steps sit in To do; `changes` steps sit in Doing. */
export type BoardColumnKey = "todo" | "doing" | "in_review" | "waiting_client" | "done";

/** The slim next-step row above the board: the signed-in person's next step and its ONE primary action. */
export type BoardNextStep = {
  /** The step this action works on (a StepRow id on the board, or another step of the project). */ stepId: string;
  /** The action in words: "Send shoot moodboard (v2) to client". */ title: string;
  owner: Person;
  due: IsoDate | null;
  /** The one filled button. `kind` is the mutation the API runs (§5.4 primary button chain). */
  action: { kind: "start" | "submit" | "approve" | "send_to_client" | "mark_done"; label: string };
  /** Opens the step (step-detail sheet/panel). */ href: string;
};

/** A phase as a collapsible group in the "List by phase" view. */
export type PhaseGroup = {
  phase: Phase;
  /** All steps in the phase. */ stepCount: number;
  /** Steps done (or skipped). */ doneCount: number;
  /** The rows sent with this read: every step of the current phase; the first few of the others (the rest via `moreHref`). */
  steps: StepRow[];
  /** "Show all N steps" link when `steps` is not all of them. */ moreHref?: string;
  /** Open on first paint (the current phase). */ open: boolean;
};

export type PhaseBoardVM = {
  today: IsoDate;
  /** Signed-in person and permissions; drag uses the same rules as the buttons (SPEC §4, §5.3). */ viewer: Viewer;
  project: ProjectRef;
  /** Header chip with its reason, e.g. At risk: "shoot moved 3 days". */ health: Health;
  /** Back link (always "Projects", SPEC §2). */ backHref: string;
  /** The ⋯ menu: Project settings, Share client view… (only what the viewer may do). */ menu: { label: string; href: string }[];
  /** Null when the viewer has nothing to do in this project now. */ next: BoardNextStep | null;
  /** All phases in order (the nine dots); exactly one `isCurrent`. */ phases: Phase[];
  /** The phase the board shows (normally the current one). */ phaseId: string;
  /** Active clock: "Day 0 of 45 · Ads live in 45 days (5 Jan)". */ clock: ClockLineVM;
  /** Which view is open. SPEC §5.3: list is the default everywhere; the board/timeline when the person picked them. */ view: "list" | "board";
  /** Links of the view switch (the switch also works locally between list and board). */ viewHrefs: { list: string; board: string; timeline: string };
  /** Steps of the phase on the board, in due order. Column = `status` (see BoardColumnKey). */ steps: StepRow[];
  /** Phone: the column tab open on first paint (tablet/laptop show all five). */ tab: BoardColumnKey;
  /** A refused move to show on first paint (drag obeys the button rules): the card is back in its column. */
  notice?: { stepId: string; text: string } | null;
  /** "List by phase" groups, in phase order. */ groups: PhaseGroup[];
  /** Step page: `${stepHrefBase}${step.id}`. */ stepHrefBase: string;
};

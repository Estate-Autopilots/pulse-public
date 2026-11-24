// PM-UI: the view model of Step detail (PICKS 10, SPEC §5.4): one step, everything about it, and the one button that
// moves it on. A full sheet on a phone and tablet, a side panel over the project page on a laptop. One API read.
import type { Clock, Health, IsoDate, Person, Phase, ProjectRef, StepRow, Viewer } from "./shared";

/** What the main button does (SPEC §5.4 order: Start → Submit for review → (reviewer) Approve / Request changes →
 *  Send to client → Mark done). "mark_done" only on a step with no approval (SPEC §0.5 rule 2). */
export type StepActionKind = "start" | "submit" | "approve" | "request_changes" | "send_client" | "mark_done";

/** One action as data. The screen draws `primary` as the ONE filled button and `secondary` as an outline one. */
export type StepAction = {
  kind: StepActionKind;
  /** The button's words: "Start", "Submit for review", "Approve", "Request changes", "Send to client", "Mark done". */ label: string;
  /** POST target for the mutation (the real wiring); absent in fixtures. */ postTo?: string;
};

/** One person's place in the review chain (owner → team reviewer → client). */
export type ChainLink = {
  person: Person;
  /** owner = the step's assignee; reviewer = team approver (§1.6 reviewer_id); client = client contact (§1.8 kind client). */
  role: "owner" | "reviewer" | "client";
  /** Where this link is now. Words (screen): todo "To do", doing "Doing", done "Done", approved "Approved", next "Next",
   *  after "After <afterName>", in_review "In review" ("Your turn" when it is the viewer), with_client "Waiting on client",
   *  changes "Changes asked". */
  state: "todo" | "doing" | "done" | "approved" | "next" | "after" | "in_review" | "with_client" | "changes";
  /** For `after`: the first name of the person before ("Kavya"). */ afterName?: string;
};

/** A file version on the step (SPEC §1.7). Old versions are kept; the newest carries `latest`. */
export type StepFile = {
  id: string;
  /** "30-sec ad film (v2)": the version lives here, not in the step title. */ name: string;
  version: number;
  /** "MP4", "PDF", "JPG", "Link". */ kind: string;
  /** Upload day (never after `today`). */ uploadedOn: IsoDate;
  latest: boolean;
  /** Download link. */ href: string;
};

/** One activity entry, oldest first (SPEC §1.12; comments and events in one list). */
export type StepActivity = {
  id: string;
  who: Person;
  on: IsoDate;
  /** A comment's text or an event in words ("Uploaded v2."). */ text: string;
  kind: "comment" | "event";
};

/** The step's detail. `StepRow` carries title, status, owner, reviewer, needsClientApproval, due + dueSource, late,
 *  blockedBy, mine, toReview. */
export type StepDetailStep = StepRow & {
  /** §1.6 checklist[]: ticks only, never a state chip. */ checklist: { id: string; text: string; done: boolean }[];
  /** §1.6 depends_on[] with each one's title and whether it is done (finish-to-start). */
  dependsOn: { id: string; title: string; done: boolean; href?: string }[];
  /** The client contact who approves after the team (§1.8 kind client); null when no client approval. */ clientApprover: Person | null;
};

/** The project page drawn dimmed behind the laptop panel. PREVIEW STAND-IN ONLY: the real route renders the project
 *  page itself behind the panel; the API does not serve this. */
export type StepDetailBehind = {
  health: Health;
  clocks: Clock[];
  phases: Phase[];
  /** The phase whose step list shows (the open step's phase). */ selectedPhaseId: string;
  /** That phase's steps (name · owner · due · state). */ steps: StepRow[];
};

export type StepDetailVM = {
  today: IsoDate;
  viewer: Viewer;
  project: ProjectRef;
  /** Project page (path chip, close ×). */ projectHref: string;
  /** Project page filtered to the step's phase (phase chip). */ phaseHref: string;
  step: StepDetailStep;
  /** Owner → reviewer → client, in order. Empty when the step needs no approval (then "Mark done" applies). */ chain: ChainLink[];
  files: StepFile[];
  activity: StepActivity[];
  /** AI helper: a suggestion only, applied by a person's tap ("Draft a client update"). */
  suggestion: { title: string; detail: string; actionLabel: string; href: string } | null;
  /** The ONE filled button for this viewer, or null when it is someone else's turn. */ primary: StepAction | null;
  /** A second, outline action beside it (reviewer: "Request changes"). */ secondary: StepAction | null;
  /** A quiet line where there is no button ("Waiting for Kavya's review"). */ note: string | null;
  /** Comment box target (POST); absent in fixtures. */ commentPostTo?: string;
  /** Preview stand-in for the page behind the laptop panel (see `StepDetailBehind`). */ behind?: StepDetailBehind;
};

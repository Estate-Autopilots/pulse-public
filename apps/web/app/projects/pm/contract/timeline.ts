// PM-UI 18 Timeline (`timeline`, sheets/timeline.md): one project's nine phases against the calendar (what is done,
// where today is, when ads go live). A phase list on a phone, a phase Gantt from tablet up. One API read returns this,
// plus `viewer` and `today`. Types only.
import type { Clock, Health, IsoDate, Phase, ProjectRef, Viewer } from "./shared";

/** The one status word a phase row shows; its bar says the same (sheet §3). `waiting_client` draws a hatched bar.
 *  Late is red and only for a phase past its end that is not done. */
export type TimelineStatus = "done" | "doing" | "todo" | "waiting_client" | "late";

/** A neutral icon for the phase's row on a phone (lucide-react, mapped in the screen). From the template phase. */
export type TimelinePhaseIcon = "flag" | "layers" | "video" | "image" | "laptop" | "database" | "users" | "check" | "megaphone";

/** One phase row / bar. `phase.start`..`phase.end` are inclusive days; a gate phase (`phase.isGate`) has start = end and
 *  is drawn as a diamond, never a bar. */
export type TimelinePhase = {
  phase: Phase;
  /** Computed from the phase's steps (SPEC §1.5) plus "waiting on client" when its open steps all wait on the client. */
  status: TimelineStatus;
  icon: TimelinePhaseIcon;
  /** Opens the phase (the board filtered to it). */ href: string;
};

export type TimelineVM = {
  /** Sat, 21 Nov 2026 in fixtures: the Today line. */ today: IsoDate;
  /** Signed-in person; `can.editPlan` shows Reschedule / Update progress. */ viewer: Viewer;
  project: ProjectRef;
  /** "Pune" (shown as "Orchid Realty · Pune" from tablet up); null when unknown. */ city: string | null;
  /** Header chip, e.g. At risk: "shoot moved 3 days". Same words on every width. */ health: Health;
  /** Back link (always "Projects"). */ backHref: string;
  /** The view switch List · Board · Timeline (this page is Timeline). */ viewHrefs: { list: string; board: string; timeline: string };
  /** Header actions from tablet up (null when the viewer may not edit the plan). `update` is the ONE filled button. */
  actions: { reschedule: { label: string; href: string }; update: { kind: "update_progress"; label: string; href: string } } | null;
  /** The chart's first day (the first phase's start; weeks are counted from it) and its length in days, a multiple
   *  of 7 (8 weeks = 56 days for Orchid Towers: 11 Nov–5 Jan). */
  range: { start: IsoDate; days: number };
  /** The project's clocks (Invoice paid, Day 0, Ads live): markers above the bars; one row of three on a phone.
   *  Null while loading. */ clocks: Clock[] | null;
  /** Phases in plan order, the gate (Ads live) last. Null while loading (skeleton rows, the grid without bars). */
  phases: TimelinePhase[] | null;
  /** A phase opened on first paint (popover on tablet/laptop, bottom sheet on a phone); null = none. */ selectedPhaseId: string | null;
};

// PM-UI 11 clock move (`clock-move`): the lead moves one project clock (Day 0: inputs complete), sees every phase date
// that moves, gives a reason and confirms. Drawn as a sheet over the dimmed project page. Build sheet: sheets/clock-move.md.
// Besides the view model this file holds the two pure functions of the move (`previewMove`, `applyMove`): the server and
// the preview's client sheet compute "what moves" the same way, from the phases' clock offsets.
import type { Clock, Health, IsoDate, Person, Phase, ProjectRef, Viewer } from "./shared";
import { addDays, daysBetween } from "../dates";

/** One phase as the move sees it: where its end date comes from (SPEC §1.6 clock + day_offset of its last step). */
export type MovePhase = {
  /** Phase.id */ phaseId: string;
  /** Phase internal name, e.g. "Brand blueprint". */ name: string;
  /** The clock its last step counts from (`invoice_paid`, `inputs_complete`). Phases on another clock stay put. */ clockKey: string;
  /** Days from that clock to the phase's end (Brand blueprint: Day 0 − 1 → −1). */ endOffset: number;
  /** Open (not done, not date-locked) steps of this phase that count from the moving clock; their sum is "41 steps". */ movingSteps: number;
  /** The end date today, before the move (= Phase.end). */ before: IsoDate;
};

/** One row of the before → after table (computed by `previewMove`). */
export type MoveRow = {
  phaseId: string;
  name: string;
  before: IsoDate;
  after: IsoDate;
  /** True when the phase does not move (shown as a grey "stays" tag under the After date). */ stays: boolean;
};

/** What the move would do, computed from the offsets (never typed by hand). */
export type MovePreview = {
  /** The new date of the moving clock. */ to: IsoDate;
  /** Days moved (+3); 0 = nothing to do. */ shift: number;
  /** Steps whose due dates change ("41 steps move +3 days"). */ steps: number;
  rows: MoveRow[];
  /** The target clock (Ads live) before and after: "Ads live target moves 5 Jan → 8 Jan". */
  target: { label: string; before: IsoDate; after: IsoDate };
};

/** The page behind the sheet: Orchid Towers launch as the lead sees it before the move is saved. */
export type ClockMovePage = {
  project: ProjectRef;
  /** City after the client: "Orchid Realty · Pune". */ city: string;
  /** The one health (this screen's moment: "Waiting on client · floor plans, 4 days"). */ health: Health;
  /** Invoice paid, Day 0, Ads live. Ticked when `actual` is set. */ clocks: Clock[];
  /** The nine phases with their end dates (Before dates while the move is unsaved). */ phases: Phase[];
  /** The team on the project (Team card on laptop). */ team: Person[];
  /** "Overall progress · 2 / 9 phases". */ progress: { done: number; of: number };
  /** Back link to the projects list. */ backHref: string;
  /** Outline "Move dates" / "Update project" behind the sheet: opens this sheet. */ moveHref: string;
};

/** The move sheet. */
export type ClockMoveSheet = {
  /** The clock being moved (Day 0: inputs complete) with its current date. */ clock: Clock;
  /** Its date before the move ("from 21 Nov"). */ from: IsoDate;
  /** The new date picked ("to 24 Nov"). */ to: IsoDate;
  /** The target clock the plan counts to (Ads live), and how many days after the moving clock it sits (45). */
  target: { key: string; label: string; date: IsoDate; offset: number };
  /** Every phase with its clock offset, in plan order (Ads live, the gate, last). */ phases: MovePhase[];
  /** The reason typed so far ("Client sent floor plans late"); required. */ reason: string;
  /** Shown under an empty reason after a try to save ("Reason is required"). */ reasonError?: string;
  /** No team step turns late with the new dates (the green note "No one on your team will show as late for this"). */ noTeamLate: boolean;
  /** The confirm action (the one filled button). */ submit: { kind: "move_clock"; label: string };
  /** Where Cancel / × go when the sheet is not run by the client component. */ cancelHref: string;
};

/** The view model of the clock-move screen: one API read (GET project + the clock's move preview). */
export type ClockMoveVM = {
  today: IsoDate;
  /** Signed in: the project lead (Kavya Rao), who may edit the plan. */ viewer: Viewer;
  page: ClockMovePage;
  /** The move sheet, open on first paint when present; null = closed (after saving). */ sheet: ClockMoveSheet | null;
  /** A confirmation toast on the page ("Dates moved · 41 steps"), after saving. */ toast?: string;
};

/** What moving `vm.sheet.clock` to `newDate` would do: each phase counting from that clock moves by the same number of
 *  days (after = newDate + endOffset); phases on other clocks stay. Pure: same input, same output, no "today". */
export function previewMove(vm: ClockMoveVM, newDate: IsoDate): MovePreview {
  const s = vm.sheet;
  if (!s) return { to: newDate, shift: 0, steps: 0, rows: [], target: { label: "", before: newDate, after: newDate } };
  const shift = daysBetween(s.from, newDate);
  const rows: MoveRow[] = s.phases.map((p) => {
    const moves = p.clockKey === s.clock.key && shift !== 0;
    return { phaseId: p.phaseId, name: p.name, before: p.before, after: moves ? addDays(newDate, p.endOffset) : p.before, stays: !moves };
  });
  const steps = shift === 0 ? 0 : s.phases.filter((p) => p.clockKey === s.clock.key).reduce((n, p) => n + p.movingSteps, 0);
  return { to: newDate, shift, steps, rows, target: { label: s.target.label, before: s.target.date, after: addDays(newDate, s.target.offset) } };
}

/** The page after the move is saved: the moving clock and the target take the new dates, phases their After ends
 *  (a clock moved past today is no longer ticked). */
export function applyMove(vm: ClockMoveVM, preview: MovePreview): ClockMovePage {
  const s = vm.sheet;
  if (!s || preview.shift === 0) return vm.page;
  const after = new Map(preview.rows.map((r) => [r.phaseId, r]));
  return {
    ...vm.page,
    clocks: vm.page.clocks.map((c) => c.key === s.clock.key ? { ...c, planned: preview.to, actual: c.actual && preview.to <= vm.today ? preview.to : null }
      : c.key === s.target.key ? { ...c, planned: preview.target.after } : c),
    phases: vm.page.phases.map((p) => {
      const r = after.get(p.id);
      if (!r || r.stays || !p.end) return p;
      const d = daysBetween(r.before, r.after);
      return { ...p, start: p.start ? addDays(p.start, d) : p.start, end: r.after };
    }),
  };
}

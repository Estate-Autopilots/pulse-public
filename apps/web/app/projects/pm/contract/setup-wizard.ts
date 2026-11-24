// PM-UI 08 setup wizard (`setup-wizard`): steps 2 to 4 of a new project (step 1, the template, is `template-picker`).
// Clocks: set the three clock dates and see every phase's dates. People: map the template's roles to people. Preview:
// pick the colour and icon, check, create. Build sheet: sheets/setup-wizard.md.
// Besides the view model this file holds the pure plan maths (`planRows`, `moveClock`, `clockEdited`): the server and the
// preview's client compute the phase dates and "what moved" the same way, from each phase's clock and day offsets.
import type { HueKey, IconKey, IsoDate, Person, ProjectRef, Viewer } from "./shared";
import { addDays, daysBetween } from "../dates";

/** The four wizard steps, in order. */
export type WizardStepKey = "template" | "clocks" | "people" | "preview";

/** One circle of the stepper. */
export type WizardStep = {
  key: WizardStepKey;
  /** "Template", "Clocks", "People", "Preview & create". */ label: string;
  /** done = ticked (and a link back), current = this page, todo = later. */ state: "done" | "current" | "todo";
  /** Link to a done step (to go back and change it). */ href?: string;
};

/** A project clock as the wizard edits it. SPEC §1.9 (template clocks) + §1.6 (day offsets). */
export type WizardClock = {
  /** `invoice_paid`, `inputs_complete`, `ads_live`. */ key: string;
  /** "Invoice paid", "Day 0: inputs complete", "Ads live". */ label: string;
  /** Short name for the summary line: "Invoice paid", "Day 0", "Ads live". */ short: string;
  /** The date now (after any edit in this wizard). */ date: IsoDate;
  /** The date the wizard proposed when it opened (from the invoice and the template): edits are compared with it. */ was: IsoDate;
  /** This clock counts from another one (Ads live = Day 0 + 45): it moves with it and is not "Changed" when it does. */
  follows?: { key: string; offset: number };
  /** The Day 0 clock (the day labels "Day −7", "Day 45" count from it). Exactly one. */ isDay0?: boolean;
};

/** A template phase with where its dates come from (SPEC §1.5, §1.6: clock + day offset of its first and last step). */
export type PlanPhase = {
  id: string;
  /** Internal name, e.g. "Brand blueprint". */ name: string;
  /** The clock its steps count from. */ clockKey: string;
  /** Days from that clock to the phase's first and last step (a gate: both equal). */ startOffset: number; endOffset: number;
  /** Steps this phase creates (Property launch campaign: 8, 14, 18, 28, 16, 12, 10, 12, 17 = 135). */ steps: number;
};

/** One row of the due dates preview (computed by `planRows`). */
export type PlanRow = { id: string; name: string; start: IsoDate; end: IsoDate; steps: number;
  /** Its dates differ from the ones proposed when the wizard opened (tinted). */ moved: boolean; /** Days moved (+3). */ shift: number };

/** Step 2 "Set the clocks". */
export type ClocksBody = {
  kind: "clocks";
  /** "Set the clocks" */ title: string;
  /** Invoice paid, Day 0, Ads live (in this order). */ clocks: WizardClock[];
  /** The plan's phases (Kick-off … Ads live, the gate last). */ phases: PlanPhase[];
  /** The date picker of this clock is open on first paint (state `clocks-picker`). */ pickerOpen?: string;
};

/** A load word beside a person (Team workload, two weeks): only people who are short of room or have room carry one. */
export type LoadWord = { word: string; tone: "problem" | "action" | "done";
  /** A quiet hint under an overloaded person's row: "Ira Menon has room". */ hint?: string };

/** One template role and who does it (SPEC §1.4 role_map). */
export type RoleRow = { role: string; personId: string | null };

/** Step 3 "Who does what". */
export type PeopleBody = {
  kind: "people";
  /** "Who does what" */ title: string;
  /** "Change a person here and all their open steps move." */ sub: string;
  /** Growth lead, Video editor, Designer, Copywriter, Ads manager (template order). */ roles: RoleRow[];
  /** Everyone who can be picked (the team). */ team: Person[];
  /** Load words by person id (Rifob: Overloaded; Ira: Has room). */ load: Record<string, LoadWord>;
  /** The client's contact on this project; null = none yet. */ contact: Person | null;
  /** The client's name beside the contact ("Orchid Realty"). */ clientName: string | null;
  /** "Add contact" (outline). */ addContactHref: string;
};

/** A first step of the plan, as it will be created. */
export type FirstStep = { id: string; title: string; owner: Person; due: IsoDate };

/** A colour the picker offers. The fixture offers the kit's seven project hues only: indigo stays out (SPEC §0 rule 9: the
 *  violet accent means "press this", never a project), although this type and the CSS could carry it. */
export type WizardHue = HueKey | "indigo";

/** Step 4 "Preview and create". */
export type PreviewBody = {
  kind: "preview";
  /** "Preview and create" */ title: string;
  /** The project's colour and icon (editable here; SPEC §1.4). */ identity: { hues: WizardHue[]; icons: IconKey[] };
  /** "9 phases · 135 steps · 45 days · Ads live 5 Jan". */ summary: { phases: number; steps: number; days: number; target: { label: string; date: IsoDate } };
  /** The nine phases with dates and step counts. */ phases: PlanRow[];
  /** The first five steps with owner and due date. */ firstSteps: FirstStep[];
  /** The three clocks for the line "Invoice paid 14 Nov · Day 0 21 Nov · Ads live 5 Jan". */ clocks: { short: string; date: IsoDate }[];
};

/** The view model of the setup wizard (steps 2–4): one API read, GET the project draft at a step. */
export type SetupWizardVM = {
  today: IsoDate;
  /** Signed in: Kavya Rao, Growth lead (may create projects). */ viewer: Viewer;
  /** The project being set up (draft): name, colour, icon. */ project: ProjectRef;
  /** The template it comes from: "Property launch campaign". */ template: { name: string };
  /** Back arrow beside "New project" (to Projects). */ exitHref: string;
  steps: WizardStep[];
  body: ClocksBody | PeopleBody | PreviewBody;
  /** Back (outline) and the step's one filled button. */
  nav: {
    back: { label: string; href: string };
    next: { kind: "next" | "create"; label: string; href?: string; /** "Creating…" */ busyLabel?: string };
    /** Create was pressed and the server is working: the button says "Creating…" and is off. */ busy?: boolean;
  };
};

/* ---------- Plan maths (pure: same input, same output, no "today") ---------- */

/** Clock dates by key. */
export type ClockDates = Record<string, IsoDate>;
export const datesOf = (clocks: WizardClock[], which: "date" | "was" = "date"): ClockDates => Object.fromEntries(clocks.map((c) => [c.key, c[which]]));

/** Set one clock to `to`; clocks that follow it move by the same days (Ads live stays Day 45). */
export function moveClock(clocks: WizardClock[], dates: ClockDates, key: string, to: IsoDate): ClockDates {
  const shift = daysBetween(dates[key], to);
  const next: ClockDates = { ...dates, [key]: to };
  for (const c of clocks) if (c.follows?.key === key) next[c.key] = addDays(dates[c.key], shift);
  return next;
}

/** The clock was edited by hand (a follower that only moved with its anchor is not). */
export function clockEdited(c: WizardClock, dates: ClockDates, was: ClockDates): boolean {
  if (c.follows) return daysBetween(dates[c.follows.key], dates[c.key]) !== daysBetween(was[c.follows.key], was[c.key]);
  return dates[c.key] !== was[c.key];
}

/** Every phase's dates from the clock dates, marked where they moved from the dates the wizard proposed. */
export function planRows(phases: PlanPhase[], dates: ClockDates, was: ClockDates): PlanRow[] {
  return phases.map((p) => {
    const start = addDays(dates[p.clockKey], p.startOffset), end = addDays(dates[p.clockKey], p.endOffset);
    const wasEnd = addDays(was[p.clockKey], p.endOffset);
    const shift = daysBetween(wasEnd, end);
    return { id: p.id, name: p.name, start, end, steps: p.steps, moved: shift !== 0 || start !== addDays(was[p.clockKey], p.startOffset), shift };
  });
}

/** "Day −7", "Day 0", "Day 45": a date counted from Day 0. */
export const dayLabel = (day0: IsoDate, d: IsoDate) => { const n = daysBetween(day0, d); return `Day ${n < 0 ? `−${-n}` : n}`; };

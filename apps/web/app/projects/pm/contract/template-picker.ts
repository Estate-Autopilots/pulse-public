// PM-UI 07 Template picker (sheets/template-picker.md): step 1 of 4 of a new project (`/projects/new`). Pick a template
// and see what it will create: clocks, phases with step counts, roles. One API read returns this whole view model; the
// picked template and the open/closed phone sheet are local UI state seeded from it.
import type { HueKey, IsoDate, Person, Viewer } from "./shared";

/** A template's icon (lucide-react, mapped in the screen). */
export type TemplateIconKey = "building" | "brush" | "megaphone" | "browser" | "plus";

/** One step of the new-project wizard. SPEC §5.8: Template → Clocks → People → Preview & create. */
export type WizardStep = {
  key: "template" | "clocks" | "people" | "create";
  /** 1-based number shown in the circle. */ n: number;
  /** "Template", "Clocks", "People", "Preview & create". */ label: string;
  /** `current` = this screen (violet); `todo` = not reached yet. */ state: "done" | "current" | "todo";
};

/** An industry filter chip. The company's own industry comes first and is selected (SPEC §1.3 library). */
export type IndustryChip = { id: string; /** "Real-estate marketing". */ label: string; selected: boolean; /** Reloads the list for this industry. */ href: string };

/** A clock of the template as a tag, relative to Day 0 (no dates: the dates are set on the next step). */
export type TemplateClockTag = {
  /** Template clock key: `invoice_paid`, `inputs_complete`, `ads_live`, `site_live`… */ key: string;
  /** Bold part: "Invoice paid", "Day 0", "Ads live". */ label: string;
  /** Quiet part: "Day −7", "Inputs complete", "Day 45". */ detail: string;
  icon: "invoice" | "flag" | "rocket";
};

/** One phase of the template with its step count (canon order; the counts add to `totalSteps`). */
export type TemplatePhaseRow = { id: string; /** "Kick-off". */ name: string; steps: number };

/** A role the template needs, with the person suggested for it (by load; editable on step 3). */
export type TemplateRole = { /** "Growth lead". */ role: string; /** Suggested person; null when nobody fits. */ suggested: Person | null };

/** What a template will create. `blank`: no phases or clocks yet ("Start from scratch"). */
export type TemplatePlan =
  | { kind: "plan"; clocks: TemplateClockTag[]; phases: TemplatePhaseRow[]; /** Sum of the phase counts. */ totalSteps: number; roles: TemplateRole[] }
  | { kind: "blank"; /** "Start from scratch. You add phases and steps yourself." */ note: string };

/** One template card (+ its preview). */
export type TemplateOption = {
  /** templates.id. */ id: string;
  /** "Property launch campaign". */ name: string;
  /** Tile colour (a project hue). */ hue: HueKey;
  icon: TemplateIconKey;
  /** Shown as "9 phases · 135 steps · 45 days"; null for Blank project (shows `scratchLabel`). */
  counts: { phases: number; steps: number; days: number } | null;
  /** Marked "Recommended" (fits the quote the project comes from). */ recommended?: boolean;
  plan: TemplatePlan;
  /** "Use this template": goes to step 2 (Clocks) with this template (and the quote) picked. */ useHref: string;
};

export type TemplatePickerVM = {
  today: IsoDate;
  viewer: Viewer;
  /** "New project: pick a template". */ title: string;
  /** The accepted quote the project comes from; null when opened without one. Shown "From quote Q-1043: Growth package, 18 parts". */
  quote: { number: string; title: string; parts: number; /** Opens the quote (the number is the link). */ href?: string } | null;
  /** The four wizard steps, Template current. */ steps: WizardStep[];
  /** One row of industry chips (own industry first, selected; at most four more). */ industries: IndustryChip[];
  /** The templates of the selected industry, in order. */ templates: TemplateOption[];
  /** The template picked on load (recommended one); null = nothing picked yet. */ pickedId: string | null;
  /** "Use this template". The one filled button. */ useLabel: string;
  /** Under the disabled button when nothing is picked: "Pick a template to see its plan". */ emptyNote: string;
  /** Counts line of a template without counts: "Start from scratch". */ scratchLabel: string;
  /** Phone only: the bottom sheet starts pulled up (clocks, phases, roles). Default: peek. */ sheetOpen?: boolean;
};

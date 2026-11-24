// PM-UI 19 First run: the view model of /projects when the company has no projects yet (sheets/first-run.md).
import type { HueKey, IsoDate, Viewer } from "./shared";

/** A template's tile colour: a project hue, or indigo (decoration only, never a project). */
export type TemplateHue = HueKey | "indigo";
/** A template's icon: building (property launch), play (video), browser (website). */
export type TemplateIcon = "building" | "play" | "browser" | "megaphone";

/** One template offered on the empty page. SPEC template library (§7). */
export type TemplateCardVM = {
  id: string;
  /** "Property launch campaign". */ name: string;
  hue: TemplateHue;
  icon: TemplateIcon;
  /** Counts shown as "9 phases · 135 steps · 45 days". */ phases: number;
  steps: number;
  days: number;
  /** Opens the setup wizard with this template picked. The whole row/card is this one link. */ href: string;
};

/** One of the three "how it works" steps (labels, never buttons). */
export type FirstRunStep = { key: "template" | "dates" | "team"; label: string };

export type FirstRunVM = {
  today: IsoDate;
  viewer: Viewer;
  /** "Run every client project the same, good way". */ headline: string;
  /** Pick a template → Set your dates → Add your team. */ steps: FirstRunStep[];
  /** "Start your first project" (opens the template picker); null when the viewer may not create projects. */ start: { label: string; href: string } | null;
  /** For a viewer who cannot create: "Projects appear here when your lead starts one." */ note?: string;
  /** The template row; null when the viewer may not create projects. */
  templates: {
    heading: string;
    seeAll: { label: string; href: string };
    /** Three templates; empty while `loading`. */ items: TemplateCardVM[];
    /** Still loading: draw three skeleton cards at their final height. */ loading?: boolean;
  } | null;
  /** The three decoration tiles of the hero (teal building, indigo play, amber megaphone). */ art: { hue: TemplateHue; icon: TemplateIcon }[];
};

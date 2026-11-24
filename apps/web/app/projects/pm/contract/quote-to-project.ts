// PM-UI 14 Quote to project (`quote-to-project`): what an accepted quote turns into (each quote line → its step blocks,
// with a total) and the one action that makes the draft project. Build sheet: sheets/quote-to-project.md.
// No money on PM screens in v1 (SPEC §0.5.6): the quote's amount and line prices are never part of this view model.
import type { Health, IsoDate, Person, ProjectRef, Viewer } from "./shared";

/** The icon of a quote line (lucide-react, mapped in the screen). */
export type QuoteLineIcon = "image" | "megaphone" | "database" | "gift" | "refresh" | "layers";

/** One quote line and the step blocks it makes in the template. */
export type QuoteLineVM = {
  id: string;
  /** The line as the quote names it, without price or product brand: "Meta ads × 4 months". */ name: string;
  icon: QuoteLineIcon;
  /** The blocks of steps it makes, in order ("Month 1" … "Month 4"); empty = one plain block (shown as the count only). */ blocks: string[];
  /** A word tag beside the name ("Bonus"); never an amount. */ tag?: string;
  /** Steps this line makes (blocks × steps per block). The lines add up to `total.steps`. */ steps: number;
};

/** The accepted quote, as the PM side sees it. */
export type QuoteVM = {
  id: string;
  /** "Q-1043". */ number: string;
  /** The package sold: "Growth package". */ packageName: string;
  /** The client (§1.2): "Orchid Realty". */ client: string;
  /** Identity of the project it will make (the band's tint and icon tile). */ hue: ProjectRef["hue"];
  icon: ProjectRef["icon"];
  /** Only accepted quotes reach this screen; shown as the soft green chip "Accepted". */ status: "accepted";
};

/** The draft project this quote makes (or made). */
export type DraftVM = {
  /** Name, colour, icon of the draft ("Orchid Towers launch"). */ project: ProjectRef;
  /** A fresh draft: Not started · "Starts when invoice is paid". */ health: Health;
  /** The draft's page; null until it exists (the preview's simulated create falls back to `backHref`). */ href: string | null;
};

/** The view model of the quote-to-project screen: one API read (GET the accepted quote's project plan). */
export type QuoteToProjectVM = {
  today: IsoDate;
  /** Signed in: Kavya Rao, Growth lead (may create projects). */ viewer: Viewer;
  /** "ready" (button on) · "creating" (spinner, button off) · "created" (green line + Open draft) ·
   *  "exists" (a draft was already made from this quote: outline Open draft only) · "loading" (skeleton). */
  status: "ready" | "creating" | "created" | "exists" | "loading";
  /** Back arrow to the projects list (label "Projects"). */ backHref: string;
  quote: QuoteVM;
  /** The quote's lines in quote order; empty while loading. */ lines: QuoteLineVM[];
  /** "97 steps in 9 phases" (the template has 135; this quote makes 97). */ total: { steps: number; phases: number };
  /** The suggested lead ("Lead: Kavya · suggested"). No dates, no load numbers. */ lead: { person: Person; suggested: boolean };
  /** "Dates start when the invoice is paid": a draft has no dates yet. */ note: string;
  /** The one action (filled button "Create draft project"; "Creating…" while busy). POST quotes/:id/project. */
  create: { kind: "create_draft_project"; label: string; busyLabel: string };
  draft: DraftVM;
  /** "Open draft": filled after creating, outline when the draft already existed. */ openLabel: string;
  /** The quiet band shown when `status` is "exists": "A draft already exists for quote Q-1043". */ existsNote: string;
};

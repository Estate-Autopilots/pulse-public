// PM-UI: view model of the Weekly update screen (/projects/<id>/updates/<week>). SPEC §5 weekly update; build sheet
// sheets/weekly-update.md. The lead reads the Project Coordinator's draft of this week's update, fixes it, picks the
// health (a reason is needed to mark it better than the system says) and posts it, optionally with a client-safe version.
// One read returns the draft (or the posted update) for one project and one week.
import type { Health, IsoDate, Person, ProjectRef, Viewer } from "./shared";

/** The three health words the lead can pick on an update (SPEC §3.2 subset). Order = better → worse. */
export type UpdateHealth = "on_track" | "at_risk" | "late";

/** One of the three fields, in this order: done, next, help. */
export type UpdateSection = {
  key: "done" | "next" | "help";
  /** "Done this week", "Next week", "Needs help". */ label: string;
  /** Short plain lines, one per bullet (no step chips). Dates in `next` fall in the coming week. */ lines: string[];
};

/** A button described as data; the real wiring posts `kind` (or follows `href`). */
export type UpdateAction = {
  kind: "post" | "save_draft" | "back_to_project";
  label: string;
  /** Endpoint or page for the action (lane A fills it). */ href?: string;
};

export type WeeklyUpdateVM = {
  today: IsoDate;
  /** The signed-in person (the project's lead; only the lead posts updates). */ viewer: Viewer;
  /** `draft`: editable; `posted`: read-only with a quiet "Posted" line; `loading`: skeleton of the same blocks. */
  mode: "draft" | "posted" | "loading";
  /** Monday of the week the update covers ("Week of 16 Nov"). */ weekOf: IsoDate;
  /** The project, with its computed health and its page (the back arrow and "Back to project" go there). */
  project: ProjectRef & { health: Health; href: string };
  /** Who wrote the draft, in words ("Project Coordinator", the AI member); null when a person started it. */ draftBy: string | null;
  /** Set once posted: who, which day, and whether the client-safe version was shared too. */
  posted: { by: Person; on: IsoDate; clientShared: boolean } | null;
  /** Done this week, Next week, Needs help (always all three, in that order). */ sections: UpdateSection[];
  health: {
    /** The pills, better → worse: On track, At risk, Late. */ options: { key: UpdateHealth; label: string }[];
    /** The lead's pick (starts as the system's). */ picked: UpdateHealth;
    /** What the system computed, with its reason: "System says: At risk (shoot moved 3 days)". */ system: Health & { key: UpdateHealth };
    /** Required when `picked` is better than `system` (server rejects the post without it). */ reason: string;
    /** Validation message shown under the reason field ("Reason is required"). */ reasonError?: string;
  };
  /** The client-safe version: dates only, no internal reason, no names, no health word. */
  clientSafe: {
    on: boolean;
    /** "Also share a client-safe version". */ label: string;
    /** "A shorter update without internal details." */ help: string;
    /** The text the client will see (drafted by the Project Coordinator from the plan's dates). */ preview: string;
  };
  /** `post` is the one filled button; `saveDraft` an outline; `backToProject` the only button once posted. */
  actions: { post: UpdateAction; saveDraft: UpdateAction; backToProject: UpdateAction };
};

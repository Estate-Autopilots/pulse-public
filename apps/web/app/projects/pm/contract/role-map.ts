// PM-UI: the view model of the role map (screens/role-map.tsx), SPEC §1.4 role map, sheets/role-map.md. One read of
// GET /projects/:id/team returns this, plus `viewer` and `today`. Built from the shared types (contract/shared.ts).
import type { Health, HueKey, IsoDate, Person, ProjectRef, Viewer } from "./shared";

/** A person's load in words (team workload): "Overloaded" (red) or "Has room" (green). Absent = normal (no chip). */
export type LoadKey = "overloaded" | "has_room";

/** Someone who may fill a role: the person, and their load over the next two weeks. */
export type RoleCandidate = { person: Person; /** Absent when the load is normal. */ load?: LoadKey };

/** One role of the project's role map and who fills it. */
export type RoleRow = {
  /** Template role key, e.g. "video_editor". */ key: string;
  /** In words: "Video editor". */ role: string;
  /** The saved person (role_map value); null = nobody yet. */ person: Person | null;
  /** Everyone who may fill the role, the saved person first; each with their load. */ candidates: RoleCandidate[];
  /** Open (not done, not skipped) steps of this role: they move to the new person on save. Done steps keep their owner. */
  openSteps: number;
  /** The client's approvers (client contacts): full name and the client's company are shown. */ client?: boolean;
};

/** The project page's tabs (the same five on every width). */
export type ProjectTab = { key: "overview" | "plan" | "team" | "files" | "settings"; label: string; href: string };

export type RoleMapVM = {
  today: IsoDate;
  /** The lead (editPlan) may change roles; others see the table read only. */ viewer: Viewer;
  /** Back link target ("Projects"). */ backHref: string;
  project: ProjectRef & { health: Health };
  /** Overview · Plan · Team · Files · Settings; this screen is "team". */ tabs: ProjectTab[];
  /** The role map in template order. */ roles: RoleRow[];
  /** Person id → the initials colour of their face (a different hue per person on this team; a photo, when they have
   *  one, is shown instead). A person missing here gets slate. */ hues: Record<string, HueKey>;
  /** Unsaved choices of this visit: role key → person id (client state; the preview seeds it). */ picks: Record<string, string>;
  /** The role whose person menu is open (client state; the preview seeds it). */ openRole: string | null;
  /** The save action: posts the changed roles; the API moves their open steps. */ save: { kind: "save_team"; label: string };
  /** A toast just after a save ("Team saved · 14 steps moved to Ira"). */ toast?: string | null;
};

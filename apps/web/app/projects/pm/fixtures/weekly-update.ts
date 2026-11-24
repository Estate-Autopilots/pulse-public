// PM-UI: fixtures of the Weekly update screen (sheets/weekly-update.md), all from canon. Signed in: Kavya Rao, Growth
// lead, the lead of Orchid Towers launch. Today Sat, 21 Nov 2026; the week runs from Monday 16 Nov.
import type { WeeklyUpdateVM } from "../contract/weekly-update";
import { TODAY, people, projects, viewer } from "./canon";

const orchidHref = `/projects/${projects.orchid.id}`;
const api = `/api/projects/${projects.orchid.id}/updates/2026-11-16`;

const base: WeeklyUpdateVM = {
  today: TODAY,
  viewer: viewer("kavya"),
  mode: "draft",
  weekOf: "2026-11-16",
  project: { ...projects.orchid, health: { key: "at_risk", reason: "shoot moved 3 days" }, href: orchidHref },
  draftBy: "Project Coordinator",
  posted: null,
  sections: [
    { key: "done", label: "Done this week", lines: ["Brand blueprint finished on 20 Nov.", "Shoot plan and locations locked.", "Inputs complete: Day 0 set on 21 Nov."] },
    { key: "next", label: "Next week", lines: ["Shoot wraps on 24 Nov.", "Creative assets start on 25 Nov."] },
    { key: "help", label: "Needs help", lines: ["Site access for the shoot on 23 and 24 Nov."] },
  ],
  health: {
    options: [{ key: "on_track", label: "On track" }, { key: "at_risk", label: "At risk" }, { key: "late", label: "Late" }],
    picked: "at_risk",
    system: { key: "at_risk", reason: "shoot moved 3 days" },
    reason: "",
  },
  clientSafe: {
    on: true,
    label: "Also share a client-safe version",
    help: "A shorter update without internal details.",
    preview: "Shoot runs 21–24 Nov. Creative assets start on 25 Nov. Ads go live on 5 Jan.",
  },
  actions: {
    post: { kind: "post", label: "Post update", href: `${api}/post` },
    saveDraft: { kind: "save_draft", label: "Save draft", href: `${api}/draft` },
    backToProject: { kind: "back_to_project", label: "Back to project", href: orchidHref },
  },
};

export const states: Record<string, WeeklyUpdateVM> = {
  /** The draft, At risk picked (same as the system), client-safe version on with its preview. */
  default: base,
  /** Kavya picked On track, better than the system: a reason is required and Post update is disabled. */
  "better-needs-reason": { ...base, health: { ...base.health, picked: "on_track", reason: "", reasonError: "Reason is required" } },
  /** Late picked (worse than the system): no reason asked. */
  worse: { ...base, health: { ...base.health, picked: "late" } },
  /** Client-safe switch off: no preview. */
  "client-off": { ...base, clientSafe: { ...base.clientSafe, on: false } },
  /** Posted today: read-only, quiet green line, one outline "Back to project". */
  posted: { ...base, mode: "posted", posted: { by: people.kavya, on: TODAY, clientShared: true } },
  /** First paint while the draft loads. */
  loading: { ...base, mode: "loading" },
};

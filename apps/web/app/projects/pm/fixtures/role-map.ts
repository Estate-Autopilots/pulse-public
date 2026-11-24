// PM-UI: fixtures of the role map (sheets/role-map.md §3–4), all from canon: Kavya (the lead) on Orchid Towers launch.
// States: default (Video editor menu open, nothing changed), picked-ira, closed, saved.
import type { RoleMapVM, RoleRow } from "../contract/role-map";
import { TODAY, people, projects, viewer } from "./canon";

const P = projects.orchid;
const base = `/projects/${P.id}`;

const roles: RoleRow[] = [
  { key: "delivery_lead", role: "Delivery lead", person: people.kavya, openSteps: 9, candidates: [{ person: people.kavya }, { person: people.dev }] },
  { key: "video_editor", role: "Video editor", person: people.rifob, openSteps: 14, candidates: [{ person: people.rifob, load: "overloaded" }, { person: people.ira, load: "has_room" }] },
  { key: "designer", role: "Designer", person: people.tara, openSteps: 22, candidates: [{ person: people.tara }] },
  { key: "copywriter", role: "Copywriter", person: people.zoya, openSteps: 16, candidates: [{ person: people.zoya }] },
  { key: "ads_manager", role: "Ads manager", person: people.dev, openSteps: 12, candidates: [{ person: people.dev }] },
  { key: "client_approvers", role: "Client approvers", person: people.ahoro, openSteps: 8, client: true, candidates: [{ person: people.ahoro }] },
];

const kavya: RoleMapVM = {
  today: TODAY,
  viewer: viewer("kavya"),
  backHref: "/projects",
  project: { ...P, health: { key: "at_risk", reason: "shoot moved 3 days" } },
  tabs: [
    { key: "overview", label: "Overview", href: base },
    { key: "plan", label: "Plan", href: `${base}/plan` },
    { key: "team", label: "Team", href: `${base}/team` },
    { key: "files", label: "Files", href: `${base}/files` },
    { key: "settings", label: "Settings", href: `${base}/settings` },
  ],
  roles,
  // One hue per person, so no two faces on the team share a colour (the client contact is the grey one).
  hues: { [people.kavya.id]: "pink", [people.rifob.id]: "amber", [people.ira.id]: "green", [people.tara.id]: "teal", [people.zoya.id]: "orange", [people.dev.id]: "sky", [people.ahoro.id]: "slate" },
  picks: {},
  openRole: "video_editor",
  save: { kind: "save_team", label: "Save team" },
};

export const states: Record<string, RoleMapVM> = {
  default: kavya,
  "picked-ira": { ...kavya, picks: { video_editor: people.ira.id } },
  closed: { ...kavya, openRole: null },
  saved: {
    ...kavya,
    openRole: null,
    roles: roles.map((r) => (r.key === "video_editor" ? { ...r, person: people.ira, candidates: [{ person: people.ira, load: "has_room" as const }, { person: people.rifob, load: "overloaded" as const }] } : r)),
    toast: "Team saved · 14 steps moved to Ira",
  },
};

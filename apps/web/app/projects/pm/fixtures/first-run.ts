// PM-UI 19 First run fixtures (sheets/first-run.md §3–4). No projects, people, dates or clocks on this page.
import type { FirstRunVM, TemplateCardVM } from "../contract/first-run";
import { TODAY, orchid, viewer } from "./canon";

const templates: TemplateCardVM[] = [
  { id: "tpl-property-launch", name: orchid.template.name, hue: "teal", icon: "building", phases: orchid.template.phases, steps: orchid.template.steps, days: orchid.template.days, href: "/projects/new?template=tpl-property-launch" },
  { id: "tpl-video", name: "Video production", hue: "indigo", icon: "play", phases: 5, steps: 42, days: 21, href: "/projects/new?template=tpl-video" },
  { id: "tpl-website", name: "Website build", hue: "sky", icon: "browser", phases: 6, steps: 58, days: 30, href: "/projects/new?template=tpl-website" },
];

const templateBlock = { heading: "Start from a template", seeAll: { label: "See all templates", href: "/projects/new" }, items: templates };

const base: FirstRunVM = {
  today: TODAY,
  viewer: viewer("kavya"),
  headline: "Run every client project the same, good way",
  steps: [
    { key: "template", label: "Pick a template" },
    { key: "dates", label: "Set your dates" },
    { key: "team", label: "Add your team" },
  ],
  start: { label: "Start your first project", href: "/projects/new" },
  templates: templateBlock,
  art: [{ hue: "teal", icon: "building" }, { hue: "indigo", icon: "play" }, { hue: "amber", icon: "megaphone" }],
};

export const states: Record<string, FirstRunVM> = {
  default: base,
  member: { ...base, viewer: viewer("rifob"), start: null, templates: null, note: "Projects appear here when your lead starts one." },
  "templates-loading": { ...base, templates: { ...templateBlock, items: [], loading: true } },
};

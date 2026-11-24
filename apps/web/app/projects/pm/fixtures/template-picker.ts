// PM-UI 07 Template picker fixtures (sheets/template-picker.md §3–4). Signed in: Kavya Rao (Growth lead) in every state.
import type { TemplateClockTag, TemplateOption, TemplatePhaseRow, TemplatePickerVM, TemplateRole } from "../contract/template-picker";
import { TODAY, orchid, people, viewer } from "./canon";

const phases = (rows: [string, number][]): { phases: TemplatePhaseRow[]; totalSteps: number } => ({
  phases: rows.map(([name, steps], i) => ({ id: `tph-${i + 1}`, name, steps })),
  totalSteps: rows.reduce((s, [, n]) => s + n, 0),
});
const clocks = (end: [string, number]): TemplateClockTag[] => [
  { key: "invoice_paid", label: "Invoice paid", detail: "Day −7", icon: "invoice" },
  { key: "inputs_complete", label: "Day 0", detail: "Inputs complete", icon: "flag" },
  { key: end[0].toLowerCase().replace(/\s+/g, "_"), label: end[0], detail: `Day ${end[1]}`, icon: "rocket" },
];
const role = (r: string, p: (typeof people)[keyof typeof people]): TemplateRole => ({ role: r, suggested: p });
const nextHref = (id: string, quote: boolean) => `/projects/new/clocks?template=${id}${quote ? "&quote=Q-1043" : ""}`;

/** Property launch campaign: 8 + 14 + 18 + 28 + 16 + 12 + 10 + 12 + 17 = 135 (Lead decisions). */
const property = phases([["Kick-off", 8], ["Brand blueprint", 14], ["Shoot", 18], ["Creative assets", 28], ["Landing page", 16], ["CRM setup", 12], ["Sales training", 10], ["Review", 12], ["Ads live", 17]]);
/** Website build: 6 + 8 + 12 + 8 + 16 + 8 = 58 (Lead decisions: 6 phases · 58 steps · 30 days; same as first-run). */
const website = phases([["Discovery", 6], ["Sitemap", 8], ["Design", 12], ["Copy", 8], ["Build", 16], ["Go live", 8]]);
/** Brand refresh: 8 + 12 + 10 + 18 + 14 + 10 = 72 (only seen after a click). */
const brand = phases([["Kick-off", 8], ["Brand audit", 12], ["Strategy", 10], ["Identity design", 18], ["Brand kit", 14], ["Handover", 10]]);
/** Ads-only retainer: 12 + 16 + 10 + 16 = 54 (only seen after a click). */
const ads = phases([["Setup", 12], ["Creatives", 16], ["Launch", 10], ["Optimise", 16]]);

function templates(quote: boolean): TemplateOption[] {
  return [
    { id: "tpl-property-launch", name: orchid.template.name, hue: "teal", icon: "building", recommended: quote,
      counts: { phases: orchid.template.phases, steps: orchid.template.steps, days: orchid.template.days },
      plan: { kind: "plan", clocks: clocks(["Ads live", 45]), ...property,
        roles: [role("Growth lead", people.kavya), role("Video editor", people.rifob), role("Designer", people.tara), role("Ads manager", people.dev), role("Copywriter", people.zoya)] },
      useHref: nextHref("tpl-property-launch", quote) },
    { id: "tpl-brand-refresh", name: "Brand refresh", hue: "amber", icon: "brush", counts: { phases: 6, steps: 72, days: 30 },
      plan: { kind: "plan", clocks: clocks(["Handover", 30]), ...brand, roles: [role("Growth lead", people.kavya), role("Designer", people.tara), role("Copywriter", people.zoya)] },
      useHref: nextHref("tpl-brand-refresh", quote) },
    { id: "tpl-ads-retainer", name: "Ads-only retainer", hue: "pink", icon: "megaphone", counts: { phases: 4, steps: 54, days: 28 },
      plan: { kind: "plan", clocks: clocks(["Ads live", 10]), ...ads, roles: [role("Growth lead", people.kavya), role("Ads manager", people.dev), role("Designer", people.tara), role("Video editor", people.ira)] },
      useHref: nextHref("tpl-ads-retainer", quote) },
    { id: "tpl-website", name: "Website build", hue: "sky", icon: "browser", counts: { phases: 6, steps: 58, days: 30 },
      plan: { kind: "plan", clocks: clocks(["Site live", 30]), ...website, roles: [role("Growth lead", people.kavya), role("Designer", people.tara), role("Copywriter", people.zoya), role("Ads manager", people.dev)] },
      useHref: nextHref("tpl-website", quote) },
    { id: "tpl-blank", name: "Blank project", hue: "slate", icon: "plus", counts: null,
      plan: { kind: "blank", note: "Start from scratch. You add phases and steps yourself." },
      useHref: nextHref("tpl-blank", quote) },
  ];
}

const industries = ([
  ["real-estate", "Real-estate marketing"], ["construction", "Construction"], ["hospitality", "Hospitality"], ["education", "Education"], ["other", "Other"],
] as const).map(([id, label], i) => ({ id, label, selected: i === 0, href: `/projects/new?industry=${id}` }));

const base: TemplatePickerVM = {
  today: TODAY,
  viewer: viewer("kavya"),
  title: "New project: pick a template",
  quote: { number: "Q-1043", title: "Growth package", parts: 18, href: "/quotations/Q-1043" },
  steps: [
    { key: "template", n: 1, label: "Template", state: "current" },
    { key: "clocks", n: 2, label: "Clocks", state: "todo" },
    { key: "people", n: 3, label: "People", state: "todo" },
    { key: "create", n: 4, label: "Preview & create", state: "todo" },
  ],
  industries,
  templates: templates(true),
  pickedId: "tpl-property-launch",
  useLabel: "Use this template",
  emptyNote: "Pick a template to see its plan",
  scratchLabel: "Start from scratch",
};

export const states: Record<string, TemplatePickerVM> = {
  default: base,
  "sheet-open": { ...base, sheetOpen: true },
  website: { ...base, pickedId: "tpl-website" },
  blank: { ...base, pickedId: "tpl-blank" },
  "no-quote": { ...base, quote: null, templates: templates(false), pickedId: null },
};

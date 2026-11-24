// PM-UI 08 setup wizard fixtures (sheets/setup-wizard.md §3–4). Kavya Rao sets up Orchid Towers launch from the
// "Property launch campaign" template. Canon dates: Invoice paid 14 Nov (Day −7), Day 0 21 Nov, Ads live 5 Jan (Day 45).
import {
  datesOf, planRows, type ClocksBody, type PeopleBody, type PlanPhase, type PreviewBody, type SetupWizardVM, type WizardClock, type WizardStep, type WizardStepKey,
} from "../contract/setup-wizard";
import { TODAY, orchid, people, projects, team, viewer } from "./canon";

const DRAFT = "/projects/new/drf-orchid";
const LABELS: Record<WizardStepKey, string> = { template: "Template", clocks: "Clocks", people: "People", preview: "Preview & create" };
const ORDER: WizardStepKey[] = ["template", "clocks", "people", "preview"];
const HREFS: Record<WizardStepKey, string> = { template: `/projects/new?draft=drf-orchid`, clocks: `${DRAFT}/clocks`, people: `${DRAFT}/people`, preview: `${DRAFT}/preview` };
const stepsAt = (current: WizardStepKey): WizardStep[] => ORDER.map((key, i) => {
  const at = ORDER.indexOf(current);
  return { key, label: LABELS[key], state: i < at ? "done" : i === at ? "current" : "todo", ...(i < at ? { href: HREFS[key] } : {}) };
});

/** The three clocks as the wizard proposes them (Ads live follows Day 0 by 45 days). */
const clocks: WizardClock[] = [
  { key: "invoice_paid", label: "Invoice paid", short: "Invoice paid", date: "2026-11-14", was: "2026-11-14" },
  { key: "inputs_complete", label: "Day 0: inputs complete", short: "Day 0", date: "2026-11-21", was: "2026-11-21", isDay0: true },
  { key: "ads_live", label: "Ads live", short: "Ads live", date: "2027-01-05", was: "2027-01-05", follows: { key: "inputs_complete", offset: orchid.template.days } },
];

/** The template's nine phases: Kick-off and Brand blueprint count from Invoice paid, the rest from Day 0, Ads live is the gate. */
const phases: PlanPhase[] = [
  { id: "ph-kickoff", name: "Kick-off", clockKey: "invoice_paid", startOffset: -3, endOffset: 0, steps: 8 },
  { id: "ph-blueprint", name: "Brand blueprint", clockKey: "invoice_paid", startOffset: 0, endOffset: 6, steps: 14 },
  { id: "ph-shoot", name: "Shoot", clockKey: "inputs_complete", startOffset: 0, endOffset: 3, steps: 18 },
  { id: "ph-creative", name: "Creative assets", clockKey: "inputs_complete", startOffset: 4, endOffset: 13, steps: 28 },
  { id: "ph-landing", name: "Landing page", clockKey: "inputs_complete", startOffset: 14, endOffset: 20, steps: 16 },
  { id: "ph-crm", name: "CRM setup", clockKey: "inputs_complete", startOffset: 21, endOffset: 27, steps: 12 },
  { id: "ph-training", name: "Sales training", clockKey: "inputs_complete", startOffset: 28, endOffset: 35, steps: 10 },
  { id: "ph-review", name: "Review", clockKey: "inputs_complete", startOffset: 36, endOffset: 43, steps: 12 },
  { id: "ph-adslive", name: "Ads live", clockKey: "ads_live", startOffset: 0, endOffset: 0, steps: 17 },
];

const nav = (back: WizardStepKey, next: SetupWizardVM["nav"]["next"]): SetupWizardVM["nav"] => ({ back: { label: "Back", href: HREFS[back] }, next });

const base = {
  today: TODAY,
  viewer: viewer("kavya"),
  project: projects.orchid,
  template: { name: orchid.template.name },
  exitHref: "/projects",
};

const clocksBody: ClocksBody = { kind: "clocks", title: "Set the clocks", clocks, phases };
const clocksVM: SetupWizardVM = { ...base, steps: stepsAt("clocks"), body: clocksBody, nav: nav("template", { kind: "next", label: "Next: People", href: HREFS.people }) };

/** Kavya moved Day 0 from 21 Nov to 24 Nov: Ads live follows to 8 Jan (still Day 45); seven phases move +3 days. */
const changedClocks: WizardClock[] = clocks.map((c) => c.key === "inputs_complete" ? { ...c, date: "2026-11-24" } : c.key === "ads_live" ? { ...c, date: "2027-01-08" } : c);

const peopleBody: PeopleBody = {
  kind: "people",
  title: "Who does what",
  sub: "Change a person here and all their open steps move.",
  roles: [
    { role: "Growth lead", personId: people.kavya.id },
    { role: "Video editor", personId: people.rifob.id },
    { role: "Designer", personId: people.tara.id },
    { role: "Copywriter", personId: people.zoya.id },
    { role: "Ads manager", personId: people.dev.id },
  ],
  team,
  load: {
    [people.rifob.id]: { word: "Overloaded", tone: "problem", hint: `${people.ira.name} has room` },
    [people.ira.id]: { word: "Has room", tone: "done" },
  },
  contact: people.ahoro,
  clientName: projects.orchid.client,
  addContactHref: `${DRAFT}/people?add=contact`,
};

const previewBody: PreviewBody = {
  kind: "preview",
  title: "Preview and create",
  identity: { hues: ["teal", "green", "sky", "amber", "pink", "orange", "slate"], icons: ["building", "house", "landmark", "store", "tree", "sun", "waves", "palm"] },
  summary: { phases: orchid.template.phases, steps: orchid.template.steps, days: orchid.template.days, target: { label: "Ads live", date: "2027-01-05" } },
  phases: planRows(phases, datesOf(clocks), datesOf(clocks, "was")),
  firstSteps: [
    { id: "st-welcome", title: "Welcome call", owner: people.kavya, due: "2026-11-11" },
    { id: "st-checklist", title: "Input checklist sent", owner: people.kavya, due: "2026-11-12" },
    { id: "st-inputs", title: "Inputs received", owner: people.ahoro, due: "2026-11-14" },
    { id: "st-positioning", title: "Positioning doc", owner: people.zoya, due: "2026-11-17" },
    { id: "st-brandsheet", title: "Brand sheet", owner: people.tara, due: "2026-11-20" },
  ],
  clocks: clocks.map((c) => ({ short: c.short, date: c.date })),
};
const previewVM: SetupWizardVM = { ...base, steps: stepsAt("preview"), body: previewBody, nav: nav("people", { kind: "create", label: "Create project", busyLabel: "Creating…" }) };

export const states: Record<string, SetupWizardVM> = {
  clocks: clocksVM,
  "clocks-changed": { ...clocksVM, body: { ...clocksBody, clocks: changedClocks } },
  "clocks-picker": { ...clocksVM, body: { ...clocksBody, pickerOpen: "inputs_complete" } },
  people: { ...base, steps: stepsAt("people"), body: peopleBody, nav: nav("clocks", { kind: "next", label: "Next: Preview & create", href: HREFS.preview }) },
  preview: previewVM,
  creating: { ...previewVM, nav: { ...previewVM.nav, busy: true } },
};

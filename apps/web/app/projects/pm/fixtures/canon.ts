// PM-UI: the one fictional world every PM fixture is built from (scratch/pm-ui/BRIEF-COMMON.md "canon"). Never use
// other names, dates or numbers. Today is fixed; nothing here calls `new Date()`.
import type { Clock, ClockLineVM, HueKey, IconKey, IsoDate, Person, Phase, ProjectRef, Viewer } from "../contract/shared";
import { addDays, daysBetween } from "../dates";

export { addDays, daysBetween } from "../dates";

/** Sat, 21 Nov 2026. */
export const TODAY: IsoDate = "2026-11-21";

export const AGENCY = { name: "Brightpath Marketing", short: "Brightpath" } as const;

/** The team (and the one client contact), by short key. */
export const people = {
  kavya: { id: "p-kavya", name: "Kavya Rao", role: "Growth lead" },
  rifob: { id: "p-rifob", name: "Rifob Das", role: "Video editor" },
  tara: { id: "p-tara", name: "Tara Nair", role: "Designer" },
  zoya: { id: "p-zoya", name: "Zoya Khan", role: "Copywriter" },
  ira: { id: "p-ira", name: "Ira Menon", role: "Video editor" },
  dev: { id: "p-dev", name: "Dev Malhotra", role: "Ads manager" },
  ahoro: { id: "c-ahoro", name: "Ahoro Mifos", role: "Client contact, Orchid Realty", client: true },
} satisfies Record<string, Person>;
export type PersonKey = keyof typeof people;
/** The six team members in role-map order (no client). */
export const team: Person[] = [people.kavya, people.rifob, people.tara, people.zoya, people.ira, people.dev];

/** Load facts from canon: Rifob 85 h over two weeks (overloaded), Ira has room. Day cells for Rifob's two weeks. */
export const load = {
  rifobTwoWeeks: [8, 11, 8, 8, 8, 8, 8, 8, 9, 9],
  rifobTotal: 85,
} as const;

const project = (id: string, name: string, client: string | null, hue: HueKey, icon: IconKey): ProjectRef => ({ id, name, client, hue, icon });
/** The six projects, each with its own colour and icon. Orchid Towers launch is the main one. */
export const projects = {
  orchid: project("pr-orchid", "Orchid Towers launch", "Orchid Realty", "teal", "building"),
  marigold: project("pr-marigold", "Marigold Plots", "Marigold Land Co.", "amber", "flower"),
  bluewater: project("pr-bluewater", "Bluewater Homes", "Bluewater Developers", "sky", "waves"),
  cedar: project("pr-cedar", "Cedar Court Phase 2", "Cedar Group", "green", "tree"),
  sunpeak: project("pr-sunpeak", "Sunpeak Residences", "Sunpeak Realty", "orange", "sun"),
  palm: project("pr-palm", "Palm Grove Villas", "Palm Grove Estates", "pink", "palm"),
} satisfies Record<string, ProjectRef>;
export type ProjectKey = keyof typeof projects;
export const projectList: ProjectRef[] = Object.values(projects);

/** Orchid Towers launch: its city and template. */
export const orchid = {
  city: "Pune",
  template: { name: "Property launch campaign", phases: 9, steps: 135, days: 45 },
} as const;

/** Orchid Towers' clocks: Invoice paid 14 Nov (done), Day 0 = 21 Nov (done), Ads live = Day 45 = 5 Jan (planned). */
export const orchidClocks: Clock[] = [
  { key: "invoice_paid", label: "Invoice paid", planned: "2026-11-14", actual: "2026-11-14" },
  { key: "inputs_complete", label: "Day 0: inputs complete", planned: "2026-11-21", actual: "2026-11-21" },
  { key: "ads_live", label: "Ads live", planned: "2027-01-05", actual: null },
];

const phase = (id: string, name: string, clientName: string, start: IsoDate, end: IsoDate, status: Phase["status"], isCurrent = false, isGate = false): Phase =>
  ({ id, name, clientName, start, end, status, isCurrent, ...(isGate ? { isGate } : {}) });
/** Orchid Towers' 9 phases with the canon dates; Shoot is current (today 21 Nov). Client names are plain words. */
export const orchidPhases: Phase[] = [
  phase("ph-kickoff", "Kick-off", "Getting started", "2026-11-11", "2026-11-14", "done"),
  phase("ph-blueprint", "Brand blueprint", "Your brand blueprint", "2026-11-14", "2026-11-20", "done"),
  phase("ph-shoot", "Shoot", "The shoot", "2026-11-21", "2026-11-24", "active", true),
  phase("ph-creative", "Creative assets", "Your ads and videos", "2026-11-25", "2026-12-04", "not_started"),
  phase("ph-landing", "Landing page", "Getting your site ready", "2026-12-05", "2026-12-11", "not_started"),
  phase("ph-crm", "CRM setup", "Setting up your lead system", "2026-12-12", "2026-12-18", "not_started"),
  phase("ph-training", "Sales training", "Training your sales team", "2026-12-19", "2026-12-26", "not_started"),
  phase("ph-review", "Review", "Final review", "2026-12-27", "2027-01-03", "not_started"),
  phase("ph-adslive", "Ads live", "Your ads go live", "2027-01-05", "2027-01-05", "not_started", false, true),
];

/** The signed-in person and what they may do (SPEC §4). Kavya leads; the others are members on the project. */
export function viewer(key: PersonKey, opts: { isLead?: boolean } = {}): Viewer {
  const person = people[key];
  if (key === "ahoro") return { person, orgRole: "client", isLead: false, can: { createProject: false, editPlan: false, changeStepOwnerOrDue: false, approveTeam: false, skip: false, seeMoney: false } };
  const isLead = opts.isLead ?? key === "kavya";
  return { person, orgRole: isLead ? "admin" : "member", isLead,
    can: { createProject: isLead, editPlan: isLead, changeStepOwnerOrDue: isLead, approveTeam: isLead, skip: isLead, seeMoney: false } };
}

/** The project's clock line, always adding up: day + daysLeft = of (PICKS 01 must-fix).
 *  `start` = Day 0 (actual, else planned); `target` = the clock it counts to (Ads live). */
export function clockLine(start: Clock | undefined, target: Clock | undefined, today: IsoDate = TODAY, opts: { startWord?: string; unsetNote?: string } = {}): ClockLineVM {
  const startDate = start?.actual ?? start?.planned ?? null;
  const targetDate = target?.actual ?? target?.planned ?? null;
  if (!startDate || !targetDate || !target) return { state: "unset", note: opts.unsetNote ?? "Starts when invoice is paid" };
  if (daysBetween(startDate, today) < 0) return { state: "before", start: opts.startWord ?? "Day 0", startDate, target: target.label, date: targetDate };
  const daysLeft = daysBetween(today, targetDate);
  if (daysLeft < 0 || target.actual) return { state: "passed", target: target.label, date: targetDate, daysAgo: Math.max(0, -daysLeft), done: !!target.actual };
  const day = daysBetween(startDate, today);
  return { state: "running", day, of: day + daysLeft, target: target.label, daysLeft, date: targetDate };
}

/** A clock set with Day 0 and Ads live `of` days later, for the other projects: Day `day` today. */
export function clocksAt(day: number, of = 45, today: IsoDate = TODAY): Clock[] {
  const day0 = addDays(today, -day);
  return [
    { key: "invoice_paid", label: "Invoice paid", planned: addDays(day0, -7), actual: addDays(day0, -7) },
    { key: "inputs_complete", label: "Day 0: inputs complete", planned: day0, actual: day0 },
    { key: "ads_live", label: "Ads live", planned: addDays(day0, of), actual: null },
  ];
}
/** Shortcut: the clock line of a clock set (Day 0 → Ads live). */
export const lineOf = (clocks: Clock[], today: IsoDate = TODAY) =>
  clockLine(clocks.find((c) => c.key === "inputs_complete"), clocks.find((c) => c.key === "ads_live"), today);

/** The same 9 phase names on a project that is in phase `current` (1-based), for cards of the other projects. */
export function phasesAt(current: number, opts: { late?: boolean } = {}): Phase[] {
  return orchidPhases.map((p, i) => ({ ...p, start: null, end: null, isCurrent: i + 1 === current,
    status: i + 1 < current ? "done" : i + 1 === current ? (opts.late ? "late" : "active") : "not_started" }));
}

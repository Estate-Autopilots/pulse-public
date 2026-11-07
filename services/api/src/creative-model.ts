// EST-1474 (T1 slice 1, Kazuk's ask of 17 Oct): the Creative Strategy app's sprint, without the database. The code is
// company-neutral; CREATIVE_SEED is the seed configuration taken from EA's Creative Strategist SOPs (the A-to-Z Workflow
// and the Package-Wise Sprint): packages, the critical inputs collected before Day 1 and the dated deliverables of
// Stages 1-3. The clock: deliverable N of a package is due on Day N; Day 1 is the sprint's first day; every critical
// input that arrives after Day 1 (or is still missing) moves the Blueprint and creative deliverables one day for each
// day it is late. The research meet (Stage 1) stays on Day 1: its transcript is due by the end of Day 1 either way.

export type Package = { key: string; label: string };
export type InputDef = { key: string; label: string; packages?: string[] };
export type Milestone = { key: string; label: string; stage: number; where: string; due: Record<string, number> };
export type CreativeConfig = { packages: Package[]; inputs: InputDef[]; milestones: Milestone[]; approvalWorkingDays: number };

export const CREATIVE_SEED: CreativeConfig = {
  packages: [{ key: "starter", label: "Starter" }, { key: "growth", label: "Growth" }, { key: "sellout", label: "Sell-Out" }],
  inputs: [
    { key: "brochure", label: "Brochure, renders and plans" },
    { key: "price_sheet", label: "Price sheet and payment plan" },
    { key: "offers", label: "Offers with end dates" },
    { key: "maharera", label: "MahaRERA" },
    { key: "location", label: "Location pin and approved distances" },
    { key: "past_ads", label: "Past creatives and ad results" },
    { key: "ad_access", label: "Ad account and sales-team access" },
    { key: "brand_assets", label: "Brand assets" },
    { key: "founder_dates", label: "Founder dates", packages: ["sellout"] },
    { key: "past_buyers", label: "Past buyers", packages: ["sellout"] },
    { key: "brand_decision_maker", label: "Brand decision-maker", packages: ["sellout"] },
  ],
  milestones: [
    { key: "research_meet", label: "Research meet, transcript saved", stage: 1, where: "Research meet", due: { starter: 1, growth: 1, sellout: 1 } },
    { key: "deep_research", label: "Deep Research", stage: 2, where: "Blueprint 1.1-1.5", due: { starter: 2, growth: 2, sellout: 3 } },
    { key: "competitors", label: "Competitor philosophy", stage: 2, where: "Blueprint", due: { starter: 3, growth: 3, sellout: 4 } },
    { key: "usp_map", label: "USP Map", stage: 2, where: "Blueprint", due: { starter: 3, growth: 4, sellout: 5 } },
    { key: "personas", label: "Buyer personas", stage: 2, where: "Blueprint", due: { starter: 4, growth: 4, sellout: 5 } },
    { key: "positioning", label: "Positioning", stage: 2, where: "Blueprint", due: { starter: 4, growth: 5, sellout: 6 } },
    { key: "word_library", label: "Word Library V1", stage: 2, where: "Blueprint", due: { starter: 4, growth: 5, sellout: 6 } },
    { key: "docs_to_client", label: "First Curiosity Set docs to the client", stage: 3, where: "Creative board", due: { starter: 8, growth: 10, sellout: 14 } },
  ],
  approvalWorkingDays: 3,
};

const DAY = 86_400_000;
const toDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
export const addDays = (iso: string, n: number) => new Date(toDay(iso) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((toDay(to) - toDay(from)) / DAY);

/** The critical inputs a package asks for. */
export const inputsFor = (config: CreativeConfig, pkg: string) => config.inputs.filter((i) => !i.packages || i.packages.includes(pkg));

export type ClockItem = { key: string; label: string; stage: number; where: string; dueDay: number; day: number; due: string; doneOn: string | null;
  state: "done" | "overdue" | "today" | "upcoming" };
export type Clock = { dayOne: string; today: string; day: number; shift: number; lateInputs: number; missingInputs: number; items: ClockItem[] };

/** The sprint clock on `today` (the org's calendar date). `received` maps an input key to the day it arrived. */
export function sprintClock(config: CreativeConfig, s: { package: string; dayOne: string }, received: Record<string, string | null>,
  done: Record<string, string | null>, today: string): Clock {
  const inputs = inputsFor(config, s.package);
  const late = inputs.map((i) => Math.max(0, daysBetween(s.dayOne, received[i.key] ?? (today > s.dayOne ? today : s.dayOne))));
  const shift = Math.max(0, ...late);
  const items = config.milestones.filter((m) => m.due[s.package] !== undefined).map((m) => {
    const dueDay = m.due[s.package], day = dueDay + (m.stage <= 1 ? 0 : shift), due = addDays(s.dayOne, day - 1), doneOn = done[m.key] ?? null;
    const state: ClockItem["state"] = doneOn ? "done" : due < today ? "overdue" : due === today ? "today" : "upcoming";
    return { key: m.key, label: m.label, stage: m.stage, where: m.where, dueDay, day, due, doneOn, state };
  });
  return { dayOne: s.dayOne, today, day: daysBetween(s.dayOne, today) + 1, shift, lateInputs: late.filter((d) => d > 0).length,
    missingInputs: inputs.filter((i) => !received[i.key]).length, items };
}

export type HomeRow = { kind: "due" | "alert"; sprintId: string; project: string; key: string; title: string; detail: string;
  state: "overdue" | "today" | "upcoming" | "alert"; due: string | null; href: string };

/** CS Home rows for one sprint: the Day-1 alerts first, then every open deliverable with its date. */
export function homeRows(config: CreativeConfig, sprint: { id: string; project: string; package: string }, clock: Clock): HomeRow[] {
  const pkg = config.packages.find((p) => p.key === sprint.package)?.label ?? sprint.package;
  const href = (key: string) => `/creative/sprints/${sprint.id}#${key}`;
  const rows: HomeRow[] = [];
  if (clock.day >= 1 && clock.missingInputs > 0)
    rows.push({ kind: "alert", sprintId: sprint.id, project: sprint.project, key: "inputs", title: `Inputs missing · ${sprint.project}`,
      detail: `${clock.missingInputs} critical input${clock.missingInputs === 1 ? "" : "s"} not received; the clock has moved ${clock.shift} day${clock.shift === 1 ? "" : "s"}`,
      state: "alert", due: null, href: href("inputs") });
  const meet = clock.items.find((i) => i.key === "research_meet");
  if (meet && !meet.doneOn && clock.today > meet.due)
    rows.push({ kind: "alert", sprintId: sprint.id, project: sprint.project, key: "research_meet", title: `Research-meet transcript not saved · ${sprint.project}`,
      detail: "Save the transcript doc, then mark the research meet done", state: "alert", due: meet.due, href: href("research_meet") });
  // A deliverable with an alert is listed once, as the alert.
  for (const i of clock.items) if (i.state !== "done" && !rows.some((r) => r.key === i.key))
    rows.push({ kind: "due", sprintId: sprint.id, project: sprint.project, key: i.key, title: `${i.label} · ${sprint.project}`,
      detail: `${i.where} · Day ${i.day}, ${pkg} package`, state: i.state, due: i.due, href: href(i.key) });
  return rows;
}

const ORDER = { alert: 0, overdue: 1, today: 2, upcoming: 3 } as const;
/** Alerts, then overdue, due today and next, each by date; at most `limit` upcoming rows. */
export function sortHome(rows: HomeRow[], limit = 8): HomeRow[] {
  const sorted = [...rows].sort((a, b) => ORDER[a.state] - ORDER[b.state] || (a.due ?? "").localeCompare(b.due ?? "") || a.title.localeCompare(b.title));
  let upcoming = 0;
  return sorted.filter((r) => r.state !== "upcoming" || ++upcoming <= limit);
}

// PM-UI 11 clock move: fixtures from canon (Sat, 21 Nov 2026; Kavya Rao moves Orchid Towers' Day 0 from 21 Nov to
// 24 Nov because the client sent floor plans late). Every After date is computed by `previewMove` from the offsets.
import { applyMove, previewMove, type ClockMoveVM, type MovePhase } from "../contract/clock-move";
import { TODAY, daysBetween, orchid, orchidClocks, orchidPhases, people, projects, viewer } from "./canon";

const DAY0 = orchidClocks.find((c) => c.key === "inputs_complete")!;
const ADS = orchidClocks.find((c) => c.key === "ads_live")!;
const INVOICE = orchidClocks.find((c) => c.key === "invoice_paid")!;
const day0 = DAY0.actual ?? DAY0.planned!;

/** Open steps per phase that count from Day 0 (sum 41); Kick-off counts from Invoice paid and stays. */
const MOVING: Record<string, number> = { "ph-blueprint": 2, "ph-shoot": 6, "ph-creative": 10, "ph-landing": 6, "ph-crm": 4, "ph-training": 4, "ph-review": 6, "ph-adslive": 3 };

const movePhases: MovePhase[] = orchidPhases.map((p) => {
  const onInvoice = p.id === "ph-kickoff";
  const clock = onInvoice ? INVOICE : DAY0;
  const from = clock.actual ?? clock.planned!;
  return { phaseId: p.id, name: p.name, clockKey: clock.key, endOffset: daysBetween(from, p.end!), movingSteps: onInvoice ? 0 : MOVING[p.id] ?? 0, before: p.end! };
});

const base: ClockMoveVM = {
  today: TODAY,
  viewer: viewer("kavya"),
  page: {
    project: projects.orchid,
    city: orchid.city,
    health: { key: "waiting_client", reason: "floor plans, 4 days" },
    clocks: orchidClocks,
    phases: orchidPhases,
    team: [people.kavya, people.rifob, people.tara, people.zoya, people.dev],
    progress: { done: orchidPhases.filter((p) => p.status === "done").length, of: orchidPhases.length },
    backHref: "/projects",
    moveHref: "/projects/pm/preview/clock-move",
  },
  sheet: {
    clock: DAY0,
    from: day0,
    to: "2026-11-24",
    target: { key: ADS.key, label: ADS.label, date: ADS.planned!, offset: daysBetween(day0, ADS.planned!) },
    phases: movePhases,
    reason: "Client sent floor plans late",
    noTeamLate: true,
    submit: { kind: "move_clock", label: "Move dates" },
    cancelHref: "/projects/pm/preview/clock-move?state=saved",
  },
};

const saved: ClockMoveVM = { ...base, page: applyMove(base, previewMove(base, base.sheet!.to)), sheet: null, toast: "Dates moved · 41 steps" };

export const states: Record<string, ClockMoveVM> = {
  default: base,
  "empty-reason": { ...base, sheet: { ...base.sheet!, reason: "", reasonError: "Reason is required" } },
  saved,
};

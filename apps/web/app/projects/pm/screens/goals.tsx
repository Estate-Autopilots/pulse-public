// PM-UI 15 Goals (sheets/goals.md; picks b5-15-goals-*). The company's goals for the quarter as three cards, the same
// order inside every card at every width: icon + title, number + target, a neutral bar (none for a goal in days),
// the health chip with its reason, "Owner: <first name>", then the project chips in each project's own colour.
// Server component; the header button, the empty card's button and the add-goal sheet live in goals-client.tsx.
// Preview: /projects/pm/preview/goals?state=default|empty|add-goal|loading
import { ClipboardCheck, Clock, Rocket, Star, Target, UserRound, Users, type LucideIcon } from "lucide-react";
import type { GoalIconKey, GoalMeasure, GoalVM, GoalsVM } from "../contract/goals";
import type { IsoDate, ScreenProps } from "../contract/shared";
import { HealthChip, PROJECT_ICONS, PmCard, PmPage, firstName, fmtDayShort, hued } from "../kit";
import { GoalsClient } from "./goals-client";
import css from "./goals.module.css";

const GOAL_ICONS: Record<GoalIconKey, LucideIcon> = { rocket: Rocket, "clipboard-check": ClipboardCheck, clock: Clock, target: Target, users: Users, star: Star };

/** "7 of 9", "4 of 6 this week", "2.6 days · target 2". */
function measureText(m: GoalMeasure): string {
  if (m.kind === "count") return `${m.done} of ${m.of}${m.note ? ` ${m.note}` : ""}`;
  return `${m.value} ${m.value === 1 ? "day" : "days"} · target ${m.target}`;
}

/** "Oct–Dec 2026" (the month words come from the kit's fixed-locale formatter). */
function monthRange(start: IsoDate, end: IsoDate): string {
  const month = (d: IsoDate) => fmtDayShort(d).split(" ").pop() ?? "";
  const [y1, y2] = [start.slice(0, 4), end.slice(0, 4)];
  return y1 === y2 ? `${month(start)}–${month(end)} ${y2}` : `${month(start)} ${y1}–${month(end)} ${y2}`;
}

function GoalCard({ goal, ghost }: { goal: GoalVM; /** Loading placeholder: same rows and heights, grey bones. */ ghost?: boolean }) {
  const Icon = GOAL_ICONS[goal.icon] ?? Target;
  const m = goal.measure;
  const pct = m.kind === "count" && m.of > 0 ? Math.max(0, Math.min(100, Math.round((m.done / m.of) * 100))) : null;
  return <PmCard as="li" className={ghost ? `${css.goal} ${css.skel}` : css.goal}>
    <span className={css.icon} aria-hidden="true"><Icon /></span>
    <h2 className={css.title}><span>{goal.title}</span></h2>
    <p className={css.num}><span>{measureText(m)}</span></p>
    {pct !== null
      ? <span className={css.bar} role="progressbar" aria-label={`${goal.title}: ${measureText(m)}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></span>
      : <span className={css.bar} data-none="" aria-hidden="true" />}
    <div className={css.health}><HealthChip health={goal.health} /></div>
    <p className={css.owner}><UserRound aria-hidden="true" /><span>Owner: <b>{firstName(goal.owner)}</b></span></p>
    <ul className={css.projects} aria-label="Projects">
      {goal.projects.map((p) => {
        const PIcon = PROJECT_ICONS[p.icon];
        return <li key={p.id} {...hued(p.hue, css.proj)}><PIcon aria-hidden="true" /><span>{p.name}</span></li>;
      })}
    </ul>
  </PmCard>;
}

/** Stand-in content for the loading cards (text turns into bones; the lengths match real goals so heights match). */
const slate = (id: string, name: string) => ({ id, name, client: null, hue: "slate" as const, icon: "building" as const });
const owner = { id: "loading", name: "Owner", role: "" };
const GHOSTS: GoalVM[] = [
  { id: "l1", title: "Loading the goal title", icon: "target", measure: { kind: "count", done: 1, of: 2 }, health: { key: "on_track" }, owner, projects: [slate("l1a", "Loading project"), slate("l1b", "Loading project")] },
  { id: "l2", title: "Loading the goal title here", icon: "target", measure: { kind: "count", done: 1, of: 2 }, health: { key: "at_risk", reason: "loading" }, owner, projects: [slate("l2a", "Loading project"), slate("l2b", "Loading project")] },
  { id: "l3", title: "Loading the goal title", icon: "target", measure: { kind: "count", done: 1, of: 2 }, health: { key: "late", reason: "loading reason" }, owner, projects: [slate("l3a", "Loading project"), slate("l3b", "Loading project")] },
];

export default function Goals({ vm }: ScreenProps<GoalsVM>) {
  const empty = !vm.loading && vm.goals.length === 0;
  const list = vm.loading
    ? <ul className={css.list} aria-busy="true" aria-label="Loading goals">{GHOSTS.map((g) => <GoalCard key={g.id} goal={g} ghost />)}</ul>
    : <ul className={css.list} aria-label="Goals">{vm.goals.map((g) => <GoalCard key={g.id} goal={g} />)}</ul>;
  return <PmPage>
    <GoalsClient sub={`${vm.period.label} · ${monthRange(vm.period.start, vm.period.end)}`} addGoal={vm.addGoal} initialOpen={!!vm.sheetOpen}
      empty={empty} me={vm.viewer.person.id}>
      {empty ? null : list}
    </GoalsClient>
  </PmPage>;
}

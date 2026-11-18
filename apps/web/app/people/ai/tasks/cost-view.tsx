"use client";
// FIX-PEOPLE-MONEY C5: Work and cost's screen (Codex concept 1, "Side by side"): three tiles, then People and AI
// employees as two columns of ranked rows with a bar, and how each number is worked out in one line. A phone stacks the
// columns. The figures are worked out on the server (lib/work-cost.mjs).
import Link from "next/link";
import { Bot, Calculator, FolderKanban, ListChecks, Users, Wallet } from "lucide-react";
import { GameCard, PageHeader, SegmentedTabLinks, StatTile, StatTiles } from "../../../kit/game";
import { Avatar } from "../../../ui";
import { inr } from "../../../lib/finance-view.mjs";
import { tokensText, type Ai, type People, type ProjectRow, type Rate } from "../../../lib/work-cost.mjs";
import css from "./cost.module.css";

const NB = "\u00a0"; // keeps "4 tasks" and "54 k tokens" on one line
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const month = (ym: string) => `${MON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

export function WorkCostView({ days, weeks, rate, people, ai, projects, noProject = 0, notes }: { days: number; weeks: number; rate: Rate; people: People; ai: Ai;
  /** By project (GET work/cost/projects): null when it could not be read. */ projects: ProjectRow[] | null;
  /** Finished tasks on the cards that belong to no project. */ noProject?: number;
  notes: { people: string | null; ai: string | null; money: string | null } }) {
  const allP = Math.max(1, people.tasks), allA = Math.max(1, ai.tasks); // bars: each one's share of all the tasks
  const shown = people.rows.filter((r) => r.tasks);
  const span = `${weeks}${NB}week${weeks === 1 ? "" : "s"}`;
  const most = Math.max(1, ...(projects ?? []).map((p) => p.people + p.ai)); // project bars: tasks against the busiest
  const busy = ai.rows.filter((r) => r.given || r.tasks), idleAi = ai.rows.length - busy.length;
  return <div className={css.wrap}>
    <PageHeader title="Tasks and cost" subtitle={`What people and AI employees finished in the last ${weeks === 1 ? "week" : `${weeks} weeks`}, and what it cost.`}
      side={<SegmentedTabLinks label="Period" size="sm" className={css.period} items={[1, 2, 4].map((w) => ({ key: String(w * 7), href: `/people/ai/tasks?days=${w * 7}`, label: `${w} week${w === 1 ? "" : "s"}`, current: w * 7 === days }))} />} />

    <StatTiles label="At a glance" min={190} pair>
      <StatTile label="Tasks finished" value={people.tasks + ai.tasks} icon={ListChecks} />
      <StatTile label="People: pay per task" value={people.perTask !== null ? inr(people.perTask) : "Not known"} icon={Users} />
      <StatTile label="AI: tokens per task" value={ai.perTask !== null ? tokensText(ai.perTask) : "None yet"} icon={Bot} />
      <StatTile label={`Payroll for ${span}`} value={people.cost !== null ? inr(people.cost) : "Not known"} icon={Wallet} />
    </StatTiles>

    <div className={css.cols}>
      <GameCard title="People" icon={Users} note={`${people.tasks}${NB}task${people.tasks === 1 ? "" : "s"}`}>
        {notes.people ? <p className={css.empty}>{notes.people}</p> : shown.length ? <ol className={css.rows}>{shown.map((r, n) => <li key={r.id}>
          <Link href={`/tasks/people/${r.id}`}><Avatar name={r.name} id={r.id} photoAt={r.photoAt} size={32} />
            <span className={css.who}><b>{r.name}</b><small className={css.clip} title={r.role ?? undefined}>{r.tasks}{NB}task{r.tasks === 1 ? "" : "s"}<span className={css.role}> · {r.role ?? "Team"}</span></small><i aria-hidden="true"><em style={{ width: `${(r.tasks / allP) * 100}%` }} /></i></span>
            <span className={css.money}>{n ? null : <small>Per task</small>}<b>{r.perTask !== null ? inr(r.perTask) : "—"}</b></span></Link>
        </li>)}</ol> : <p className={css.empty}>Nobody had a task accepted in this period yet.</p>}
        {people.idle ? <p className={css.foot}>{people.idle} {people.idle === 1 ? "person has" : "people have"} no finished tasks in Pulse in this period: most of their work isn’t in tasks yet.</p> : null}
        <p className={css.how}><Calculator size={14} aria-hidden="true" /><span>{rate ? <>About <b>{inr(rate.hourly)} an hour</b> each, from {month(rate.month)}’s payroll ({inr(rate.total)} a month for the {rate.people} people on it). Pay per task = a person’s share ÷ the tasks they finished.</> : <>{notes.money}. Tasks are counted; rupees show once payroll is in the finance model.</>}</span></p>
      </GameCard>

      <div className={css.stack}>
      <GameCard title="AI employees" icon={Bot} note={`${ai.tasks}${NB}task${ai.tasks === 1 ? "" : "s"}`}>
        {notes.ai ? <p className={css.empty}>{notes.ai}</p> : busy.length ? <ol className={css.rows}>{busy.map((r, n) => <li key={r.id}>
          <Link href={`/people/${encodeURIComponent(r.id)}?tab=ai&s=queue`}><Avatar name={r.name} id={r.id} size={32} ai />
            <span className={css.who}><b>{r.name}</b><small>{r.tasks} accepted of {r.given} given{r.returned ? ` · ${r.returned} sent back` : ""}</small><i aria-hidden="true"><em data-ai="" style={{ width: `${(r.tasks / allA) * 100}%` }} /></i></span>
            <span className={css.money}>{n ? null : <small>Per task</small>}<b>{r.inrPerTask !== null ? inr(r.inrPerTask) : r.perTask !== null ? `${tokensText(r.perTask)}${NB}tokens` : "—"}</b></span></Link>
        </li>)}</ol> : <div className={css.emptyBox}><p>{ai.rows.length ? `None of your ${ai.rows.length} AI employees was given a task in this period.` : "No AI employee you can see yet."}</p>
          <Link className={css.action} href="/tasks">Give an AI employee a task</Link></div>}
        {busy.length && idleAi ? <p className={css.foot}>{idleAi} more AI employee{idleAi === 1 ? " was" : "s were"} given no task.</p> : null}
        <p className={css.how}><Calculator size={14} aria-hidden="true" /><span>{ai.inr !== null ? "AI cost per task = what its tokens cost in rupees ÷ the tasks a person accepted." : "AI cost is counted in tokens (how much the AI read and wrote) until its model has a price. Per task = its tokens ÷ the tasks a person accepted."}</span></p>
      </GameCard>

    {projects ? <GameCard title="By project" icon={FolderKanban} note={<span className={css.legend}><span><i aria-hidden="true" />Tasks by people</span>{projects.some((p) => p.ai) ? <span><i aria-hidden="true" data-ai="" />by AI</span> : null}</span>}>
      {projects.length ? <ol className={css.rows}>{projects.slice(0, 8).map((p, n) => <li key={p.id}>
        <Link href={`/projects/${p.id}`}><span className={css.dot} aria-hidden="true"><FolderKanban size={16} /></span>
          <span className={css.who}><b className={css.long}>{p.name}</b><small>{[p.people ? `${p.people}${NB}task${p.people === 1 ? "" : "s"} by people` : "", p.ai ? `${p.ai}${NB}by AI (${tokensText(p.tokens)}${NB}tokens)` : ""].filter(Boolean).join(" · ")}</small>
            <i aria-hidden="true" className={css.split}><em style={{ width: `${(p.people / most) * 100}%` }} /><em data-ai="" style={{ width: `${(p.ai / most) * 100}%` }} /></i></span>
          {p.people ? <span className={css.money}>{n ? null : <small>People’s pay</small>}<b>{p.cost !== null ? inr(p.cost) : "—"}</b></span>
            : <span className={css.money}><small>AI only</small><b>{tokensText(p.tokens)}{NB}tokens</b></span>}</Link>
      </li>)}</ol> : <p className={css.empty}>No finished task belonged to a project in this period.</p>}
      {projects.length > 8 || noProject ? <p className={css.foot}>{[projects.length > 8 ? `${projects.length - 8} more projects had finished tasks.` : "",
        noProject ? `${noProject}${NB}finished task${noProject === 1 ? " had" : "s had"} no project.` : ""].filter(Boolean).join(" ")}</p> : null}
    </GameCard> : null}
      </div>
    </div>
  </div>;
}

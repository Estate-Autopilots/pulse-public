"use client";
// UX-GAMIFY (owner, 9 Nov 2026: "Salesperson pipeline"), after Codex's concept 3 (reports/ux-gamify/concepts/others): a
// salesperson's quotations as one strip of stages (count, rupees, the share of the money in each), the month as tiles
// (pipeline, won, lost, follow-ups due) and the follow-ups as a quest list, missed ones first. Real numbers only: no
// points or ranks between people. The one main action, when there is nothing yet, is to make a quotation.
import Link from "next/link";
import { AlertTriangle, ArrowRight, CalendarClock, Phone, Trophy, Wallet, XCircle } from "lucide-react";
import { EmptyState, GameCard, Quest, QuestList, StatTile, StatTiles, Chip } from "../kit/game";
import { rupees } from "../lib/game.mjs";
import css from "./pipeline-board.module.css";

export type BoardStage = { key: string; label: string; count: number; value: number };
export type BoardFollowUp = { id: string; title: string; when: string; state: "overdue" | "today" | "upcoming" };
const rs = (paise: number) => rupees(Math.round(paise / 100));

export function PipelineBoard({ title, stages, pipeline, won, lost, due, week, followUps, clientWord, more, tiles = true }: {
  title: string; stages: BoardStage[]; pipeline: { count: number; value: number; oldest: number | null }; won: { count: number; value: number };
  lost: { count: number; value: number }; due: number; week: number; followUps: BoardFollowUp[]; clientWord: string; more?: boolean;
  /** The month's tiles; off where the page shows its own (My sales has period tiles). */ tiles?: boolean }) {
  const empty = !stages.some((s) => s.count) && !won.count && !lost.count && !followUps.length;
  const all = stages.reduce((s, x) => s + x.value, 0) || 1;
  return <GameCard title={title} icon={Wallet} note={more ? <Link href="/sales">My sales <ArrowRight size={13} aria-hidden="true" /></Link> : "Right now, whatever the period"}>
    {empty ? <EmptyState art="nothing" title="No quotations yet" text={`Make a quotation for a ${clientWord}. It shows here by stage, with its follow-up calls.`}
      action={{ label: "Make a quotation", href: "/erp/new?type=quotation" }} /> : <>
      <ol className={css.strip} aria-label="Quotations by stage">{stages.map((s) => <li key={s.key} data-key={s.key} data-empty={s.count ? undefined : ""}>
        <span className={css.stageName}>{s.label}</span>
        <b className={css.stageCount}>{s.count}</b>
        <span className={css.stageMoney}>{rs(s.value)}</span>
        <span className={css.stageBar} aria-hidden="true"><i style={{ width: `${Math.round((s.value / all) * 100)}%` }} /></span>
      </li>)}</ol>
      {tiles ? <StatTiles label="This month" min={150} pair>
        <StatTile label="Waiting for an answer" value={rs(pipeline.value)} icon={Wallet} />
        <StatTile label="Won this month" value={rs(won.value)} icon={Trophy} tone={won.count ? "good" : undefined} />
        <StatTile label="Lost this month" value={rs(lost.value)} icon={XCircle} tone={lost.count ? "bad" : undefined} />
        <StatTile label="Follow-ups due" value={due} icon={CalendarClock} tone={due ? "warn" : undefined} />
      </StatTiles> : null}
      {pipeline.oldest ? <p className={css.note}>The oldest quotation has waited {pipeline.oldest} days for an answer.{week ? ` ${week} more follow-ups this week.` : ""}</p> : null}
      {followUps.length ? <QuestList label="Follow-ups">{followUps.map((f) => <Quest key={f.id} state={f.state === "overdue" ? "blocked" : f.state === "today" ? "wait" : "wait"}
        icon={f.state === "overdue" ? AlertTriangle : Phone} color={f.state === "overdue" ? "#E11D48" : f.state === "today" ? "#D97706" : "#6B4CF0"}
        title={<Link href={`/tasks/${f.id}`}>{f.title}</Link>} sub={f.when}
        end={f.state === "overdue" ? <Chip tone="bad">Missed</Chip> : f.state === "today" ? <Chip tone="warn">Today</Chip> : <Chip>Coming up</Chip>} />)}</QuestList> : null}
    </>}
  </GameCard>;
}

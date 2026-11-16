"use client";
// UX-GAMIFY (owner, 9 Nov 2026: "Kazuk's CEO screen: money at risk, today's issues"), after Codex's concept 2
// ("Owner's money desk", reports/ux-gamify/concepts/others): the money at risk leads the tiles (rupees, counting up),
// and today's issues are one quest list at the top (overdue invoices, work not billed, quotations with no answer,
// client issues raised today and same-day alerts), worst first, each with its amount and a way in. The detailed money
// lists stay in the side rail. Amounts arrive in paise (KAZUK-GAPS, services/api/src/project-health.ts).
import Link from "next/link";
import { AlertTriangle, Banknote, CircleCheck, FileWarning, Hourglass, MessageSquareWarning, Receipt } from "lucide-react";
import { Chip, EmptyState, GameCard, Quest, QuestList, StatTile, StatTiles, type Tone } from "../kit/game";
import { rupees } from "../lib/game.mjs";

type MoneyItem = { id: string; number: string | null; buyer: string | null; amount: number; age: number; why?: string; projectId?: string | null };
type MoneyGroup = { count: number; amount: number; items: MoneyItem[] };
export type DeskRisk = { today: string; stallDays: number; atLeast: number; overdue: MoneyGroup; unbilled: MoneyGroup; stalled: MoneyGroup };
export type DeskIssue = { id: string; kind: string; title: string; client: string | null; taskId: string | null; projectId: string | null };
export type DeskAlert = { title: string; detail: string; projectId: string; project: string };
export type DeskTile = { label: string; value: number; tone?: Tone };

const KIND: Record<string, string> = { request: "Request", change: "Change asked", question: "Question", problem: "Problem", blocked: "Blocked" };
const days = (n: number) => n <= 0 ? "today" : n === 1 ? "1 day" : `${n} days`;
const rs = (paise: number) => rupees(Math.round(paise / 100), true);

/** The tiles: the money at risk first (when the viewer may see rupees), then the counts the page already had. */
export function DeskTiles({ risk, tiles }: { risk: DeskRisk | null; tiles: DeskTile[] }) {
  const atRisk = risk ? risk.overdue.amount + risk.unbilled.amount + risk.stalled.amount : 0;
  return <StatTiles label="Key numbers" min={150} pair>
    {risk ? <StatTile label="Money at risk" value={rs(atRisk)} icon={Banknote} tone={atRisk ? "bad" : "good"} /> : null}
    {tiles.filter((t, i) => i === 0 || t.value).map((t) => <StatTile key={t.label} label={t.label} value={t.value} tone={t.value ? t.tone : undefined} />)}
  </StatTiles>;
}

/** Today's issues, worst first: what needs the boss today, each with its amount and a way in. */
export function TodaysIssues({ risk, issues, alerts, clientWord, projectWord }: { risk: DeskRisk | null; issues: DeskIssue[]; alerts: DeskAlert[]; clientWord: string; projectWord: string }) {
  const money = risk ? [
    ...risk.overdue.items.map((x) => ({ x, what: `Chase ${x.buyer ?? "the client"} for ${rs(x.amount)}`, sub: `Invoice ${x.number ?? ""} · ${days(x.age)} past due`, icon: Receipt, state: "blocked" as const, href: `/erp/documents/${x.id}` })),
    ...risk.unbilled.items.map((x) => ({ x, what: `Bill ${x.buyer ?? "the client"} ${rs(x.amount)}`, sub: x.why === "accepted" ? `Quotation ${x.number ?? ""} accepted · no invoice yet` : "Milestone due · no invoice yet", icon: FileWarning, state: "wait" as const,
      href: x.why === "accepted" ? `/erp/documents/${x.id}` : x.projectId ? `/tasks/projects/${x.projectId}` : `/erp/documents/${x.id}` })),
    ...risk.stalled.items.map((x) => ({ x, what: `Follow up ${x.buyer ?? "the client"} on ${rs(x.amount)}`, sub: `Quotation ${x.number ?? ""} · no reply for ${days(x.age)}`, icon: Hourglass, state: "wait" as const, href: `/erp/documents/${x.id}` })),
  ].sort((a, b) => b.x.amount - a.x.amount) : [];
  const count = money.length + issues.length + alerts.length;
  return <GameCard title="Today's issues" icon={AlertTriangle} note={count ? `${count} to look at · biggest first` : undefined}>
    {count ? <QuestList label="Today's issues">
      {money.slice(0, 6).map(({ x, what, sub, icon, state, href }) => <Quest key={`${what}-${x.id}`} state={state} icon={icon} color={state === "blocked" ? "#E11D48" : "#D97706"}
        title={<Link href={href}>{what}</Link>} sub={sub} end={<Chip tone={state === "blocked" ? "bad" : "warn"}>{state === "blocked" ? "Overdue" : "Waiting"}</Chip>} />)}
      {issues.slice(0, 6).map((a) => <Quest key={a.id} state="blocked" icon={MessageSquareWarning} color="#E11D48"
        title={a.taskId ? <Link href={`/tasks/${a.taskId}`}>{a.title}</Link> : a.title}
        sub={<>{a.client ?? `No ${clientWord}`}{a.projectId ? <> · <Link href={`/tasks/projects/${a.projectId}`}>Open the {projectWord}</Link></> : null}</>}
        end={<Chip tone={a.kind === "problem" || a.kind === "blocked" ? "bad" : "warn"}>{KIND[a.kind] ?? a.kind}</Chip>} />)}
      {alerts.slice(0, 6).map((a, i) => <Quest key={`alert-${i}`} state="wait" icon={AlertTriangle} color="#D97706"
        title={<Link href={`/tasks/projects/${a.projectId}`}>{a.title}</Link>} sub={`${a.detail} · ${a.project}`} />)}
    </QuestList> : <EmptyState art="done" title="Nothing needs you today" text={`No money waiting, no ${clientWord} issue and no alert.`} />}
    {money.length > 6 ? <p style={{ margin: 0, fontSize: 13, color: "var(--theme-text-muted)" }}><CircleCheck size={13} aria-hidden="true" /> {money.length - 6} more money items are in Money at risk, on the right.</p> : null}
  </GameCard>;
}

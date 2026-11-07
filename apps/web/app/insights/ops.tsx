"use client";
// WA-NATIVE (1053) + INSIGHTS-2 (1082): Insights → Client operations. Each tab answers one question with one hero visual,
// a few key numbers and a one-line "so what" (INSIGHTS-2, owner 26 Oct: "far stronger, intuitive … less text, every
// number a better visualisation"). Filters (period, pod, segment, client) are shared by every tab and kept in the URL;
// cards loaded into the database show under each tab's own visuals; Patterns is the library PATTERNS mines; "How we
// know" says what it all rests on. Leadership and admins; numbers and names only.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardList, MessageCircle, RefreshCw } from "lucide-react";
import { useOrgZone } from "../org-code";
import { Message, PageHeader, QueryTabs, styles } from "../ui";
import { CardGrid, HowWeKnow } from "./cards";
import { TABS, filterQuery, type Act, type Card, type Facts, type PatternPage, type Runs } from "./facts";
import { FilterBar } from "./filters";
import { Patterns } from "./patterns";
import { Asks, Onboarding, Overview, Path, Recommendations, Waiting, Wrong } from "./views";
import { WorkInsights, type Staff, type WorkSummary } from "./work";
import s from "./insights2.module.css";

type Sop = { step_no: number; step: string; groups: number; observed_share: number; median_hours_from_start: number | null };
type Rec = { id: string; title: string; why: string; evidence: string[]; sop: { title: string; detail: string } };
type Action = { rec: string; kind: "task" | "sop"; ref: string; at: string; by: string | null; title: string | null; status: string | null };
type OldSide = { answers: number; medianMinutes: number; p90Hours: number; wallMinutes: number };
export type OpsData = {
  computedAt: string; groups: number; messages: number; clients: number; from: string | null; to: string | null; native: number;
  path: { top: [string, number][] | null; stages: { stage: string; groups: number; day: number }[];
    days: { startToLive: number | null; briefToCreative: number | null; creativeToApproval: number | null; approvalToLive: number | null; liveToPayment: number | null; revisions: number | null; messages: number | null } };
  waits: { sides: { team?: OldSide; client?: OldSide }; teamAfterHours: number | null; clientByHour: number[]; clientByWeekday: number[]; voiceShare: { team?: number; client?: number } | null };
  asks: { intents: { intent: string; n: number }[]; topics: { topic: string; n: number }[]; firstWeek: { topic: string; n: number }[] };
  wrong: { signals: { kind: string; n: number; groups: number }[]; funds: { asks: number; groups: number }; atRisk: number;
    churn: { clientId: string; client: string; risk: number; negativeShare: number | null; complaints: number; leadQuality: number; stopAsks: number; quietDays: number | null; lastActivity: string | null; groups: number | null; teamMinutes: number | null }[] };
  sop: { steps: Sop[] | null; sopId: string | null; observedId: string | null; proposedId: string | null };
  actions: Action[]; recommendations: Rec[];
};
export type WorkData = { view: string; summary: WorkSummary | null; rows: unknown[]; staff: Staff[]; sub: string };
export type Extra = { facts: Facts | null; factsError: string | null; cards: Card[]; cardActs: Act[]; runs: Runs | null; patterns: PatternPage | null; q: Record<string, string | undefined> };

export function OpsInsights({ data: d, tab, work, extra }: { data: OpsData; tab: string; work?: WorkData; extra: Extra }) {
  const zone = useOrgZone(), router = useRouter();
  const current = TABS.some((t) => t.key === tab) ? tab : "overview", meta = TABS.find((t) => t.key === current)!;
  const f = extra.facts, keep = filterQuery(extra.q);
  const filters = { pod: extra.q.pod, segment: extra.q.segment, client: extra.q.client, since: f?.filters.since ?? undefined };
  const month = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: zone }) : "";
  const needsFacts = !["sop", "chats", "patterns"].includes(current);
  // INSIGHTS-2: "What to change" comes from the confirmed patterns with an action, by value, once the registry has them.
  const top = current === "overview" ? (extra.patterns?.items ?? []).filter((p) => p.status === "confirmed" && p.action) : [];
  const recs = <Recommendations recs={d.recommendations} actions={d.actions} patterns={top} patternActs={extra.patterns?.actions ?? []} />;
  return <>
    <PageHeader title="Insights" context={[`Client operations · ${(f?.groups ?? d.groups).toLocaleString("en-IN")} WhatsApp groups`, `${month(f?.from ?? d.from)} – ${month(f?.to ?? d.to)}`]}
      actions={<><Link className={styles.btn} href="/insights/reports"><ClipboardList size={14} aria-hidden="true" />Reports</Link><Link className={styles.btn} href="/chats/groups"><MessageCircle size={14} aria-hidden="true" />The groups</Link>
        <button type="button" className={styles.btn} onClick={() => router.push(`/insights?tab=${current}${keep ? `&${keep}` : ""}&fresh=1`)} title={`Read ${new Date(f?.computedAt ?? d.computedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: zone })}`}><RefreshCw size={14} aria-hidden="true" />Read again</button></>} />
    <QueryTabs base="/insights" items={TABS.map((t) => ({ key: t.key, label: t.label }))} current={current} keep={keep || undefined} />
    <div className={s.page}>
      <div className={s.qhead}>
        <h2 className={s.question}>{meta.q}</h2>
        {!["chats", "sop", "patterns"].includes(current) ? <FilterBar facets={f?.facets ?? null} groups={f && keep ? f.groups : null} /> : null}
      </div>
      {needsFacts && !f ? <Message text={extra.factsError ?? "This view could not load"} /> : null}
      {f && current === "overview" ? <Overview f={f} d={d} recs={recs} /> : null}
      {f && current === "path" ? <Path f={f} d={d} /> : null}
      {f && current === "waiting" ? <Waiting f={f} /> : null}
      {f && current === "asks" ? <Asks f={f} /> : null}
      {f && current === "wrong" ? <Wrong f={f} d={d} /> : null}
      {current === "sop" ? <Onboarding d={d} /> : null}
      {current === "chats" ? <WorkInsights tab={work?.view ?? "work"} summary={work?.summary ?? null} rows={work?.rows ?? []} staff={work?.staff ?? []} sub={work?.sub ?? ""} /> : null}
      {current === "patterns" ? <Patterns page={extra.patterns} q={extra.q} lead filters={filters} qs={new URLSearchParams(Object.entries(extra.q).filter(([, x]) => x) as [string, string][]).toString()} /> : null}
      {current !== "patterns" ? <CardGrid cards={extra.cards} filters={filters} acts={extra.cardActs} lead /> : null}
      <HowWeKnow runs={extra.runs} groups={f?.groups ?? d.groups} messages={f?.messages ?? d.messages} from={f?.from ?? d.from} to={f?.to ?? d.to} />
    </div>
  </>;
}

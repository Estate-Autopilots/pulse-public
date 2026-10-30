"use client";
// WA-INTEL (1070): what the WhatsApp groups show, on a person's page (their own numbers: leaders, admins and the person
// themself) and on a client's page (the money and the milestones from its groups: leaders and admins). Each panel
// asks the API and draws nothing when the viewer may not see it or there is nothing.
import Link from "next/link";
import { useEffect, useState } from "react";
import { get } from "../chats/net";
import { figureText, type WaFigure } from "../chats/wa-media";
import { Stat } from "../charts";
import { useOrgZone } from "../org-code";
import { Panel, styles } from "../ui";
import o from "./ops.module.css";
import w from "./work.module.css";

type Point = { point: string; why?: string; suggestion?: string };
type Perf = { personId: string; side: "team" | "client"; self: boolean; asOf: string; metrics: Record<string, unknown> & { strengths?: Point[]; coaching?: Point[]; summary?: string; caveats?: string[] };
  work: { owned: number; done: number; open: number; late: number; promises: number; promisesKept: number } | null;
  recent: { kind: string; verdict: string | null; title: string; at: string | null; chatId: string | null; evidence: string[] }[] };
const num = (x: unknown) => typeof x === "number" ? x : null;
const n = (x: unknown) => typeof x === "number" ? x.toLocaleString("en-IN") : "–";
const pct = (x: unknown) => typeof x === "number" ? `${Math.round(x * 100)}%` : "–";
const mins = (x: unknown) => typeof x !== "number" ? "–" : x < 60 ? `${Math.round(x)} min` : `${Math.round(x / 6) / 10} h`;
export const ROLE: Record<string, string> = { owner_director: "Owner or director", marketing_head: "Marketing head", sales_head: "Sales head", sales_manager: "Sales manager", site_manager: "Site manager",
  channel_partner: "Channel partner", accounts: "Accounts", architect: "Architect", assistant: "Assistant", client_servicing: "Client servicing", ads_performance: "Ads and performance",
  design: "Design", video_editing: "Video editing", shoot: "Shoot", content_script: "Content and scripts", leadership: "Leadership", other: "Other", unknown: "Unknown" };

export function ChatPerformance({ personId, first }: { personId: string; first: string; /** the view's name in the page's Workspace */ title?: string }) {
  const [p, setP] = useState<Perf | null>(null);
  useEffect(() => { const a = new AbortController(); get<{ perf: Perf | null }>(`people/${personId}/chat-performance`, a.signal).then((d) => { if (!a.signal.aborted) setP(d.perf); }).catch(() => {}); return () => a.abort(); }, [personId]);
  if (!p) return null;
  const m = p.metrics;
  if (p.side === "client") return <Panel title="In the WhatsApp groups" sub="What the chats show about this contact · internal">
    <div className={`${w.perf} ${o.inset}`}><div className={w.perfStats}>
      <Stat label="Role" value={ROLE[String(m.role)] ?? "–"} note={m.decision_power ? `Decides: ${String(m.decision_power)}` : undefined} />
      <Stat label="Answers in" value={mins(m.median_answer_working_min)} note="Median, working time" />
      <Stat label="Messages" value={n(m.messages)} note={`${n(m.groups)} group${m.groups === 1 ? "" : "s"}`} />
      <Stat label="Mood" value={typeof m.sentiment === "number" ? (m.sentiment > 0.05 ? "Positive" : m.sentiment < -0.05 ? "Negative" : "Neutral") : "–"} />
    </div>{m.summary ? <p className={w.note}>{String(m.summary)}</p> : null}</div>
  </Panel>;
  const kept = p.work?.promises ? p.work.promisesKept / p.work.promises : null;
  return <Panel title={p.self ? "Your work in the WhatsApp groups" : `${first}'s work in the WhatsApp groups`} sub={`What the chats show, with ${String(m.confidence ?? "low")} confidence · calls and offline work leave no trace`}>
    <div className={`${w.perf} ${o.inset}`}>
      <div className={w.perfStats}>
        <Stat label="Messages" value={n(m.messages)} note={`${n(m.groups)} groups · ${n(m.active_months)} months`} />
        <Stat label="Answers clients in" value={mins(m.median_answer_working_min)} note={`Median working time · 90% within ${mins(m.p90_answer_working_min)}`} />
        <Stat label="Work owned" value={n(p.work?.owned)} note={`${pct(p.work?.owned ? p.work.done / p.work.owned : null)} shown done · ${n(p.work?.open)} open`} />
        <Stat label="Promises kept" value={pct(kept)} note={`${n(p.work?.promises)} promise${p.work?.promises === 1 ? "" : "s"} · ${n(p.work?.late)} late`} tone={typeof kept === "number" && kept < 0.6 ? "warning" : undefined} />
        <Stat label="Praise · complaints" value={`${n(m.praise)} · ${n(m.complaints_about)}`} note="About them, from clients" />
        <Stat label="After hours" value={pct(m.after_hours_share)} note="Messages before 10:00, after 19:00 or on Sunday" />
        <Stat label="Client mood in their groups" value={typeof num(m.client_sentiment) === "number" ? (num(m.client_sentiment)! > 0.05 ? "Positive" : num(m.client_sentiment)! < -0.05 ? "Negative" : "Neutral") : "–"}
          note={typeof m.client_negative_share === "number" ? `${pct(m.client_negative_share)} of client messages negative` : undefined} />
        <Stat label="Mistakes in their threads" value={n(m.incidents_caused)} note={`${n(m.decisions_good)} good · ${n(m.decisions_bad)} bad call${m.decisions_bad === 1 ? "" : "s"}`} />
      </div>
      {m.summary ? <p className={w.note}>{String(m.summary)}</p> : null}
      {m.strengths?.length || m.coaching?.length ? <div className={w.points}>
        {m.strengths?.length ? <div><h4>Strengths</h4><ul>{m.strengths.map((x) => <li key={x.point}>{x.point}{x.why ? <small className={w.note}> · {x.why}</small> : null}</li>)}</ul></div> : null}
        {m.coaching?.length ? <div><h4>Coaching points</h4><ul>{m.coaching.map((x) => <li key={x.point}>{x.point}{x.suggestion ? <small className={w.note}> · {x.suggestion}</small> : null}</li>)}</ul></div> : null}
      </div> : null}
      {m.caveats?.length ? <p className={w.note}>{m.caveats.join(" ")}</p> : null}
    </div>
  </Panel>;
}

type Money = { events: { id: string; kind: string; amount: number | null; period: string | null; at: string; bySide: string | null; status: string | null; note: string | null; chatId: string; chat: string; messageId: string | null }[];
  milestones: { kind: string; at: string; delayed: boolean; delayCause: string | null; note: string | null; chatId: string; messageId: string | null; owner: string | null }[]; open: number };
const MONEY: Record<string, string> = { budget_set: "Budget set", budget_change: "Budget changed", topup_request: "Top-up asked", topup_done: "Funds added", payment_request: "Payment asked",
  payment_made: "Paid", payment_promised: "Payment promised", invoice: "Invoice", quotation: "Quotation", price_quote: "Property price quoted", refund: "Refund", dispute: "Dispute", money_owed: "Money owed", other: "Money" };
const STEP: Record<string, string> = { onboarding: "Onboarding", onboarding_call: "Onboarding call", brief: "Brief", material_received: "Material received", page_access: "Page access",
  agreement: "Agreement", shoot_planned: "Shoot planned", shoot_done: "Shoot done", script: "Script", creatives_sent: "Creatives sent", revision: "Revision", approval: "Approval",
  campaign_live: "Campaign live", leads_flowing: "Leads flowing", lead_review: "Lead review", payment: "Payment", invoice: "Invoice", renewal: "Renewal", paused: "Paused",
  resumed: "Resumed", stopped: "Stopped", handover: "Handover", other: "Milestone" };
const CAUSE: Record<string, string> = { client_material: "waiting for material", client_approval: "waiting for approval", client_funds: "waiting for funds", team_delay: "the team was late",
  team_quality: "rework", shoot_logistics: "shoot logistics", tech_platform: "platform or access", scope_change: "scope changed", external: "outside cause", unclear: "cause unclear" };
const PERIOD: Record<string, string> = { per_day: "a day", per_week: "a week", per_month: "a month", one_time: "once", per_unit: "per unit" };
// WA-MEDIA (1100): money read from the files in the groups (screenshots of payments and top-ups, receipts, invoices,
// quotations). An account balance is not money moved, and a failed payment is shown but never added up.
type FileFigure = WaFigure & { id: string; at: string; statedDate: boolean; channelId: string; messageId: string | null; chat: string };
const FILE_MONEY = new Set(["payment", "ad_funds", "receipt", "invoice", "quotation"]), FILE_PAID = new Set(["payment", "ad_funds", "receipt"]);

export function ClientMoney({ clientId }: { clientId: string }) {
  const zone = useOrgZone(), [d, setD] = useState<Money | null>(null), [all, setAll] = useState(false), [files, setFiles] = useState<FileFigure[]>([]);
  useEffect(() => {
    const a = new AbortController();
    get<Money>(`insights/work/clients/${clientId}`, a.signal).then((x) => { if (!a.signal.aborted) setD(x); }).catch(() => {});
    get<{ figures: FileFigure[] }>(`chats/whatsapp/figures?client=${encodeURIComponent(clientId)}&limit=500`, a.signal)
      .then((x) => { if (!a.signal.aborted) setFiles((x.figures ?? []).filter((f) => FILE_MONEY.has(f.kind) && f.unit === "inr")); }).catch(() => {});
    return () => a.abort();
  }, [clientId]);
  if (!d || (!d.events.length && !d.milestones.length && !files.length)) return null;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit", timeZone: zone });
  const rupees = (x: number) => `₹${x.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  const paid = d.events.filter((e) => e.kind === "payment_made" || e.kind === "topup_done").reduce((s, e) => s + (e.amount ?? 0), 0);
  const owed = d.events.filter((e) => (e.kind === "money_owed" || e.kind === "payment_promised" || e.kind === "payment_request") && e.status !== "done").reduce((s, e) => s + (e.amount ?? 0), 0);
  const rows = all ? d.events : d.events.slice(-12);
  const filePaid = files.filter((f) => FILE_PAID.has(f.kind) && f.status !== "failed").reduce((t, f) => t + f.amount, 0);
  return <Panel title="Money and timeline from the chats" sub="Budgets, top-ups, payments, invoices and the project's milestones, as written in the client's groups and read from its files · internal" action={{ href: "/insights?tab=chats", label: "Open work" }}>
    <div className={`${w.perfStats} ${o.inset}`}>
      <Stat label="Paid or added, as written" value={paid ? rupees(paid) : "–"} note={`${n(d.events.length)} money messages`} />
      <Stat label="Asked or promised, not shown paid" value={owed ? rupees(owed) : "–"} tone={owed ? "warning" : undefined} />
      <Stat label="Milestones" value={n(d.milestones.length)} note={`${n(d.milestones.filter((x) => x.delayed).length)} late`} />
      <Stat label="Open work" value={n(d.open)} note="Suggested tasks waiting for review" />
      {files.length ? <Stat label="Paid or added, from files" value={rupees(filePaid)} note={`${n(files.length)} payment, top-up, receipt and invoice files`} /> : null}
    </div>
    <ul className={w.money} aria-label="Money from the chats">{rows.map((e) => <li key={e.id}><time>{day(e.at)}</time>
      <span><Link href={`/chats/whatsapp/${e.chatId}${e.messageId ? `?m=${e.messageId}` : ""}`}>{MONEY[e.kind] ?? e.kind}</Link>{e.note ? ` · ${e.note}` : ""}</span>
      <b>{typeof e.amount === "number" ? `${rupees(e.amount)}${e.period ? ` ${PERIOD[e.period] ?? ""}` : ""}` : ""}</b></li>)}</ul>
    {d.events.length > 12 && !all ? <p className={o.inset}><button type="button" className={styles.btn} onClick={() => setAll(true)}>Show all {d.events.length}</button></p> : null}
    {d.milestones.length ? <><h4 className={`${w.subhead} ${o.inset}`}>Timeline</h4>
      <ul className={w.money} aria-label="Milestones from the chats">{(all ? d.milestones : d.milestones.slice(-10)).map((m, i) => <li key={i} data-late={m.delayed ? "" : undefined}><time>{day(m.at)}</time>
        <span><Link href={`/chats/whatsapp/${m.chatId}${m.messageId ? `?m=${m.messageId}` : ""}`}>{STEP[m.kind] ?? m.kind}</Link>{m.note ? ` · ${m.note}` : ""}</span>
        <b>{m.delayed ? `Late${m.delayCause ? `: ${CAUSE[m.delayCause] ?? m.delayCause}` : ""}` : ""}</b></li>)}</ul></> : null}
    {files.length ? <><h4 className={`${w.subhead} ${o.inset}`}>From files in the groups</h4>
      <ul className={w.money} aria-label="Money from files in the groups">{(all ? files : files.slice(0, 10)).map((f) => <li key={f.id} data-late={f.status === "failed" ? "" : undefined}>
        <time>{day(f.at)}</time>
        <span><Link href={`/chats?channel=${f.channelId}${f.messageId ? `&message=${f.messageId}` : ""}`}>{f.label || f.chat}</Link>{f.statedDate ? "" : " · date sent"}</span>
        <b>{figureText(f)}</b></li>)}</ul>
      {files.length > 10 && !all ? <p className={o.inset}><button type="button" className={styles.btn} onClick={() => setAll(true)}>Show all {files.length}</button></p> : null}</> : null}
  </Panel>;
}

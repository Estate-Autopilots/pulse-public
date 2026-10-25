"use client";
// WA-NATIVE (1053): Insights → Client operations. The story the company's WhatsApp groups tell (how a client is run,
// where time goes, what clients ask, what goes wrong, the onboarding SOP against reality) and six recommendations a
// leader turns into a task or an SOP change in one click. Leadership and admins; numbers and client names only.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, CheckCircle2, ClipboardList, FileCog, Lightbulb, MessageCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { BarList, Columns, Stat } from "../charts";
import { send } from "../chats/net";
import { useOrgZone } from "../org-code";
import { Kpi, Panel, PageHeader, QueryTabs, Tiles, styles } from "../ui";
import o from "./ops.module.css";

type Sop = { step_no: number; step: string; groups: number; observed_share: number; median_hours_from_start: number | null };
type Rec = { id: string; title: string; why: string; evidence: string[]; sop: { title: string; detail: string } };
type Action = { rec: string; kind: "task" | "sop"; ref: string; at: string; by: string | null; title: string | null; status: string | null };
type Side = { answers: number; medianMinutes: number; p90Hours: number; wallMinutes: number };
export type OpsData = {
  computedAt: string; groups: number; messages: number; clients: number; from: string | null; to: string | null; native: number;
  path: { top: [string, number][] | null; stages: { stage: string; groups: number; day: number }[];
    days: { startToLive: number | null; briefToCreative: number | null; creativeToApproval: number | null; approvalToLive: number | null; liveToPayment: number | null; revisions: number | null; messages: number | null } };
  waits: { sides: { team?: Side; client?: Side }; teamAfterHours: number | null; clientByHour: number[]; clientByWeekday: number[]; voiceShare: { team?: number; client?: number } | null };
  asks: { intents: { intent: string; n: number }[]; topics: { topic: string; n: number }[]; firstWeek: { topic: string; n: number }[] };
  wrong: { signals: { kind: string; n: number; groups: number }[]; funds: { asks: number; groups: number }; atRisk: number;
    churn: { clientId: string; client: string; risk: number; negativeShare: number | null; complaints: number; leadQuality: number; stopAsks: number; quietDays: number | null; lastActivity: string | null; groups: number | null; teamMinutes: number | null }[] };
  sop: { steps: Sop[] | null; sopId: string | null; observedId: string | null; proposedId: string | null };
  actions: Action[]; recommendations: Rec[];
};

const STAGE: Record<string, string> = { onboarding: "Onboarding", brief: "Brief & material", shoot: "Shoot", creative: "Creatives sent", revision: "Changes asked", approval: "Client approval", live: "Campaign live", leads: "Leads talk", payment: "Payment" };
const INTENT: Record<string, string> = { request: "Requests", question: "Questions", info: "Updates", deliverable: "Material & creatives", approval: "Approvals", change: "Change requests", complaint: "Complaints", ack: "Acknowledgements", schedule: "Scheduling", payment: "Payments" };
const TOPIC: Record<string, string> = { creative: "Creatives", video: "Video", shoot: "Shoot", ads: "Ads", leads: "Leads", finance: "Money", content: "Content & scripts", project: "Project facts", tech: "Tech & access", legal: "Legal & RERA", logistics: "Logistics", relation: "The relationship" };
const TOPIC_SUB: Record<string, string> = { project: "prices, configurations, RERA, brochures", relation: "who does what, meetings", content: "scripts, captions" };
const SIGNAL: Record<string, string> = { complaint: "Complaints", approval: "Approvals given", payment: "Payments", delay: "“Any update?” delays", lead_quality: "Lead-quality complaints", upsell: "Upsell openings", invoice: "Invoices", churn_risk: "Stop, hold or leaving", quotation: "Quotations", renewal: "Renewals" };
const TABS = [{ key: "overview", label: "Overview" }, { key: "path", label: "Service path" }, { key: "waiting", label: "Who waits" }, { key: "asks", label: "What clients ask" }, { key: "wrong", label: "Where it goes wrong" }, { key: "sop", label: "Onboarding SOP" }];
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const n = (x: number | null | undefined) => typeof x === "number" ? x.toLocaleString("en-IN") : "–";
const pct = (x: number | null | undefined) => typeof x === "number" ? `${Math.round(x * 100)}%` : "–";
const mins = (m: number | null | undefined) => typeof m !== "number" ? "–" : m < 60 ? `${Math.round(m)} min` : `${Math.round(m / 6) / 10} h`;
const daysOf = (h: number | null | undefined) => { if (typeof h !== "number") return "–"; if (h < 24) return `${Math.round(h)} h`; const d = Math.round(h / 2.4) / 10; return `${d} day${d === 1 ? "" : "s"}`; };

export function OpsInsights({ data: d, tab }: { data: OpsData; tab: string }) {
  const zone = useOrgZone(), router = useRouter();
  const current = TABS.some((t) => t.key === tab) ? tab : "overview";
  const month = (iso: string | null) => iso ? new Date(iso).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: zone }) : "";
  const team = d.waits.sides.team, client = d.waits.sides.client, lq = d.wrong.signals.find((s) => s.kind === "lead_quality");
  return <>
    <PageHeader title="Insights" context={[`Client operations, from ${n(d.groups)} WhatsApp groups`, `${n(d.messages)} messages · ${month(d.from)} to ${month(d.to)}`]}
      actions={<><Link className={styles.btn} href="/chats/groups"><MessageCircle size={14} aria-hidden="true" />The groups</Link>
        <button type="button" className={styles.btn} onClick={() => router.push(`/insights?tab=${current}&fresh=1`)} title={`Read ${new Date(d.computedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: zone })}`}><RefreshCw size={14} aria-hidden="true" />Read again</button></>} />
    <QueryTabs base="/insights" items={TABS} current={current} />
    {current === "overview" ? <div className={o.stack}>
      <Tiles count={6}>
        <Kpi label="Group start → campaign live" value={n(d.path.days.startToLive)} unit=" days" note="Median across groups" />
        <Kpi label="Creatives → client approval" value={n(d.path.days.creativeToApproval)} unit=" days" note="The longest wait in the service" tone="warning" href="/insights?tab=path" />
        <Kpi label="The team answers in" value={mins(team?.medianMinutes)} note={`Working time · 90% within ${team?.p90Hours ?? "–"} h`} tone="success" href="/insights?tab=waiting" />
        <Kpi label="Clients answer in" value={mins(client?.medianMinutes)} note={`Working time · 90% within ${client?.p90Hours ?? "–"} h`} href="/insights?tab=waiting" />
        <Kpi label="Lead-quality complaints" value={n(lq?.n)} note={`In ${n(lq?.groups)} groups: the top reason clients turn negative`} tone="danger" href="/insights?tab=wrong" />
        <Kpi label="Clients at churn risk" value={n(d.wrong.atRisk)} note="High on stop asks, negative turns, silence" tone="danger" href="/insights?tab=wrong" />
      </Tiles>
      <Panel title="How a client is actually run" sub={d.path.top?.length ? `The most common path: ${n(d.path.top[0][1])} of ${n(d.groups)} groups` : undefined} action={{ href: "/insights?tab=path", label: "The whole path" }}>
        <div className={o.inset}><Path stages={d.path.stages} groups={d.groups} /></div>
      </Panel>
      <section className={o.recs} aria-label="Recommendations">
        <header className={o.recsHead}><h2><Lightbulb size={18} aria-hidden="true" />What to change</h2><p>Six changes the groups point to. Each becomes a task, or a step proposed in the onboarding SOP for review (nothing changes until a leader makes it active).</p></header>
        <ol className={o.recList}>{d.recommendations.map((r, i) => <RecCard key={r.id} n={i + 1} rec={r} actions={d.actions.filter((a) => a.rec === r.id)} />)}</ol>
      </section>
    </div> : null}
    {current === "path" ? <div className={o.grid}>
      <Panel title="The service, stage by stage" sub="When each stage first shows in a group (median day after the group started) and in how many groups" className={o.wide}><div className={o.inset}><Path stages={d.path.stages} groups={d.groups} wide /></div></Panel>
      <Panel title="How long each step takes" sub="Medians across groups">
        <div className={`${o.stats} ${o.inset}`}>
          <Stat label="Brief → creatives" value={`${n(d.path.days.briefToCreative)} days`} />
          <Stat label="Creatives → approval" value={`${n(d.path.days.creativeToApproval)} days`} tone="warning" />
          <Stat label="Approval → live" value={`${n(d.path.days.approvalToLive)} days`} />
          <Stat label="Live → first payment talk" value={`${n(d.path.days.liveToPayment)} days`} note="Funds are asked for as the campaign starts" />
          <Stat label="Change requests per group" value={n(d.path.days.revisions)} />
          <Stat label="Messages per group" value={n(d.path.days.messages)} />
        </div>
      </Panel>
      <Panel title="The paths groups take" sub="Stage order as it shows in the chats">
        <BarList items={(d.path.top ?? []).slice(0, 8).map(([seq, c], i) => ({ key: String(i), label: seq.split(" → ").map((s) => STAGE[s] ?? s).join(" → "), value: c }))} total={d.groups} />
      </Panel>
    </div> : null}
    {current === "waiting" ? <div className={o.grid}>
      <Panel title="Who waits for whom" sub="Each answer to the other side, in working hours (Mon–Sat 10:00–19:00)">
        <div className={o.inset}><div className={o.versus}>
          <div><h4>The team</h4><b>{mins(team?.medianMinutes)}</b><span>median answer · {n(team?.answers)} answers</span><small>90% within {team?.p90Hours ?? "–"} h · {mins(team?.wallMinutes)} by the clock</small></div>
          <div><h4>Clients</h4><b>{mins(client?.medianMinutes)}</b><span>median answer · {n(client?.answers)} answers</span><small>90% within {client?.p90Hours ?? "–"} h · {mins(client?.wallMinutes)} by the clock</small></div>
        </div>
        <p className={o.lead}>The team is fast; the clock is lost on the client side: approvals, material and funds.</p>
        <div className={o.stats}>
          <Stat label="Team messages after hours" value={pct(d.waits.teamAfterHours)} note="Before 10:00, after 19:00 or on Sunday" />
          <Stat label="Voice notes" value={`${pct(d.waits.voiceShare?.client)} · ${pct(d.waits.voiceShare?.team)}`} note="Of client · team messages" />
        </div></div>
      </Panel>
      <Panel title="When clients write" sub="Client messages by hour of the day">
        <Columns label="Client messages by hour" items={d.waits.clientByHour.map((v, h) => ({ key: String(h), label: h % 3 === 0 ? `${h}` : "", value: v, tip: `${n(v)} messages`, tipSub: `${h}:00–${h + 1}:00` }))} />
      </Panel>
      <Panel title="…and on which day" sub="Client messages by weekday">
        <Columns label="Client messages by weekday" items={d.waits.clientByWeekday.map((v, i) => ({ key: WEEK[i], label: WEEK[i], value: v, tip: `${n(v)} messages`, tipSub: WEEK[i] }))} />
      </Panel>
    </div> : null}
    {current === "asks" ? <div className={o.grid}>
      <Panel title="What clients send and ask" sub="Client messages by what they do">
        <BarList items={d.asks.intents.slice(0, 10).map((x) => ({ key: x.intent, label: INTENT[x.intent] ?? x.intent, value: x.n }))} total={d.asks.intents.reduce((s, x) => s + x.n, 0)} />
      </Panel>
      <Panel title="What it is about" sub="Topics of client messages">
        <BarList items={d.asks.topics.slice(0, 12).map((x) => ({ key: x.topic, label: TOPIC[x.topic] ?? x.topic, sub: TOPIC_SUB[x.topic], value: x.n }))} />
      </Panel>
      <Panel title="The first week" sub="What clients talk about in their first 7 days">
        <BarList items={d.asks.firstWeek.slice(0, 8).map((x) => ({ key: x.topic, label: TOPIC[x.topic] ?? x.topic, sub: TOPIC_SUB[x.topic], value: x.n }))} />
        <p className={`${o.lead} ${o.inset}`}>The first week is about the relationship, the content and the project facts: answer those in the welcome message.</p>
      </Panel>
    </div> : null}
    {current === "wrong" ? <div className={o.grid}>
      <Panel title="What to act on" sub="Signals read from the messages: leads to check, not verdicts">
        <BarList items={d.wrong.signals.filter((s) => !["approval", "payment"].includes(s.kind)).map((s) => ({ key: s.kind, label: SIGNAL[s.kind] ?? s.kind, sub: `in ${n(s.groups)} groups`, value: s.n }))} />
      </Panel>
      <Panel title="The three leaks" sub="Where time and goodwill go; each has a recommendation">
        <div className={`${o.leaks} ${o.inset}`}>
          <Link href="/insights#rec-lead-feedback"><Stat label="Lead quality" value={n(d.wrong.signals.find((s) => s.kind === "lead_quality")?.n)} tone="danger" note={`Complaints in ${n(d.wrong.signals.find((s) => s.kind === "lead_quality")?.groups)} groups: fake, broker, not reachable`} /></Link>
          <Link href="/insights#rec-funds-rule"><Stat label="Funds running out" value={n(d.wrong.funds.asks)} tone="warning" note={`The team asked for funds in ${n(d.wrong.funds.groups)} groups: the single most repeated request`} /></Link>
          <Link href="/insights#rec-one-approver"><Stat label="Waiting for approval" value={`${n(d.path.days.creativeToApproval)} days`} tone="warning" note="Creatives → client approval, the longest wait in the service" /></Link>
        </div>
      </Panel>
      <Panel title="Clients at churn risk" sub={`${n(d.wrong.atRisk)} score high (≥ 50%); internal only`} className={o.wide}>
        <Churn rows={d.wrong.churn} zone={zone} />
      </Panel>
    </div> : null}
    {current === "sop" ? <SopVsReality d={d} /> : null}
  </>;
}

/** The stages in the order they first show, each with the share of groups and its median day. */
function Path({ stages, groups, wide }: { stages: OpsData["path"]["stages"]; groups: number; wide?: boolean }) {
  return <ol className={o.path} data-wide={wide ? "" : undefined}>{stages.map((s) => <li key={s.stage}>
    <i className={o.pathDot} aria-hidden="true" />
    <b>{STAGE[s.stage] ?? s.stage}</b>
    <span>day {s.day < 1 ? "0" : Math.round(s.day)}</span>
    <small>{groups ? `${Math.round(s.groups / groups * 100)}% of groups` : n(s.groups)}</small>
  </li>)}</ol>;
}

function RecCard({ n: no, rec, actions }: { n: number; rec: Rec; actions: Action[] }) {
  const router = useRouter(), [busy, setBusy] = useState<"task" | "sop" | null>(null), [error, setError] = useState("");
  const task = actions.find((a) => a.kind === "task"), sop = actions.find((a) => a.kind === "sop");
  const act = async (kind: "task" | "sop") => {
    setBusy(kind); setError("");
    try { await send("insights/operations/actions", { rec: rec.id, kind }); router.refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  return <li className={o.rec} data-rec={rec.id} id={`rec-${rec.id}`}>
    <span className={o.recNo} aria-hidden="true">{no}</span>
    <div className={o.recBody}>
      <h3>{rec.title}</h3>
      <p>{rec.why}</p>
      <ul className={o.evidence}>{rec.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
      <div className={o.recActions}>
        {task ? <Link className={o.done} href={`/tasks/${task.ref}`}><CheckCircle2 size={15} aria-hidden="true" />Task made{task.by ? ` by ${task.by}` : ""}<ArrowRight size={14} aria-hidden="true" /></Link>
          : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!!busy} onClick={() => void act("task")}><ClipboardList size={14} aria-hidden="true" />{busy === "task" ? "Making the task…" : "Make it a task"}</button>}
        {sop ? <Link className={o.done} href={`/sops/${sop.ref}`}><CheckCircle2 size={15} aria-hidden="true" />Proposed in the SOP<ArrowRight size={14} aria-hidden="true" /></Link>
          : <button type="button" className={styles.btn} disabled={!!busy} onClick={() => void act("sop")} title={`Adds the step “${rec.sop.title}” to the SOP draft for review`}><FileCog size={14} aria-hidden="true" />{busy === "sop" ? "Proposing…" : "Propose in the SOP"}</button>}
      </div>
      {error ? <p className={o.error} role="alert">{error}</p> : null}
    </div>
  </li>;
}

function Churn({ rows, zone }: { rows: OpsData["wrong"]["churn"]; zone: string }) {
  if (!rows.length) return <p className={styles.chartEmpty}>No client scores high on churn risk.</p>;
  return <div className={`${o.tableWrap} ${o.inset}`}><table className={o.table}>
    <thead><tr><th scope="col">Client</th><th scope="col">Risk</th><th scope="col">Why</th><th scope="col">Quiet</th><th scope="col">Last activity</th></tr></thead>
    <tbody>{rows.map((r) => <tr key={r.clientId} data-high={r.risk >= 0.5 ? "" : undefined}>
      <th scope="row"><Link href={`/clients/${r.clientId}`}>{r.client}</Link>{r.groups ? <small>{r.groups} group{r.groups === 1 ? "" : "s"}</small> : null}</th>
      <td><span className={o.risk} style={{ "--w": `${Math.round(r.risk * 100)}%` } as React.CSSProperties}><i aria-hidden="true" />{Math.round(r.risk * 100)}%</span></td>
      <td className={o.why}>{[r.stopAsks ? `${r.stopAsks} stop or hold ask${r.stopAsks === 1 ? "" : "s"}` : "", r.leadQuality ? `${r.leadQuality} on lead quality` : "",
        r.complaints ? `${r.complaints} complaint${r.complaints === 1 ? "" : "s"}` : "", typeof r.negativeShare === "number" && r.negativeShare >= 0.1 ? `${Math.round(r.negativeShare * 100)}% negative` : ""].filter(Boolean).map((w) => <span key={w}>{w}</span>)}</td>
      <td>{typeof r.quietDays === "number" ? `${Math.round(r.quietDays)} days` : "–"}</td>
      <td>{r.lastActivity ? new Date(r.lastActivity).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: zone }) : "–"}</td>
    </tr>)}</tbody>
  </table></div>;
}

function SopVsReality({ d }: { d: OpsData }) {
  const router = useRouter(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const steps = d.sop.steps ?? [];
  const prepare = async () => {
    setBusy(true); setError("");
    try { const r = await send<{ ref: string }>("insights/operations/sop", {}); router.push(`/sops/${r.ref}`); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return <div className={o.grid}>
    <Panel title="The onboarding SOP against what the chats show" sub="Each step: in how many groups the chat shows it, and when (median after the group started)" className={o.wide}
      tools={d.sop.proposedId ? <Link className={styles.btn} href={`/sops/${d.sop.proposedId}`}><FileCog size={14} aria-hidden="true" />The proposed SOP</Link>
        : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void prepare()}><FileCog size={14} aria-hidden="true" />{busy ? "Preparing…" : "Prepare it for review"}</button>}>
      <ol className={`${o.sop} ${o.inset}`}>{steps.map((s) => <li key={s.step_no} data-low={s.observed_share < 0.35 ? "" : undefined}>
        <span className={o.sopNo}>{s.step_no}</span>
        <span className={o.sopName}>{s.step}{s.observed_share < 0.35 ? <small><TriangleAlert size={12} aria-hidden="true" />Rarely visible in the chat</small> : null}</span>
        <span className={o.meter} title={`Seen in ${pct(s.observed_share)} of ${n(s.groups)} groups`}><i style={{ width: pct(s.observed_share) }} /></span>
        <b className={o.sopShare}>{pct(s.observed_share)}</b>
        <span className={o.sopWhen}>{daysOf(s.median_hours_from_start)}</span>
      </li>)}</ol>
      <p className={`${o.lead} ${o.inset}`}>A step done by phone leaves no trace in the chat, so a low share is partly invisible work. The ones to fix first: the onboarding call and its summary, the service agreement, and Page &amp; Business Manager access (asked on day 1, it arrived a median {daysOf(steps.find((s) => s.step_no === 12)?.median_hours_from_start)} in).</p>
      {error ? <p className={`${o.error} ${o.inset}`} role="alert">{error}</p> : null}
    </Panel>
    <Panel title="SOPs for review" sub="Drafts made from the groups; a leader reads, edits and makes them active">
      <ul className={`${o.sopLinks} ${o.inset}`}>
        {d.sop.observedId ? <li><Link href={`/sops/${d.sop.observedId}`}><FileCog size={16} aria-hidden="true" /><span><b>As the groups show it</b><small>The steps the team actually takes, with their timings</small></span></Link></li> : null}
        {d.sop.proposedId ? <li><Link href={`/sops/${d.sop.proposedId}`}><FileCog size={16} aria-hidden="true" /><span><b>Proposed changes</b><small>The SOP with each step measured, and the changes proposed here</small></span></Link></li> : null}
        {d.sop.sopId ? <li><Link href={`/sops/${d.sop.sopId}`}><FileCog size={16} aria-hidden="true" /><span><b>The SOP in use</b><small>What it says today</small></span></Link></li> : null}
      </ul>
    </Panel>
  </div>;
}

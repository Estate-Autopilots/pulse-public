"use client";
// WA-INTEL (1070): Insights → what the WhatsApp groups record about the work itself. Open work as suggested tasks a
// leader turns into a Pulse task for a person they choose (never assigned by itself), decisions judged by what
// followed, mistakes with their root cause and what would have prevented them, the best and worst runs, practices,
// workflows per service and the SOP drafts, and the team's numbers. Leadership and admins; evidence opens the chat.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCircle2, ClipboardList, ExternalLink, FileCog, MessageCircle, RotateCcw, X } from "lucide-react";
import { send } from "../chats/net";
import { useOrgZone } from "../org-code";
import { Badge, Empty, Panel, QueryTabs, styles } from "../ui";
import { Story } from "./cards";
import { Bars, Kpis, Scatter, Split } from "./viz";
import s2 from "./insights2.module.css";
import o from "./ops.module.css";
import { WORK_VIEWS } from "./work-tabs";
import { ROLE } from "./work-panels";
import w from "./work.module.css";

type Counts = { work: number; suggested: number; decisions: number; incidents: number; practices: number; cases: number; finance: number };
type Agg = { kind: string; n: number; groups?: number; high?: number };
export type Summary = {
  groups?: number; workItems?: number; open?: number; doneShare?: number; medianHoursToDone?: number | null; medianWorkingHoursToDone?: number | null;
  promises?: { n: number; kept: number; broken: number }; followUpsPerItem?: number | null; delays?: Agg[]; incidents?: Agg[]; decisions?: Record<string, number>;
  practices?: { good: { practice: string; n: number; groups: number }[]; bad: { practice: string; instead?: string | null; n: number; groups: number }[] };
  workflows?: { service: string; label: string; groups: number; steps: string[]; medianDaysToLive: number | null; best: string[] }[];
  leadership?: string[]; quality?: Record<string, string | number>;
};
export type WorkSummary = { summary: Summary | null; asOf: string | null; counts: Counts; sops: { id: string; title: string; status: string }[] };
export type Learning = { id: string; kind: string; category: string | null; verdict: string | null; title: string; detail: string | null; rootCause: string | null; prevention: string | null;
  outcome: string | null; at: string | null; by: string | null; byId: string | null; bySide: string | null; clientId: string | null; client: string | null; chatId: string | null; chat: string | null;
  evidence: string[]; data: Record<string, unknown> };
export type WorkItem = { id: string; kind: string; title: string; detail: string | null; topic: string | null; status: string; askedAt: string; dueOn: string | null; doneAt: string | null;
  followUps: number; late: boolean | null; stale: boolean; confidence: number | null; reviewState: string; taskId: string | null; askedBy: string | null; askedSide: string | null;
  ownerId: string | null; owner: string | null; ownerSide: string | null; clientId: string | null; client: string | null; chatId: string; chat: string; messageId: string | null };
export type TeamRow = { personId: string; name: string; side: string; metrics: Record<string, unknown> };
export type Staff = { id: string; name: string };

const KIND: Record<string, string> = { task: "Task", request: "Request", deliverable: "Deliverable", promise: "Promise", approval_request: "Approval asked", material_request: "Material asked",
  change_request: "Change", follow_up: "Follow-up" };
const INCIDENT: Record<string, string> = { wrong_creative: "Wrong creative", creative_quality: "Creative quality", missed_deadline: "Missed deadline", broken_promise: "Broken promise",
  wrong_budget: "Wrong budget", wrong_targeting: "Wrong targeting", wrong_info: "Wrong information used", miscommunication: "Miscommunication", lead_quality: "Lead quality",
  funds_ran_out: "Funds ran out", tech_account: "Account or tech problem", approval_stall: "Approval stalled", client_unresponsive: "Client unresponsive", billing_dispute: "Billing dispute", other: "Other" };
const DELAY: Record<string, string> = { client_material: "Waiting for the client's material", client_approval: "Waiting for the client's approval", client_funds: "Waiting for funds",
  team_delay: "The team was late", team_quality: "Rework after a quality problem", shoot_logistics: "Shoot logistics", tech_platform: "Platform or access", scope_change: "Scope changed", external: "Outside cause", unclear: "Unclear" };
const DELAY_SHORT: Record<string, string> = { client_material: "Client's material", client_approval: "Client's approval", client_funds: "Client's funds", team_delay: "Team was late",
  team_quality: "Rework", shoot_logistics: "Shoot logistics", tech_platform: "Platform or access", scope_change: "Scope changed", external: "Outside cause", unclear: "Unclear" };
const AREA: Record<string, string> = { budget: "Budget", targeting: "Targeting", creative: "Creative", shoot: "Shoot", platform: "Platform", pricing: "Pricing", scope: "Scope", timeline: "Timeline",
  process: "Process", staffing: "Who does it", pause_stop: "Pause or stop", other: "Other" };
const VERDICT_TONE: Record<string, "success" | "danger" | "neutral" | "warning"> = { good: "success", best: "success", bad: "danger", worst: "danger", high: "danger", medium: "warning", low: "neutral", neutral: "neutral", unclear: "neutral" };
const VERDICT: Record<string, string> = { good: "Good call", bad: "Bad call", neutral: "Neutral", unclear: "Unclear", best: "Best run", worst: "Worst run", high: "High impact", medium: "Medium impact", low: "Low impact" };

const n = (x: number | null | undefined) => typeof x === "number" ? x.toLocaleString("en-IN") : "–";
const pct = (x: number | null | undefined) => typeof x === "number" ? `${Math.round(x * 100)}%` : "–";
const hrs = (h: number | null | undefined) => typeof h !== "number" ? "–" : h < 24 ? `${Math.round(h)} h` : `${Math.round(h / 2.4) / 10} days`;
const chatHref = (chat: string | null, message?: string | null) => chat ? `/chats/whatsapp/${chat}${message ? `?m=${message}` : ""}` : "#";

export function WorkInsights({ tab, summary, rows, staff, sub }: { tab: string; summary: WorkSummary | null; rows: unknown[]; staff: Staff[]; sub: string }) {
  const s = summary?.summary ?? null, c = summary?.counts;
  if (!c || !c.work) return <Empty icon={MessageCircle} title="Nothing read from the chats yet" text="The work in the WhatsApp groups (tasks, decisions, mistakes, money) shows here once it is loaded." />;
  const kept = s?.promises?.n ? s.promises.kept / s.promises.n : null;
  const done = typeof s?.doneShare === "number" && s.workItems ? Math.round(s.doneShare * s.workItems) : null;
  // INSIGHTS-2: the work in the chats at a glance (key numbers and where the work and the promises end up), then the views.
  return <div className={o.stack}>
    <Kpis items={[
      { label: "Work items in the chats", value: n(c.work), note: `tasks, requests, promises, approvals in ${n(s?.groups)} groups` },
      { label: "Done, as the chat shows", value: pct(s?.doneShare), note: `median ${hrs(s?.medianWorkingHoursToDone)} working time to done`, s: "good" },
      { label: "Promises kept", value: pct(kept), note: `${n(s?.promises?.n)} promises · ${n(s?.promises?.broken)} late or never shown done`, s: kept !== null && kept < 0.6 ? "warn" : undefined },
      { label: "Waiting for review", value: n(c.suggested), note: "open work suggested as tasks", href: "/insights?tab=chats&view=work" },
    ]} />
    <div className={s2.grid}>
      <Story title="Where the work ends up" sub="work items in the chats">
        <Split parts={[{ label: "Done", value: done ?? 0, s: "good" }, { label: "Still open", value: Math.max(0, (s?.workItems ?? 0) - (done ?? 0)), s: "warn" }]} label="Work items done and open" />
      </Story>
      <Story title="Promises" sub="kept, late or never shown done, unclear">
        <Split parts={[{ label: "Kept", value: s?.promises?.kept ?? 0, s: "good" }, { label: "Late or not shown done", value: s?.promises?.broken ?? 0, s: "bad" },
          { label: "Unclear", value: Math.max(0, (s?.promises?.n ?? 0) - (s?.promises?.kept ?? 0) - (s?.promises?.broken ?? 0)), s: "muted" }]} label="Promises" />
      </Story>
    </div>
    <QueryTabs sub base="/insights" keep="tab=chats" param="view" current={tab} items={WORK_VIEWS} label="From the chats" />
    {tab === "work" ? <OpenWork rows={rows as WorkItem[]} staff={staff} sub={sub} counts={c} s={s} /> : null}
    {tab === "decisions" ? <Decisions rows={rows as Learning[]} s={s} sub={sub} /> : null}
    {tab === "mistakes" ? <Mistakes rows={rows as Learning[]} s={s} /> : null}
    {tab === "runs" ? <Runs rows={rows as Learning[]} s={s} sops={summary?.sops ?? []} /> : null}
    {tab === "team" ? <Team rows={rows as TeamRow[]} /> : null}
  </div>;
}

function OpenWork({ rows, staff, sub, counts, s }: { rows: WorkItem[]; staff: Staff[]; sub: string; counts: Counts; s: Summary | null }) {
  return <>
    <Panel title="Suggested tasks" sub="Still open when the chat ends. Make it a task for the person you choose, or dismiss it; nothing is assigned by itself." className={o.wide}
      tools={<QueryTabs sub base="/insights" keep="tab=chats&view=work" param="state" current={sub} items={[{ key: "suggested", label: "To review" }, { key: "accepted", label: "Made tasks" }, { key: "dismissed", label: "Dismissed" }]} />}>
      {rows.length ? <ul className={w.list}>{rows.map((r) => <WorkRow key={r.id} r={r} staff={staff} />)}</ul>
        : <p className={`${styles.chartEmpty} ${o.inset}`}>{sub === "suggested" ? "Nothing waiting: every open item was decided." : "None yet."}</p>}
    </Panel>
  </>;
}

function WorkRow({ r, staff }: { r: WorkItem; staff: Staff[] }) {
  const router = useRouter(), zone = useOrgZone();
  const [open, setOpen] = useState(false), [who, setWho] = useState(r.ownerSide === "team" && r.ownerId ? r.ownerId : ""), [due, setDue] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: zone });
  const act = async (action: "accept" | "dismiss" | "restore") => {
    setBusy(true); setError("");
    try { await send(`insights/work/items/${r.id}`, action === "accept" ? { action, assigneeId: who, dueOn: due || null } : { action }); router.refresh(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return <li className={w.item} data-stale={r.stale ? "" : undefined}>
    <div className={w.itemHead}>
      <Badge tone={r.ownerSide === "client" ? "warning" : "accent"}>{KIND[r.kind] ?? r.kind}</Badge>
      <b>{r.title}</b>
    </div>
    <p className={w.meta}>
      {r.client ? <Link href={`/clients/${r.clientId}`}>{r.client}</Link> : null}
      <span>Asked {day(r.askedAt)}{r.askedBy ? ` by ${r.askedBy}` : ""}</span>
      {r.owner ? <span>{r.ownerSide === "client" ? "The client owes it" : `Owner in the chat: ${r.owner}`}</span> : r.ownerSide === "client" ? <span>The client owes it</span> : null}
      {r.dueOn ? <span>Due {day(r.dueOn)}</span> : null}
      {r.followUps ? <span>{r.followUps} follow-up{r.followUps === 1 ? "" : "s"}</span> : null}
      {r.stale ? <span>The chat went quiet since</span> : null}
      <Link href={chatHref(r.chatId, r.messageId)} title={r.chat}><ExternalLink size={12} aria-hidden="true" />In the chat</Link>
    </p>
    {r.detail ? <p className={w.detail}>{r.detail}</p> : null}
    {r.reviewState === "suggested" ? <div className={w.actions}>
      {open ? <>
        <label>Who does it<select value={who} onChange={(e) => setWho(e.target.value)}><option value="">Choose a person</option>{staff.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Due<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !who} onClick={() => void act("accept")}><ClipboardList size={14} aria-hidden="true" />{busy ? "Making…" : "Make the task"}</button>
        <button type="button" className={styles.btn} disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </> : <>
        <button type="button" className={styles.btn} onClick={() => setOpen(true)}><ClipboardList size={14} aria-hidden="true" />Make it a task</button>
        <button type="button" className={styles.btn} disabled={busy} onClick={() => void act("dismiss")}><X size={14} aria-hidden="true" />Dismiss</button>
      </>}
    </div> : r.reviewState === "accepted" && r.taskId ? <div className={w.actions}><Link className={o.done} href={`/tasks/${r.taskId}`}><CheckCircle2 size={15} aria-hidden="true" />Task made</Link></div>
      : r.reviewState === "dismissed" ? <div className={w.actions}><button type="button" className={styles.btn} disabled={busy} onClick={() => void act("restore")}><RotateCcw size={14} aria-hidden="true" />Back to review</button></div> : null}
    {error ? <p className={o.error} role="alert">{error}</p> : null}
  </li>;
}

function Evidence({ chatId, ids }: { chatId: string | null; ids: string[] }) {
  if (!chatId || !ids.length) return null;
  return <span className={w.evidence}>{ids.slice(0, 4).map((m, i) => <Link key={m} href={chatHref(chatId, m)}>{i === 0 ? "Evidence" : i + 1}</Link>)}</span>;
}

function LearningCard({ r }: { r: Learning }) {
  const zone = useOrgZone();
  return <li className={w.item}>
    <div className={w.itemHead}>{r.verdict ? <Badge tone={VERDICT_TONE[r.verdict] ?? "neutral"}>{VERDICT[r.verdict] ?? r.verdict}</Badge> : null}
      {r.category ? <span className={w.cat}>{AREA[r.category] ?? INCIDENT[r.category] ?? r.category.replace(/_/g, " ")}</span> : null}<b>{r.title}</b></div>
    <p className={w.meta}>{r.client ? <Link href={`/clients/${r.clientId}`}>{r.client}</Link> : null}{r.by ? <span>{r.kind === "incident" ? "Caused by" : "By"} {r.by}</span> : r.bySide && r.bySide !== "unclear" ? <span>{r.kind === "incident" ? "Cause" : "By"}: {r.bySide}</span> : null}
      {r.at ? <span>{new Date(r.at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: zone })}</span> : null}<Evidence chatId={r.chatId} ids={r.evidence} /></p>
    {r.detail ? <p className={w.detail}>{r.detail}</p> : null}
    {r.outcome ? <p className={w.detail}><b>What followed:</b> {r.outcome}</p> : null}
    {r.rootCause ? <p className={w.detail}><b>Root cause:</b> {r.rootCause}</p> : null}
    {r.prevention ? <p className={w.detail}><b>What would have prevented it:</b> {r.prevention}</p> : null}
  </li>;
}

function Decisions({ rows, s, sub }: { rows: Learning[]; s: Summary | null; sub: string }) {
  const d = s?.decisions ?? {};
  return <>
    <Story title="How the decisions turned out" sub="judged by what followed in the chat · pick a part to read the decisions">
      <Split parts={[{ label: "Good calls", value: d.good ?? 0, s: "good" }, { label: "Bad calls", value: d.bad ?? 0, s: "bad" }, { label: "Neutral or unclear", value: (d.neutral ?? 0) + (d.unclear ?? 0), s: "muted" }]} label="Decisions by verdict" />
    </Story>
    <Panel title="Decisions in the chats" sub="Who decided, the context, and what followed" className={o.wide}
      tools={<QueryTabs sub base="/insights" keep="tab=chats&view=decisions" param="verdict" current={sub} items={[{ key: "all", label: "All" }, { key: "bad", label: "Bad" }, { key: "good", label: "Good" }, { key: "neutral", label: "Neutral" }]} />}>
      {rows.length ? <ul className={w.list}>{rows.map((r) => <LearningCard key={r.id} r={r} />)}</ul> : <p className={`${styles.chartEmpty} ${o.inset}`}>None.</p>}
    </Panel>
  </>;
}

function Mistakes({ rows, s }: { rows: Learning[]; s: Summary | null }) {
  return <div className={o.grid}>
    <Story title="What goes wrong" sub="mistakes and incidents by kind" rows={(s?.incidents ?? []).map((x) => ({ kind: INCIDENT[x.kind] ?? x.kind, n: x.n, high: x.high ?? 0, groups: x.groups ?? 0 }))}>
      <Bars rows={(s?.incidents ?? []).map((x) => ({ label: INCIDENT[x.kind] ?? x.kind, value: x.n, sub: `${x.high ? `${n(x.high)} high impact · ` : ""}${n(x.groups)} groups`, s: x.high && x.high / x.n >= 0.3 ? "bad" : "accent" }))} label="Mistakes by kind" />
    </Story>
    <Story title="Why milestones were late" sub="delayed steps by what they waited on · orange = waiting on the client" rows={(s?.delays ?? []).map((x) => ({ cause: DELAY[x.kind] ?? x.kind, n: x.n }))}>
      <Bars rows={(s?.delays ?? []).map((x) => ({ label: DELAY_SHORT[x.kind] ?? DELAY[x.kind] ?? x.kind, value: x.n, note: DELAY[x.kind], s: x.kind.startsWith("client") ? "client" : x.kind.startsWith("team") ? "team" : "muted" }))} label="Late milestones by cause" />
    </Story>
    <Panel title="Mistakes with their root cause" sub="High impact first; each says what would have prevented it" className={o.wide}>
      {rows.length ? <ul className={w.list}>{rows.map((r) => <LearningCard key={r.id} r={r} />)}</ul> : <p className={`${styles.chartEmpty} ${o.inset}`}>None.</p>}
    </Panel>
  </div>;
}

function Runs({ rows, s, sops }: { rows: Learning[]; s: Summary | null; sops: WorkSummary["sops"] }) {
  const best = rows.filter((r) => r.verdict === "best"), worst = rows.filter((r) => r.verdict === "worst");
  return <div className={o.grid}>
    <Panel title="Best runs" sub="Fast to live, happy client, few mistakes: what they did">
      {best.length ? <ul className={w.list}>{best.map((r) => <LearningCard key={r.id} r={r} />)}</ul> : <p className={`${styles.chartEmpty} ${o.inset}`}>None.</p>}
    </Panel>
    <Panel title="Worst runs" sub="Slow, unhappy or lost: what went wrong">
      {worst.length ? <ul className={w.list}>{worst.map((r) => <LearningCard key={r.id} r={r} />)}</ul> : <p className={`${styles.chartEmpty} ${o.inset}`}>None.</p>}
    </Panel>
    <Story title="Practices that helped" sub="seen before fast or happy outcomes · groups where seen">
      <Bars rows={(s?.practices?.good ?? []).slice(0, 10).map((p) => ({ label: p.practice, value: p.groups, s: "good" }))} label="Practices that helped" />
    </Story>
    <Story title="Practices that hurt" sub="seen before rework, delay or complaints · what to do instead">
      <Bars rows={(s?.practices?.bad ?? []).slice(0, 10).map((p) => ({ label: p.practice, value: p.groups, sub: p.instead ? `Instead: ${p.instead}` : undefined, s: "bad" }))} label="Practices that hurt" />
    </Story>
    <Panel title="Workflows per service" sub="The steps as the chats show them, and how long to live" className={o.wide}>
      <div className={`${w.flows} ${o.inset}`}>{(s?.workflows ?? []).map((f) => <section key={f.service}><h4>{f.label}</h4><small>{n(f.groups)} groups · median {n(f.medianDaysToLive)} days to live</small>
        <ol>{f.steps.map((x, i) => <li key={i}>{x}</li>)}</ol></section>)}</div>
    </Panel>
    {sops.length ? <Panel title="SOP drafts for review" sub="Improved SOPs drafted from the evidence; a leader reads, edits and makes them active" className={o.wide}>
      <ul className={`${o.sopLinks} ${o.inset}`}>{sops.map((x) => <li key={x.id}><Link href={`/sops/${x.id}`}><FileCog size={16} aria-hidden="true" /><span><b>{x.title}</b><small>{x.status === "draft" ? "Draft, not active" : x.status}</small></span></Link></li>)}</ul>
    </Panel> : null}
  </div>;
}

function Team({ rows }: { rows: TeamRow[] }) {
  const m = (r: TeamRow, k: string) => r.metrics[k] as number | null | undefined;
  if (!rows.length) return <Empty icon={MessageCircle} title="No colleague has numbers from the chats yet" />;
  const pts = rows.filter((r) => typeof m(r, "median_answer_working_min") === "number" && typeof m(r, "messages") === "number");
  return <div className={o.stack}>
    {pts.length >= 3 ? <Story title="Load against answer time" sub="each colleague: messages in the groups (→) and median answer in working minutes (↑) · bubble = groups · click to open">
      <Scatter points={pts.map((r) => ({ x: m(r, "messages")!, y: m(r, "median_answer_working_min")!, size: m(r, "groups") ?? null, label: r.name, href: `/people/${r.personId}?tab=chats`,
        s: typeof m(r, "promises_kept_share") === "number" && m(r, "promises_kept_share")! < 0.6 ? "warn" : "accent" }))} logY xLabel="Messages" yLabel="Median answer" yUnit="m" label="Colleagues: load and answer time" />
    </Story> : null}
    <Panel title="The team in the chats" sub="What the groups show per colleague. Phone calls and offline work leave no trace, so read it with the confidence shown." className={o.wide}>
    <div className={`${o.tableWrap} ${o.inset}`}><table className={o.table}>
      <thead><tr><th scope="col">Colleague</th><th scope="col">Messages</th><th scope="col">Groups</th><th scope="col">Answers in</th><th scope="col">Owned · done</th><th scope="col">Promises kept</th>
        <th scope="col">Praise · complaints</th><th scope="col">Client mood</th><th scope="col">After hours</th><th scope="col">Confidence</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.personId}>
        <th scope="row"><Link href={`/people/${r.personId}?tab=chats`}>{r.name}</Link>{r.metrics.role ? <small>{ROLE[String(r.metrics.role)] ?? String(r.metrics.role)}</small> : null}</th>
        <td>{n(m(r, "messages"))}</td><td>{n(m(r, "groups"))}</td>
        <td>{typeof m(r, "median_answer_working_min") === "number" ? `${Math.round(m(r, "median_answer_working_min")!)} min` : "–"}</td>
        <td>{n(m(r, "owned"))} · {pct(m(r, "done_share"))}</td>
        <td>{m(r, "promises") ? `${pct(m(r, "promises_kept_share"))} of ${n(m(r, "promises"))}` : "–"}</td>
        <td>{n(m(r, "praise"))} · {n(m(r, "complaints_about"))}</td>
        <td>{typeof m(r, "client_sentiment") === "number" ? (m(r, "client_sentiment")! > 0.05 ? "Positive" : m(r, "client_sentiment")! < -0.05 ? "Negative" : "Neutral") : "–"}</td>
        <td>{pct(m(r, "after_hours_share"))}</td><td>{String(r.metrics.confidence ?? "–")}</td>
      </tr>)}</tbody>
    </table></div>
  </Panel></div>;
}

"use client";
// INSIGHTS-2 (1082): the Client operations tabs, each answering one question with one hero visual, 3-5 key numbers and
// a one-line "so what"; details fold away. Numbers come live from pulse.insight_ops (filtered by period, pod, segment,
// client) and the six recommendations from the company read (1053).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ArrowRight, CheckCircle2, ClipboardList, FileCog, TriangleAlert } from "lucide-react";
import { send } from "../chats/net";
import { styles } from "../ui";
import { activeWindow, baseline, count, days, delta, minutes, pct, rupees } from "../lib/insight-viz.mjs";
import { INTENT, LIVE_BINS, SIGNAL, STAGE, STEP, TOPIC, WAIT_BINS, WEEK, binPos, type Act, type Facts, type Pattern } from "./facts";
import type { OpsData } from "./ops";
import { ActButtons, Story } from "./cards";
import { Bars, Columns, Distribution, Flow, Funnel, Heatmap, Kpis, Line, Scatter, type FlowRow } from "./viz";
import s from "./insights2.module.css";
import { lower } from "../lib/words.mjs";
import { useWords } from "../org-code";

const HOURS = Array.from({ length: 24 }, (_, h) => String(h));
const hourLabel = (h: string) => { const n = Number(h); return n === 0 ? "12a" : n < 12 ? `${n}a` : n === 12 ? "12p" : `${n - 12}p`; };
const step = (f: Facts, k: string) => f.path.steps.find((x) => x.key === k);
const sumN = (xs: { n: number }[]) => xs.reduce((a, x) => a + x.n, 0);
/** The latest quarter against the earlier ones (days to live: lower is better). */
const vsEarlier = (last: number | null | undefined, base: number | null) => { const d = delta(last, base, "down"); return d ? { ...d, text: `${d.text} lately` } : null; };

/** The service as a swimlane: each step from when it usually starts, its median length, a whisker to p90. */
export function flowRows(f: Facts): { rows: FlowRow[]; stall: string | null } {
  const reached = (k: string) => f.path.stages.find((x) => x.stage === k)?.reached ?? null;
  const order: [string, string][] = [["briefToCreative", "creative"], ["creativeToApproval", "approval"], ["approvalToLive", "live"], ["liveToPayment", "payment"]];
  let at = f.path.stages.find((x) => x.stage === "brief")?.p50 ?? 0;
  const rows: FlowRow[] = [];
  for (const [k, stage] of order) { const st = step(f, k); if (!st || typeof st.p50 !== "number" || !st.n) continue;
    rows.push({ stage: STEP[k], start: at, p50: st.p50, p90: st.p90, reached: reached(stage), note: `${count(st.n)} groups measured` }); at += st.p50; }
  const worst = rows.reduce<FlowRow | null>((m, r) => !m || r.p50 > m.p50 ? r : m, null);
  const whole = step(f, "startToLive");
  if (whole && typeof whole.p50 === "number") rows.push({ stage: "The whole way: start → live", start: 0, p50: whole.p50, p90: whole.p90, reached: f.path.live, s: "muted", note: `${count(whole.n)} groups went live` });
  return { rows, stall: worst?.stage ?? null };
}

export function Overview({ f, d, recs }: { f: Facts; d: OpsData; recs: ReactNode }) {
  const live = step(f, "startToLive"), team = f.waits.sides.team, client = f.waits.sides.client, lq = f.wrong.signals.find((x) => x.kind === "lead_quality");
  const trend = f.path.trend.filter((t) => t.n >= 3), base = baseline(trend.map((t) => t.p50)), last = trend[trend.length - 1]?.p50;
  const { rows, stall } = flowRows(f);
  return <div className={s.stack}>
    <Kpis items={[
      { label: "Start → campaign live", value: days(live?.p50), note: `median · 1 in 10 take over ${days(live?.p90)}`, delta: vsEarlier(last, base), href: "/insights?tab=path" },
      { label: "The team answers in", value: minutes(team?.p50), note: `working time · 90% within ${minutes(team?.p90)}`, s: "team", href: "/insights?tab=waiting" },
      { label: "Clients answer in", value: minutes(client?.p50), note: `working time · 90% within ${minutes(client?.p90)}`, s: "client", href: "/insights?tab=waiting" },
      { label: "Clients at churn risk", value: count(d.wrong.atRisk), note: "stop asks, negative turns, silence", href: "/insights?tab=wrong" },
      { label: "Lead-quality complaints", value: count(lq?.n ?? 0), note: `in ${count(lq?.groups ?? 0)} groups`, href: "/insights?tab=wrong" },
    ]} />
    <div className={s.hero}>
      <Story title="Where a client's time goes" sub={`${count(f.path.started)} groups · median days, whisker to the slowest 10%`} wide
        soWhat={stall ? <><b>{stall}</b> is the long wait. Fix the approval rhythm first.</> : undefined}
        rows={rows.map((r) => ({ step: r.stage, startDay: r.start, medianDays: r.p50, p90Days: r.p90, reached: r.reached }))}
        foot={<Link className={s.more} href="/insights?tab=path">The whole path<ArrowRight size={14} aria-hidden="true" /></Link>}>
        <Flow rows={rows} total={f.path.started} stall={stall ?? undefined} />
      </Story>
      <Story title="Who waits for whom" sub="answer time, working hours" rows={(["team", "client"] as const).map((k) => ({ side: k, ...f.waits.sides[k] }))}
        foot={<Link className={s.more} href="/insights?tab=waiting">Answer times in full<ArrowRight size={14} aria-hidden="true" /></Link>}>
        <Versus team={team} client={client} />
      </Story>
    </div>
    {recs}
  </div>;
}

/** The two sides' answer times as two big numbers over a shared bar (median and the slowest 10%). */
function Versus({ team, client }: { team?: Facts["waits"]["sides"]["team"]; client?: Facts["waits"]["sides"]["client"] }) {
  const max = Math.max(team?.p90 ?? 0, client?.p90 ?? 0, 1);
  const bar = (x: typeof team, side: "team" | "client", label: string) => <div className={s.vs}>
    <span className={s.vsLabel}><i data-s={side} />{label}</span>
    <b>{minutes(x?.p50)}</b>
    <span className={s.vsTrack} aria-hidden="true"><i data-s={side} style={{ width: `${Math.max(2, ((x?.p50 ?? 0) / max) * 100)}%` }} /><em data-s={side} style={{ left: `${Math.min(100, ((x?.p90 ?? 0) / max) * 100)}%` }} /></span>
    <small>median · slowest 10% wait over {minutes(x?.p90)} · {count(x?.n ?? 0)} answers</small>
  </div>;
  const ratio = team?.p50 && client?.p50 ? client.p50 / team.p50 : null;
  return <div className={s.versus}>{bar(team, "team", "The team answers clients")}{bar(client, "client", "Clients answer the team")}
    {ratio && ratio > 1.3 ? <p className={s.lead}>Clients take <b>{Math.round(ratio * 10) / 10}×</b> as long: the clock is lost on the client side.</p> : null}</div>;
}

export function Path({ f, d }: { f: Facts; d: OpsData }) {
  const words = useWords();
  const { rows, stall } = flowRows(f), live = step(f, "startToLive"), appr = step(f, "creativeToApproval");
  const trend = f.path.trend.filter((t) => t.n >= 3), best = trend.reduce<typeof trend[number] | null>((m, t) => !m || (t.p50 ?? 1e9) < (m.p50 ?? 1e9) ? t : m, null);
  const stalled = sumN(f.path.stalls), base = baseline(trend.map((t) => t.p50)), last = trend[trend.length - 1]?.p50;
  return <div className={s.stack}>
    <Kpis items={[
      { label: "Start → campaign live", value: days(live?.p50), note: `median · p90 ${days(live?.p90)}`, delta: vsEarlier(last, base) },
      { label: "Waiting for approval", value: days(appr?.p50), note: `creatives → approval · p90 ${days(appr?.p90)}`, s: "client" },
      { label: "Went live", value: pct(f.path.started ? f.path.live / f.path.started : null), note: `${count(f.path.live)} of ${count(f.path.started)} groups` },
      { label: "Went quiet before live", value: count(stalled), note: "no message for 30+ days, never live" },
    ]} />
    <Story title="The service, step by step" sub="bar = median days · whisker = slowest 10% · right = share of groups that got there" wide
      soWhat={stall ? <><b>{stall}</b> holds things up most. <b>Do this:</b> one named approver and a 24-hour review window.</> : undefined}
      rows={rows.map((r) => ({ step: r.stage, startDay: r.start, medianDays: r.p50, p90Days: r.p90, reached: r.reached }))}>
      <Flow rows={rows} total={f.path.started} stall={stall ?? undefined} />
    </Story>
    <div className={s.grid}>
      <Story title="How long going live takes" sub="groups by days from start to live" rows={f.path.liveHist.map((b, i) => ({ days: LIVE_BINS[i], groups: b.n }))}>
        <Columns rows={f.path.liveHist.map((b, i) => ({ x: LIVE_BINS[i], value: b.n, label: LIVE_BINS[i] }))} label="Groups by days to live" yLabel="groups" />
      </Story>
      <Story title="Is it getting faster?" sub="median days start → live, by the quarter the group started" rows={trend.map((t) => ({ quarter: t.quarter, groups: t.n, medianDays: t.p50 }))}>
        <Line rows={trend.map((t) => ({ x: t.quarter.replace("-", " "), value: t.p50 }))} unit="d" label="Days to live by quarter" annotations={best ? [{ x: best.quarter.replace("-", " "), label: `fastest: ${days(best.p50)}` }] : []}
          refLine={base !== null ? { value: base, label: "earlier median" } : undefined} />
      </Story>
      <Story title="Where groups stop" sub="never went live, quiet 30+ days: the last step seen" rows={f.path.stalls.map((x) => ({ step: STAGE[x.stage] ?? x.stage, groups: x.n }))}>
        <Bars rows={f.path.stalls.map((x) => ({ label: STAGE[x.stage] ?? x.stage, value: x.n }))} total={stalled || undefined} s="warn" label="Groups that stopped, by last step" empty="No group went quiet before going live." />
      </Story>
      <Story title={`${words.teams} side by side`} sub="median days start → live" rows={f.waits.pods.map((p) => ({ pod: p.pod, groups: p.groups, medianDaysToLive: p.live }))}>
        <Bars rows={f.waits.pods.filter((p) => typeof p.live === "number").map((p) => ({ label: p.pod === "none" ? `No clear ${lower(words.team)}` : p.pod, value: p.live!, sub: `${count(p.groups)} groups`, bench: live?.p50 ?? null, href: p.pod === "none" ? undefined : `/insights?tab=path&pod=${encodeURIComponent(p.pod)}` }))}
          unit=" d" benchLabel="all groups" label={`Days to live by ${lower(words.team)}`} />
      </Story>
    </div>
    {d.path.top?.length ? <details className={s.details}><summary>The orders groups go through the stages in</summary>
      <Bars rows={d.path.top.slice(0, 8).map(([seq, c]) => ({ label: seq.split(" → ").map((x) => STAGE[x] ?? x).join(" → "), value: c }))} total={d.groups} label="Stage orders" /></details> : null}
  </div>;
}

export function Waiting({ f }: { f: Facts }) {
  const words = useWords();
  const team = f.waits.sides.team, client = f.waits.sides.client;
  const heat = (side: "team" | "client") => f.waits.heat.filter((h) => h.side === side).map((h) => ({ row: String(h.dow), col: String(h.hour), value: h.n }));
  const clientHours = HOURS.map((h) => f.waits.heat.filter((x) => x.side === "client" && x.hour === Number(h)).reduce((a, x) => a + x.n, 0));
  const win = activeWindow(clientHours, 6);
  const band = win ? { from: String(win.start), to: String(win.end - 1), label: `clients' busiest 6 h: ${pct(win.share)}` } : undefined;
  const hist = (side: "team" | "client") => WAIT_BINS.map((b) => f.waits.hist.find((h) => h.side === side && h.lo === b.lo)?.n ?? 0);
  const stages = [...new Set(f.waits.byStage.map((x) => x.stage))].sort((a, b) => Object.keys(STAGE).indexOf(a) - Object.keys(STAGE).indexOf(b));
  const people = f.waits.people.filter((p) => typeof p.p50 === "number" && p.answers >= 5);
  const med = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const pm = med(people.map((p) => p.messages)), py = med(people.map((p) => p.p50!));
  return <div className={s.stack}>
    <Kpis items={[
      { label: "The team answers in", value: minutes(team?.p50), note: `median · p90 ${minutes(team?.p90)}`, s: "team" },
      { label: "Clients answer in", value: minutes(client?.p50), note: `median · p90 ${minutes(client?.p90)}`, s: "client" },
      { label: "Clients' busiest hours", value: win ? `${hourLabel(String(win.start))}–${hourLabel(String(win.end))}` : "–", note: win ? `${pct(win.share)} of client messages` : undefined },
      { label: "Team messages after hours", value: pct(f.waits.afterHours?.team), note: "before 10:00, after 19:00, Sundays" },
    ]} />
    <Story title="How long each side waits for an answer" sub="share of answers by time taken (working hours) · p50 and p90 marked" wide
      soWhat={<>The team mostly answers in minutes; clients take {team?.p50 && client?.p50 ? `${Math.round(client.p50 / team.p50)}×` : "far"} longer. <b>Do this:</b> agree answer windows with clients at onboarding.</>}
      rows={WAIT_BINS.map((b, i) => ({ bin: b.label, team: hist("team")[i], client: hist("client")[i] }))}>
      <Distribution bins={WAIT_BINS.map((b) => b.label)} label="Answer times, team and clients"
        series={[{ key: "team", label: "The team", s: "team", counts: hist("team") }, { key: "client", label: "Clients", s: "client", counts: hist("client") }]}
        markers={[{ s: "team", at: binPos(team?.p50, WAIT_BINS) ?? 0, label: `team p50 ${minutes(team?.p50)}` }, { s: "client", at: binPos(client?.p50, WAIT_BINS) ?? 0, label: `client p50 ${minutes(client?.p50)}` },
          { s: "client", at: binPos(client?.p90, WAIT_BINS) ?? 0, label: `client p90` }]} />
    </Story>
    <div className={s.grid}>
      <Story title="When clients write" sub="client messages by weekday and hour" rows={heat("client").map((h) => ({ weekday: WEEK[Number(h.row) - 1], hour: h.col, messages: h.value }))}
        soWhat={win ? <>Post updates and ask for approvals between <b>{hourLabel(String(win.start))}</b> and <b>{hourLabel(String(win.end))}</b>.</> : undefined}>
        <Heatmap rows={heat("client")} rowKeys={["1", "2", "3", "4", "5", "6", "7"]} colKeys={HOURS} rowLabel={(k) => WEEK[Number(k) - 1]} colLabel={hourLabel} hue="client" band={band} label="Client messages by weekday and hour" unitWord="Messages" colEvery={3} rowTotals />
      </Story>
      <Story title="When the team writes" sub="team messages by weekday and hour, the clients' window marked" rows={heat("team").map((h) => ({ weekday: WEEK[Number(h.row) - 1], hour: h.col, messages: h.value }))}>
        <Heatmap rows={heat("team")} rowKeys={["1", "2", "3", "4", "5", "6", "7"]} colKeys={HOURS} rowLabel={(k) => WEEK[Number(k) - 1]} colLabel={hourLabel} hue="team" band={band} label="Team messages by weekday and hour" unitWord="Messages" colEvery={3} rowTotals />
      </Story>
      <Story title="Who waits, stage by stage" sub="median answer time at each stage" rows={f.waits.byStage.map((x) => ({ stage: STAGE[x.stage] ?? x.stage, side: x.side, answers: x.n, medianMinutes: x.p50 }))}>
        <Columns rows={stages.flatMap((st) => (["team", "client"] as const).map((side) => ({ x: STAGE[st] ?? st, series: side, value: f.waits.byStage.find((b) => b.stage === st && b.side === side)?.p50 ?? 0 })))} unit="m" yLabel="minutes"
          seriesOrder={[{ key: "team", label: "The team", s: "team" }, { key: "client", label: "Clients", s: "client" }]} label="Median answer minutes by stage" />
      </Story>
      <Story title="Load against responsiveness" sub="each colleague: messages written (→) and median answer time (↑) · click to open" rows={people.map((p) => ({ colleague: p.name, pod: p.pod, messages: p.messages, groups: p.groups, answers: p.answers, medianMinutes: p.p50 }))}>
        <Scatter points={people.map((p) => ({ x: p.messages, y: p.p50!, label: p.name, size: p.groups, group: p.pod ?? `No ${lower(words.team)}`, href: `/people/${p.id}?tab=chats` }))} logY
          xLabel="Messages written" yLabel="Median answer" yUnit="m" xRef={pm !== null ? { value: pm, label: "median" } : undefined} yRef={py !== null ? { value: py, label: "median" } : undefined} label="Colleagues: load and answer time" />
      </Story>
    </div>
  </div>;
}

export function Asks({ f }: { f: Facts }) {
  const tot = f.asks.clientMessages || 1, fw = f.asks.firstWeekMessages || 1;
  const intents = f.asks.intents.filter((x) => x.key !== "ack").slice(0, 9), topics = f.asks.topics.slice(0, 10);
  const topFirst = [...f.asks.topics].sort((a, b) => b.firstWeek / fw - a.firstWeek / fw).slice(0, 2);
  const complaints = f.asks.intents.find((x) => x.key === "complaint");
  return <div className={s.stack}>
    <Kpis items={[
      { label: "Client messages", value: count(f.asks.clientMessages, true), note: `${pct(f.asks.firstWeekMessages / tot)} in a group's first week` },
      { label: "Most sent", value: INTENT[intents[0]?.key] ?? "–", note: intents[0] ? `${pct(intents[0].n / tot)} of client messages` : undefined },
      { label: "First-week topic", value: TOPIC[topFirst[0]?.key] ?? "–", note: topFirst[0] ? `${pct(topFirst[0].firstWeek / fw)} of week-one messages` : undefined },
      { label: "Complaints", value: pct(complaints ? complaints.n / tot : null), note: `${count(complaints?.n ?? 0)} client messages` },
    ]} />
    <div className={s.grid}>
      <Story title="What clients send" sub="share of client messages · tick = share in the first week" rows={intents.map((x) => ({ kind: INTENT[x.key] ?? x.key, messages: x.n, share: x.n / tot, firstWeekShare: x.firstWeek / fw }))}>
        <Bars rows={intents.map((x) => ({ label: INTENT[x.key] ?? x.key, value: Math.round(x.n / tot * 1000) / 10, bench: Math.round(x.firstWeek / fw * 1000) / 10, sub: `${count(x.n)} messages` }))} unit="%" benchLabel="first week" label="Client messages by kind" />
      </Story>
      <Story title="What it is about" sub="share of client messages by topic · tick = first week" rows={topics.map((x) => ({ topic: TOPIC[x.key] ?? x.key, messages: x.n, firstWeek: x.firstWeek }))}
        soWhat={topFirst.length ? <>Week one is about <b>{topFirst.map((t) => TOPIC[t.key] ?? t.key).join(" and ")}</b>: answer them in the welcome message.</> : undefined}>
        <Bars rows={topics.map((x) => ({ label: TOPIC[x.key] ?? x.key, value: Math.round(x.n / tot * 1000) / 10, bench: Math.round(x.firstWeek / fw * 1000) / 10 }))} unit="%" benchLabel="first week" s="client" label="Client messages by topic" />
      </Story>
    </div>
  </div>;
}

const LINE_KINDS: { key: string; s: "bad" | "client" | "s4" | "accent" }[] = [{ key: "complaint", s: "accent" }, { key: "lead_quality", s: "client" }, { key: "delay", s: "s4" }];
export function Wrong({ f, d }: { f: Facts; d: OpsData }) {
  const sig = (k: string) => f.wrong.signals.find((x) => x.kind === k);
  const months = [...new Set(f.wrong.months.map((m) => m.month))].sort().slice(-18);
  const series = LINE_KINDS.map((k, i) => ({ key: k.key, label: SIGNAL[k.key], s: (["accent", "client", "s3"] as const)[i] }));
  const lineRows = months.flatMap((m) => LINE_KINDS.map((k) => ({ x: m.slice(2).replace("-", "/"), series: k.key, value: f.wrong.months.find((x) => x.month === m && x.kind === k.key)?.n ?? 0 })));
  const peak = months.reduce<{ m: string; n: number } | null>((best, m) => { const n = f.wrong.months.filter((x) => x.month === m && x.kind === "complaint").reduce((a, x) => a + x.n, 0); return !best || n > best.n ? { m, n } : best; }, null);
  return <div className={s.stack}>
    <Kpis items={[
      { label: "Complaints", value: count(sig("complaint")?.n ?? 0), note: `in ${count(sig("complaint")?.groups ?? 0)} groups` },
      { label: "Lead quality", value: count(sig("lead_quality")?.n ?? 0), note: `complaints in ${count(sig("lead_quality")?.groups ?? 0)} groups`, s: "client" },
      { label: "Funds asked for", value: count(f.wrong.funds.asks), note: `by the team, in ${count(f.wrong.funds.groups)} groups` },
      { label: "Clients at churn risk", value: count(d.wrong.atRisk), note: "risk 50% or more" },
    ]} />
    <Story title="Friction month by month" sub="signals read from client messages" wide rows={lineRows}
      soWhat={<>Lead quality drives complaints. <b>Do this:</b> a weekly lead review on a fixed day.</>}>
      <Line rows={lineRows} series={series} label="Signals by month" annotations={peak && peak.n ? [{ x: peak.m.slice(2).replace("-", "/"), label: `peak: ${peak.n} complaints` }] : []} />
    </Story>
    <div className={s.grid}>
      <Story title="What to act on" sub="signals by kind · leads to check, not verdicts" rows={f.wrong.signals.map((x) => ({ kind: SIGNAL[x.kind] ?? x.kind, n: x.n, groups: x.groups }))}>
        <Bars rows={f.wrong.signals.filter((x) => !["approval", "payment", "invoice", "quotation"].includes(x.kind)).map((x) => ({ label: SIGNAL[x.kind] ?? x.kind, value: x.n, sub: `in ${count(x.groups)} groups`, s: x.kind === "upsell" || x.kind === "renewal" ? "good" : "accent" }))} label="Signals by kind" />
      </Story>
      <Story title="Clients most at risk" sub="churn risk from stop asks, negative turns, silence · click to open" rows={d.wrong.churn.map((r) => ({ client: r.client, risk: r.risk, complaints: r.complaints, leadQuality: r.leadQuality, stopAsks: r.stopAsks, quietDays: r.quietDays }))}>
        <Bars rows={d.wrong.churn.slice(0, 10).map((r) => ({ label: r.client, value: Math.round(r.risk * 100), href: `/clients/${r.clientId}`, s: r.risk >= 0.5 ? "bad" : "warn",
          sub: [r.stopAsks ? `${r.stopAsks} stop asks` : "", r.leadQuality ? `${r.leadQuality} lead quality` : "", typeof r.quietDays === "number" && r.quietDays >= 14 ? `quiet ${Math.round(r.quietDays)} d` : ""].filter(Boolean).join(" · ") || undefined }))}
          unit="%" max={100} label="Clients by churn risk" />
      </Story>
    </div>
  </div>;
}

export function Onboarding({ d }: { d: OpsData }) {
  const router = useRouter(), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const steps = d.sop.steps ?? [];
  const seen = steps.filter((x) => x.observed_share >= 0.66).length, rare = steps.filter((x) => x.observed_share < 0.35);
  const call = steps.find((x) => /onboarding call/i.test(x.step));
  const prepare = async () => { setBusy(true); setErr(""); try { const r = await send<{ ref: string }>("insights/operations/sop", {}); router.push(`/sops/${r.ref}`); } catch (e) { setErr((e as Error).message); setBusy(false); } };
  return <div className={s.stack}>
    <Kpis items={[
      { label: "Steps in the SOP", value: count(steps.length), note: "as written" },
      { label: "Seen in most groups", value: count(seen), note: "in two of three groups or more", s: "accent" },
      { label: "Rarely visible", value: count(rare.length), note: "under a third of groups", s: "warn" },
      { label: "Onboarding call", value: pct(call?.observed_share), note: call ? `of groups · median ${days((call.median_hours_from_start ?? 0) / 24)} in` : undefined },
    ]} />
    <Story title="The onboarding SOP against the chats" sub="share of groups where each step shows · ⚠ under a third" wide
      rows={steps.map((x) => ({ step: x.step_no, title: x.step, groups: x.groups, observedShare: x.observed_share, medianHoursFromStart: x.median_hours_from_start }))}
      soWhat={<>Steps done by phone leave no trace, so a low share is partly invisible work. <b>Fix first:</b> the onboarding call and its summary, the agreement, page access.</>}
      foot={<span className={s.acts}>{d.sop.proposedId ? <Link className={styles.btn} href={`/sops/${d.sop.proposedId}`}><FileCog size={14} aria-hidden="true" />The proposed SOP</Link>
        : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void prepare()}><FileCog size={14} aria-hidden="true" />{busy ? "Preparing…" : "Prepare it for review"}</button>}
        {d.sop.observedId ? <Link className={styles.btn} href={`/sops/${d.sop.observedId}`}>As the groups do it</Link> : null}
        {d.sop.sopId ? <Link className={styles.btn} href={`/sops/${d.sop.sopId}`}>The SOP in use</Link> : null}
        {err ? <span className={s.error} role="alert">{err}</span> : null}</span>}>
      <Funnel rows={steps.map((x) => ({ step: `${x.step_no}. ${x.step}`, value: x.observed_share * 100 }))} total={100} label="SOP steps seen in the chats"
        noteFor={(r) => { const st = steps.find((x) => `${x.step_no}. ${x.step}` === r.step); return st && typeof st.median_hours_from_start === "number" ? `median ${days(st.median_hours_from_start / 24)} after start` : undefined; }} />
    </Story>
  </div>;
}

type Rec = OpsData["recommendations"][number];
/** The six changes the groups point to: three in view, the rest folded; each one click from a task or an SOP step. */
export function Recommendations({ recs, actions, patterns = [], patternActs = [] }: { recs: Rec[]; actions: OpsData["actions"]; patterns?: Pattern[]; patternActs?: Act[] }) {
  const [all, setAll] = useState(false);
  if (patterns.length >= 3) return <section className={s.recs} aria-label="What to change">
    <header className={s.recsHead}><h2>What to change</h2><span>the most valuable confirmed patterns · <Link href="/insights?tab=patterns">all patterns</Link></span></header>
    <ol className={s.recList}>{(all ? patterns : patterns.slice(0, 3)).map((p, i) => <li key={p.id} className={s.rec}>
      <span className={s.recNo} aria-hidden="true">{i + 1}</span>
      <div className={s.recBody}>
        <h3>{p.action}</h3>
        <p>{p.statement}{typeof p.valueInr === "number" ? <> · worth <b>{rupees(p.valueInr)}</b></> : null}</p>
        <div className={s.recActions}><ActButtons path={`insights/library/patterns/${encodeURIComponent(p.id)}/act`} acts={patternActs.filter((a) => a.id === p.id)} /></div>
      </div>
    </li>)}</ol>
    {patterns.length > 3 ? <button type="button" className={s.moreBtn} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${patterns.length}`}</button> : null}
    <details className={s.details}><summary>The six changes read from the groups&rsquo; timings</summary><ol className={s.recList}>{recs.map((r, i) => <RecCard key={r.id} no={i + 1} rec={r} actions={actions.filter((a) => a.rec === r.id)} />)}</ol></details>
  </section>;
  if (!recs.length) return null;
  const shown = all ? recs : recs.slice(0, 3);
  return <section className={s.recs} aria-label="What to change">
    <header className={s.recsHead}><h2>What to change</h2><span>{recs.length} changes the groups point to</span></header>
    <ol className={s.recList}>{shown.map((r, i) => <RecCard key={r.id} no={i + 1} rec={r} actions={actions.filter((a) => a.rec === r.id)} />)}</ol>
    {recs.length > 3 ? <button type="button" className={s.moreBtn} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${recs.length}`}</button> : null}
  </section>;
}

function RecCard({ no, rec, actions }: { no: number; rec: Rec; actions: OpsData["actions"] }) {
  const router = useRouter(), [busy, setBusy] = useState<"task" | "sop" | null>(null), [error, setError] = useState(""), [open, setOpen] = useState(false);
  const task = actions.find((a) => a.kind === "task"), sop = actions.find((a) => a.kind === "sop");
  const act = async (kind: "task" | "sop") => { setBusy(kind); setError(""); try { await send("insights/operations/actions", { rec: rec.id, kind }); router.refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } };
  return <li className={s.rec} id={`rec-${rec.id}`}>
    <span className={s.recNo} aria-hidden="true">{no}</span>
    <div className={s.recBody}>
      <h3>{rec.title}</h3>
      <button type="button" className={s.why} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide why" : "Why"}</button>
      {open ? <><p>{rec.why}</p><ul>{rec.evidence.map((e) => <li key={e}>{e}</li>)}</ul></> : null}
      <div className={s.recActions}>
        {task ? <Link className={s.done} href={`/tasks/${task.ref}`}><CheckCircle2 size={14} aria-hidden="true" />Task made</Link>
          : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!!busy} onClick={() => void act("task")}><ClipboardList size={14} aria-hidden="true" />{busy === "task" ? "Making…" : "Make it a task"}</button>}
        {sop ? <Link className={s.done} href={`/sops/${sop.ref}`}><CheckCircle2 size={14} aria-hidden="true" />In the SOP draft</Link>
          : <button type="button" className={styles.btn} disabled={!!busy} onClick={() => void act("sop")}><FileCog size={14} aria-hidden="true" />{busy === "sop" ? "Proposing…" : "SOP step"}</button>}
      </div>
      {error ? <p className={s.error} role="alert"><TriangleAlert size={13} aria-hidden="true" />{error}</p> : null}
    </div>
  </li>;
}

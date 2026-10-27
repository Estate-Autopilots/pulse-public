"use client";
// WA-NATIVE (1053): a client's health on the client's page, from its groups (live and moved from WhatsApp): the health
// someone set (else read from the churn index), churn risk and why, groups waiting on us, the latest sentiment, recent
// signals. Leadership and admins; nothing for anyone else or when the client has no groups.
import Link from "next/link";
import { useEffect, useState } from "react";
import { HeartPulse } from "lucide-react";
import { get } from "../chats/net";
import { useOrgZone } from "../org-code";
import { Stat } from "../charts";
import { Panel } from "../ui";
import { Columns } from "./viz";
import o from "./ops.module.css";

type Health = { clientId: string; health: "good" | "watch" | "at_risk" | null; groups: number; lastAt: string | null;
  metrics: { churn_risk?: number; negative_share?: number; quiet_days_at_end?: number; team_median_answer_working_min?: number; client_median_answer_working_min?: number; signals?: Record<string, number> } | null;
  waiting: { channelId: string; name: string; who: string | null; since: string }[];
  sentiment: { at: string; sentiment: number; intent: string } | null;
  months: { month: string; positive: number; negative: number; messages: number }[];
  signals: { kind: string; at: string; channelId: string; chat: string; messageId: string | null }[] };
const KIND: Record<string, string> = { complaint: "Complaint", churn_risk: "Stop or hold", delay: "“Any update?”", lead_quality: "Lead quality", upsell: "Upsell opening" };
const WORD = { good: "Healthy", watch: "Watch", at_risk: "At risk" } as const;
const mins = (m?: number) => typeof m !== "number" ? "–" : m < 60 ? `${Math.round(m)} min` : `${Math.round(m / 6) / 10} h`;

export function ClientHealth({ clientId }: { clientId: string }) {
  const zone = useOrgZone(), [h, setH] = useState<Health | null>(null);
  useEffect(() => { const a = new AbortController(); get<{ health: Health | null }>(`insights/clients/${clientId}`, a.signal).then((d) => { if (!a.signal.aborted) setH(d.health); }).catch(() => {}); return () => a.abort(); }, [clientId]);
  if (!h || (!h.groups && !h.metrics)) return null;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: zone });
  const risk = h.metrics?.churn_risk, sig = h.metrics?.signals ?? {};
  const tone = h.health ?? (typeof risk === "number" ? (risk >= 0.5 ? "at_risk" : risk >= 0.3 || (sig.complaint ?? 0) >= 5 ? "watch" : "good") : null);
  const mood = h.sentiment ? (h.sentiment.sentiment > 0 ? "Positive" : h.sentiment.sentiment < 0 ? "Negative" : "Neutral") : null;
  return <Panel title="Client health" sub={`From ${h.groups} group${h.groups === 1 ? "" : "s"}, live and moved from WhatsApp · internal`} action={{ href: "/insights?tab=wrong", label: "All clients" }} className={o.healthPanel}>
    <div className={`${o.health} ${o.inset}`} data-client-health="">
      <div className={o.healthStats}>
        <div className={o.healthHead}>{tone ? <span className={o.badge} data-tone={tone}><HeartPulse size={14} aria-hidden="true" />{WORD[tone]}</span> : null}
          {h.lastAt ? <small>Last message {day(h.lastAt)}</small> : null}</div>
        <Stat label="Churn risk" value={typeof risk === "number" ? `${Math.round(risk * 100)}%` : "–"} tone={typeof risk === "number" && risk >= 0.5 ? "danger" : undefined}
          note={[sig.churn_risk ? `${sig.churn_risk} stop or hold ask${sig.churn_risk === 1 ? "" : "s"}` : "", sig.lead_quality ? `${sig.lead_quality} on lead quality` : "", typeof h.metrics?.quiet_days_at_end === "number" && h.metrics.quiet_days_at_end >= 14 ? `quiet ${Math.round(h.metrics.quiet_days_at_end)} days` : ""].filter(Boolean).join(" · ") || "Nothing alarming"} />
        <Stat label="Waiting on us" value={h.waiting.length ? `${h.waiting.length} group${h.waiting.length === 1 ? "" : "s"}` : "None"} tone={h.waiting.length ? "warning" : "success"} note={h.waiting[0] ? `Longest since ${day(h.waiting[0].since)}` : "The team answered last everywhere"} />
        <Stat label="Latest sentiment" value={mood ?? "–"} tone={mood === "Negative" ? "danger" : mood === "Positive" ? "success" : undefined} note={h.sentiment ? `Client message of ${day(h.sentiment.at)}` : undefined} />
        <Stat label="Answers in" value={`${mins(h.metrics?.team_median_answer_working_min)} · ${mins(h.metrics?.client_median_answer_working_min)}`} note="The team · the client (median, working time)" />
      </div>
      {h.waiting.length || h.signals.length ? <div className={o.healthLists}>
        {h.waiting.length ? <div><h4>Waiting on us</h4><ul className={o.waiting} aria-label="Waiting on us">{h.waiting.slice(0, 4).map((w, i) => <li key={`${w.channelId}-${i}`}><Link href={`/chats?channel=${w.channelId}`} title={w.name}><span>{w.name}</span><small>{w.who ? `${w.who} · ` : ""}since {day(w.since)}</small></Link></li>)}</ul></div> : null}
        {h.signals.length ? <div><h4>Recent signals</h4><ul className={o.signals} aria-label="Recent signals">{h.signals.slice(0, 4).map((s, i) => <li key={i}><Link href={`/chats?channel=${s.channelId}${s.messageId ? `&message=${s.messageId}` : ""}`} title={s.chat}><b data-kind={s.kind}>{KIND[s.kind] ?? s.kind}</b><span>{s.chat}</span><small>{day(s.at)}</small></Link></li>)}</ul></div> : null}
      </div> : null}
      {h.months.length >= 3 ? <div className={o.healthMood}><h4>Client mood by month</h4>
        <Columns rows={[...h.months].reverse().flatMap((m) => [{ x: m.month.slice(2).replace("-", "/"), series: "positive", value: m.positive }, { x: m.month.slice(2).replace("-", "/"), series: "negative", value: m.negative }])}
          seriesOrder={[{ key: "positive", label: "Positive", s: "good" }, { key: "negative", label: "Negative", s: "bad" }]} height={120} label="Client messages by mood and month" /></div> : null}
    </div>
  </Panel>;
}

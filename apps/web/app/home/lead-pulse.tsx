"use client";
// VISIBLE (owner, 25 Oct 2026): three cards for leadership on the Home: groups waiting on us, clients at churn risk and
// what Insights found, each opening the full page. Read after the Home is on screen (the groups and Insights take a
// moment on a busy server); a card that cannot be read says so instead of a number.
import Link from "next/link";
import { useEffect, useState } from "react";
import { Clock3, Lightbulb, TriangleAlert } from "lucide-react";
import { displayName } from "../chats/groups/model";
import css from "./visible.module.css";

type Home = {
  waiting: { count: number; older: number; top: { id: string; name: string; since: string; who: string | null }[] };
  atRisk: { count: number; top: { clientId: string; client: string; risk: number }[] } | null;
  insights: { recommendations: number; first: string | null; signals30d: number; kinds: [string, number][] } | null;
};
const KIND: Record<string, string> = { complaint: "complaints", churn_risk: "stop or leaving", delay: "“any update?”", lead_quality: "lead quality", upsell: "upsell", renewal: "renewals",
  referral: "referrals", payment: "payments", invoice: "invoices", quotation: "quotations", approval: "approvals" };
const since = (iso: string) => { const h = Math.max(0, (Date.now() - Date.parse(iso)) / 3_600_000); return h < 1 ? "just now" : h < 24 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`; };

export function LeadPulse() {
  const [data, setData] = useState<Home | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/v0/insights/home").then((r) => r.ok ? r.json() as Promise<Home> : Promise.reject(new Error(String(r.status))))
      .then((d) => { if (live) setData(d); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  const n = (v: number | undefined) => data ? (v ?? 0).toLocaleString("en-IN") : failed ? "–" : "…";
  return <section className={css.lead} aria-label="Clients and groups" data-lead-pulse="">
    <Link href="/chats/groups?quick=waiting&sort=waiting" className={css.leadCard} data-tone={data?.waiting.count ? "warning" : undefined}>
      <span className={css.leadLabel}><Clock3 size={15} aria-hidden="true" />Waiting on us · 14 days</span>
      <span className={css.leadValue}>{n(data?.waiting.count)}<small>{data?.waiting.count === 1 ? " group" : " groups"}</small></span>
      <ul className={css.leadRows}>{data?.waiting.top.map((g) => <li key={g.id}><span>{displayName(g.name)}</span><small>{g.who ? `${g.who} · ` : ""}{since(g.since)}</small></li>)}</ul>
      {data && !data.waiting.count ? <span className={css.leadQuiet}>Nobody has waited on the team in the last 14 days.</span> : null}
      {data?.waiting.older ? <span className={css.leadQuiet}>{data.waiting.older.toLocaleString("en-IN")} more waiting longer</span> : null}
    </Link>
    <Link href="/insights?tab=wrong" className={css.leadCard} data-tone={data?.atRisk?.count ? "danger" : undefined}>
      <span className={css.leadLabel}><TriangleAlert size={15} aria-hidden="true" />Clients at risk</span>
      <span className={css.leadValue}>{data && !data.atRisk ? "–" : n(data?.atRisk?.count)}<small> at churn risk</small></span>
      <ul className={css.leadRows}>{data?.atRisk?.top.map((c) => <li key={c.clientId}><span>{c.client}</span><small>{Math.round(c.risk * 100)}%</small></li>)}</ul>
      {data && !data.atRisk ? <span className={css.leadQuiet}>Insights read the WhatsApp groups; none are imported yet.</span> : null}
    </Link>
    <Link href="/insights" className={css.leadCard}>
      <span className={css.leadLabel}><Lightbulb size={15} aria-hidden="true" />Insights</span>
      <span className={css.leadValue}>{data && !data.insights ? "–" : n(data?.insights?.recommendations)}<small> changes to make</small></span>
      {data?.insights?.first ? <span className={css.leadFirst}>{data.insights.first}</span> : null}
      {data?.insights?.signals30d ? <span className={css.leadQuiet}>{data.insights.signals30d.toLocaleString("en-IN")} signals in 30 days{data.insights.kinds.length ? `: ${data.insights.kinds.map(([k, c]) => `${c} ${KIND[k] ?? k}`).join(", ")}` : ""}</span> : null}
    </Link>
  </section>;
}

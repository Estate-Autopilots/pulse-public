"use client";
// INSIGHTS-2 (1082): the frame every Insights visual sits in (`Story`: the question, the "so what", the chart, export,
// evidence and the one-click actions), a data-driven card drawn from its spec (`InsightCard`), and the "How we know"
// strip (how much of the chats the numbers rest on, when they were read, and the discovery curve flattening).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { CheckCircle2, ClipboardList, FileCog, Lightbulb, Microscope } from "lucide-react";
import { send } from "../chats/net";
import { useOrgZone } from "../org-code";
import { styles } from "../ui";
import { count, delta as deltaOf } from "../lib/insight-viz.mjs";
import type { Act, Card, Runs } from "./facts";
import { ChartFor, ExportTools, Kpis, Line, type Filters, type KpiItem } from "./viz";
import v from "./viz.module.css";
import s from "./insights2.module.css";

/** One visual with its question, the "so what" in one line, export (PNG / CSV) and optional actions under it. */
export function Story({ title, sub, soWhat, children, rows, foot, className, id, wide }: { title: string; sub?: ReactNode; soWhat?: ReactNode; children: ReactNode; rows?: Record<string, unknown>[]; foot?: ReactNode; className?: string; id?: string; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  return <section className={`${v.card}${className ? ` ${className}` : ""}`} id={id} data-wide={wide ? "" : undefined}>
    <header className={v.cardHead}><h3>{title}{sub ? <small>{sub}</small> : null}</h3><ExportTools target={ref} rows={rows} title={title} /></header>
    {soWhat ? <p className={v.soWhat}><Lightbulb size={15} aria-hidden="true" /><span>{soWhat}</span></p> : null}
    <div ref={ref}>{children}</div>
    {foot ? <div className={v.foot}>{foot}</div> : null}
  </section>;
}

/** Make it a task / an SOP step, or the link to what was made. */
export function ActButtons({ path, acts, area }: { path: string; acts: Act[]; area?: string }) {
  const router = useRouter(), [busy, setBusy] = useState<"task" | "sop" | null>(null), [err, setErr] = useState("");
  const task = acts.find((a) => a.kind === "task"), sop = acts.find((a) => a.kind === "sop");
  const act = async (kind: "task" | "sop") => {
    setBusy(kind); setErr("");
    try { await send(path, { kind, area }); router.refresh(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  return <span className={v.acts}>
    {task ? <Link className={v.done} href={`/tasks/${task.ref}`}><CheckCircle2 size={14} aria-hidden="true" />Task made</Link>
      : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!!busy} onClick={() => void act("task")}><ClipboardList size={14} aria-hidden="true" />{busy === "task" ? "Making…" : "Make it a task"}</button>}
    {sop ? <Link className={v.done} href={`/sops/${sop.ref}`}><CheckCircle2 size={14} aria-hidden="true" />In the SOP draft</Link>
      : <button type="button" className={styles.btn} disabled={!!busy} onClick={() => void act("sop")}><FileCog size={14} aria-hidden="true" />{busy === "sop" ? "Proposing…" : "Make it an SOP step"}</button>}
    {err ? <span className={v.error} role="alert">{err}</span> : null}
  </span>;
}

/** Evidence links: the chats (open in Chats), clients, people, projects a card or pattern rests on. */
export function EvidenceLinks({ ev }: { ev: Record<string, unknown> }) {
  const list = (k: string) => (Array.isArray(ev[k]) ? ev[k] : []) as Record<string, string>[];
  const chats = list("chats"), clients = list("clients"), people = list("people"), projects = list("projects"), msgs = list("messages");
  if (!chats.length && !clients.length && !people.length && !projects.length && !msgs.length) return null;
  return <>
    {msgs.slice(0, 4).map((m, i) => <Link key={m.id} className={v.chip} href={`/chats/whatsapp/${m.chatId}?m=${m.id}`}>Message {i + 1}</Link>)}
    {chats.slice(0, 4).map((c) => <Link key={c.id} className={v.chip} href={`/chats/whatsapp/${c.id}`} title={c.title}>{c.title ?? "Group"}</Link>)}
    {clients.slice(0, 3).map((c) => <Link key={c.id} className={v.chip} href={`/clients/${c.id}`}>{c.name}</Link>)}
    {people.slice(0, 3).map((c) => <Link key={c.id} className={v.chip} href={`/people/${c.id}?tab=chats`}>{c.name}</Link>)}
    {projects.slice(0, 3).map((c) => <Link key={c.id} className={v.chip} href={`/projects/${c.id}`}>{c.name}</Link>)}
  </>;
}

const kpisOf = (k: Record<string, unknown>[]): KpiItem[] => k.slice(0, 5).map((x) => {
  const val = x.value, unit = typeof x.unit === "string" ? x.unit : undefined;
  const d = typeof x.delta === "number" ? { d: x.delta, good: (x.better ?? x.good) === "down" ? x.delta < 0 : x.delta > 0, text: `${x.delta > 0 ? "+" : ""}${typeof x.delta_unit === "string" || typeof x.deltaUnit === "string" ? `${x.delta}${x.delta_unit ?? x.deltaUnit}` : `${Math.round(x.delta * 100)}%`}` }
    : typeof x.before === "number" && typeof val === "number" ? deltaOf(val, x.before, x.better === "down" ? "down" : "up") : null;
  return { label: String(x.label ?? ""), value: typeof val === "number" ? count(val) : String(val ?? "–"), unit, delta: d, note: typeof x.note === "string" ? x.note : undefined };
});

/** A card loaded into the database (by a loader, no code ship), drawn from its spec. */
export function InsightCard({ card, filters, acts, lead }: { card: Card; filters: Filters; acts: Act[]; lead: boolean }) {
  const zone = useOrgZone();
  const wide = ["heatmap", "flow", "line", "sankey", "multiples", "table"].includes(String(card.chart?.kind ?? ""));
  return <Story title={card.title} soWhat={card.soWhat ? <>{card.soWhat}{card.action ? <> <b>Do this:</b> {card.action}</> : null}</> : card.action ? <><b>Do this:</b> {card.action}</> : null}
    rows={Array.isArray(card.data) ? card.data as Record<string, unknown>[] : undefined} wide={wide}
    foot={<><EvidenceLinks ev={card.evidence ?? {}} /><span>Updated {new Date(card.refreshedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: zone })}</span>
      {lead && (card.action || card.soWhat) ? <ActButtons path={`insights/library/cards/${encodeURIComponent(card.id)}/act`} acts={acts} /> : null}</>}>
    {card.kpis?.length ? <div style={{ marginBottom: 12 }}><Kpis items={kpisOf(card.kpis)} /></div> : null}
    <ChartFor chart={card.chart} data={card.data} filters={filters} />
  </Story>;
}

/** The cards loaded for a tab, after its own visuals. */
export function CardGrid({ cards, filters, acts, lead }: { cards: Card[]; filters: Filters; acts: Act[]; lead: boolean }) {
  if (!cards.length) return null;
  return <div className={s.grid}>{cards.map((c) => <InsightCard key={c.id} card={c} filters={filters} lead={lead} acts={acts.filter((a) => a.id === c.id)} />)}</div>;
}

/** How we know: what the numbers rest on, when the chats were read, and how the discovery curve flattens. */
export function HowWeKnow({ runs, groups, messages, from, to }: { runs: Runs | null; groups: number; messages: number; from: string | null; to: string | null }) {
  const zone = useOrgZone();
  const day = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: zone }) : "–";
  const sat = (runs?.saturation ?? []).map((r) => ({ x: `R${r.round ?? ""}`, value: Number(r.cum_confirmed_novel ?? r.cumConfirmedNovel ?? r.confirmed ?? 0) }));
  const roundRuns = (runs?.runs ?? []).filter((r) => r.kind === "round");
  // the curve: the run's saturation list if one carries it, else each round's distinct confirmed count (stats or counts)
  const num = (x: unknown) => typeof x === "number" ? x : Number(x ?? NaN);
  const curve = sat.length ? sat : roundRuns.map((r) => ({ x: `R${r.round ?? ""}`, value: [r.stats?.confirmedNovel, r.counts?.novel_confirmed, r.stats?.confirmed, r.counts?.confirmed].map(num).find((n) => Number.isFinite(n)) ?? 0 }));
  const p = runs?.patterns;
  return <section className={s.how} aria-label="How we know">
    <div className={s.howHead}><Microscope size={16} aria-hidden="true" /><b>How we know</b></div>
    <dl className={s.howFacts}>
      <div><dt>Rests on</dt><dd>{count(groups)} groups · {count(messages, true)} messages</dd></div>
      <div><dt>Covers</dt><dd>{day(from)} – {day(to)}</dd></div>
      <div><dt>Chats last read</dt><dd>{day(runs?.data?.readAt)}</dd></div>
      <div><dt>Patterns</dt><dd>{p && (p.confirmed || p.candidate) ? `${count(p.confirmed)} confirmed · ${count(p.candidate)} candidates` : "Mining in progress"}</dd></div>
    </dl>
    {curve.length >= 2 ? <div className={s.howCurve}><small>Confirmed patterns after each mining round: flat = saturated</small><Line rows={curve} height={90} label="Confirmed patterns by round" area /></div>
      : <p className={s.howNote}>Each mining round adds patterns until three rounds in a row add almost nothing; the curve shows here as rounds finish.</p>}
  </section>;
}

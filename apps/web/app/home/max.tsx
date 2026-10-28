"use client";

import Link from "next/link";
import { useState, type CSSProperties, type ReactNode } from "react";
import { ArrowUpRight, Banknote, Building2, CalendarCheck, ChevronRight, FileText, Folder, Landmark, ListTodo, RefreshCw, Users } from "lucide-react";
import type { Brief, Icon, Move, Row } from "./brain";
import type { Kpi, MaxData, Month } from "./deep";
import { inrShort } from "./brain";
import css from "./home.module.css";

const ICONS: Record<Icon, typeof Banknote> = { money: Banknote, bank: Landmark, doc: FileText, people: Users, renew: RefreshCw, task: ListTodo, client: Building2, folder: Folder, leave: CalendarCheck };
const DEEPER = [{ label: "Delivery", href: "/dashboard?mode=max&tab=delivery" }, { label: "People", href: "/dashboard?mode=max&tab=people" }, { label: "Finance", href: "/finance" }, { label: "Leads & pipes", href: "/dashboard?mode=max&tab=research" }];

/** OWNER-HOME: Max mode. The same brain and the same calm surfaces as Focus, but the whole field at once: six numbers,
 *  money over time, who owes what, every ranked move (keys 1–9), the team and what stands between Pulse and the truth. */
export function MaxBody({ data, brief, onOpen, act }: { data: MaxData; brief: Brief; onOpen: (id: string) => void; act: (m: Move) => void }) {
  const sheets = new Set(brief.allGlance.map((g) => g.id));
  let i = 0; const at = () => ({ "--i": i++ } as CSSProperties);
  return (
    <div className={css.maxGrid}>
      <section className={css.kpis} aria-label="Key numbers">
        {data.kpis.map((k, n) => <KpiTile key={k.id} k={k} n={n} onOpen={sheets.has(k.id) ? () => onOpen(k.id) : undefined} />)}
      </section>

      {data.months.length ? <Panel title={data.months.some((m) => m.collected !== null) ? "Invoiced and collected" : "Invoiced against costs"} note="last 9 months" href="/finance?tab=revenue" span="money" style={at()}>
        <MoneyChart months={data.months} avgCost={data.avgCost} />
      </Panel> : null}
      {data.aging.length ? <Panel title="Owed by age" note={data.agingTotal} href="/finance?tab=revenue" span="side" style={at()}>
        <div className={css.ages}>{data.aging.map((a, n) => <div key={a.title} className={css.age} style={{ "--j": n } as CSSProperties}>
          <span className={css.ageHead}><span>{a.title}</span><b data-tone={a.tone}>{a.value}</b></span>
          <span className={css.ageTrack}><i data-tone={a.tone} style={{ "--w": `${Math.max(2, a.share * 100)}%` } as CSSProperties} /></span>
          <span className={css.rowSub}>{a.sub}</span>
        </div>)}</div>
      </Panel> : null}

      <Panel title="Up next" note={`${brief.queue.length} ranked`} span="queue" style={at()}>
        {brief.queue.length ? <ol className={css.queue}>{brief.queue.map((m, n) => { const I = ICONS[m.icon]; return (
          <li key={m.id} style={{ "--i": n } as CSSProperties}>
            <button type="button" className={css.qRow} onClick={() => act(m)}>
              <kbd className={css.kbd}>{n + 1}</kbd>
              <span className={css.qIcon} data-tone={m.tone}><I size={16} aria-hidden="true" /></span>
              <span className={css.qTitle}>{m.title}{m.admin ? <small className={css.qAdmin}> · as admin</small> : null}</span>
              <span className={css.qCta}>{m.cta}<ChevronRight size={14} aria-hidden="true" /></span>
            </button>
          </li>); })}</ol> : <p className={css.empty}>You&apos;re clear.</p>}
      </Panel>
      <Panel title="Who owes the most" href="/finance?tab=revenue" span="mid" style={at()}><MiniRows rows={data.clients} empty="Nobody owes us anything." /></Panel>
      {data.team ? <Panel title="Team today" href="/hr" span="narrow" style={at()}>
        <div className={css.teamTop}>
          <Ring value={data.team.present} total={data.team.headcount} />
          <span className={css.teamText}><b>{data.team.present}</b> of {data.team.headcount} in<small>{[data.team.away ? `${data.team.away} on leave` : "", data.team.pending ? `${data.team.pending} to decide` : ""].filter(Boolean).join(" · ") || "nothing waiting"}</small></span>
        </div>
        <MiniRows rows={data.team.rows} empty="Nobody has checked in yet." />
      </Panel> : null}

      {data.fix.length ? <Panel title="Fix to trust the numbers" note={`${data.fix.length}`} span="half" style={at()}><MiniRows rows={data.fix} action /></Panel> : null}
      <Panel title="Your tasks" href="/tasks" span="quarter" style={at()}><MiniRows rows={brief.tasks} empty="No open tasks. Nice." /></Panel>
      <Panel title="Projects" href="/projects" span="quarter" style={at()}><MiniRows rows={brief.projects} empty="No project activity this week." /></Panel>

      <nav className={css.deeper} aria-label="Deeper views" style={at()}>
        <span className={css.label}>Go deeper</span>
        {DEEPER.map((d) => <Link key={d.label} href={d.href} className={css.chip}>{d.label}<ArrowUpRight size={14} aria-hidden="true" /></Link>)}
      </nav>
    </div>
  );
}

function Panel({ title, note, href, span, style, children }: { title: string; note?: string; href?: string; span: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <section className={css.panel} data-span={span} style={style} aria-label={title}>
      <header className={css.panelHead}>
        <span className={css.panelTitle}>{title}</span>
        {note ? <span className={css.panelNote}>{note}</span> : null}
        {href ? <Link href={href} className={css.panelGo} aria-label={`Open ${title}`}><ArrowUpRight size={16} /></Link> : null}
      </header>
      {children}
    </section>
  );
}

function KpiTile({ k, n, onOpen }: { k: Kpi; n: number; onOpen?: () => void }) {
  const body = <>
    <ArrowUpRight className={css.arrow} size={16} aria-hidden="true" />
    <span className={css.label}>{k.label}</span>
    <span className={css.kpiValue} data-tone={k.tone}>{k.value}</span>
    {k.viz ? <span className={css.viz} aria-hidden="true">{k.viz.filter((v) => v.weight > 0).map((v, j) => <i key={j} data-tone={v.tone} style={{ flexGrow: v.weight, "--j": j } as CSSProperties} />)}</span>
      : k.spark ? <Spark values={k.spark} /> : <span className={css.viz} aria-hidden="true"><i data-tone="muted" style={{ flexGrow: 1 }} /></span>}
    <span className={css.sub}>{k.sub}</span>
  </>;
  const style = { "--i": n } as CSSProperties;
  return onOpen ? <button type="button" className={`${css.card} ${css.kpi}`} style={style} onClick={onOpen}>{body}</button>
    : <Link href={k.href} className={`${css.card} ${css.kpi}`} style={style}>{body}</Link>;
}

/** A six-pixel sparkline drawn as columns, so it sits in the same slot as the other cards' bars. */
function Spark({ values }: { values: number[] }) {
  const top = Math.max(1, ...values);
  return <span className={css.spark} aria-hidden="true">{values.map((v, j) => <i key={j} style={{ "--h": `${Math.max(8, (v / top) * 100)}%`, "--j": j } as CSSProperties} data-last={j === values.length - 1 ? "" : undefined} />)}</span>;
}

function Ring({ value, total }: { value: number; total: number }) {
  const r = 22, c = 2 * Math.PI * r, share = total ? value / total : 0;
  return <svg className={css.ring} width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
    <circle cx="28" cy="28" r={r} className={css.ringTrack} />
    <circle cx="28" cy="28" r={r} className={css.ringFill} style={{ strokeDasharray: c, "--off": c * (1 - share), "--c": c } as CSSProperties} />
  </svg>;
}

function MoneyChart({ months, avgCost }: { months: Month[]; avgCost: number | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = Math.max(1, ...months.map((m) => Math.max(m.invoiced, m.collected ?? 0)), avgCost ?? 0) * 1.08;
  const pick = hover ?? months.length - 1, p = months[pick];
  const collected = months.some((m) => m.collected !== null);
  return (
    <div className={css.chart}>
      <div className={css.chartRead} aria-live="polite">
        <span className={css.chartMonth}>{p.label}{p.partial ? <small> so far</small> : null}</span>
        <span><i className={css.key} data-tone="accent" />Invoiced <b>{inrShort(p.invoiced)}</b></span>
        {collected ? <span><i className={css.key} data-tone="good" />Collected <b>{p.collected === null ? "not yet known" : inrShort(p.collected)}</b></span> : null}
        {avgCost !== null ? <span><i className={css.key} data-tone="cost" />Costs <b>{inrShort(avgCost)}</b> a month</span> : null}
      </div>
      <div className={css.plot} onPointerLeave={() => setHover(null)}>
        {avgCost !== null ? <span className={css.costLine} style={{ "--y": `${(avgCost / top) * 100}%` } as CSSProperties} aria-hidden="true" /> : null}
        {months.map((m, j) => (
          <button key={m.label} type="button" className={css.col} data-on={pick === j ? "" : undefined} onPointerEnter={() => setHover(j)} onFocus={() => setHover(j)} onBlur={() => setHover(null)}
            aria-label={`${m.label}${m.partial ? " so far" : ""}: invoiced ${inrShort(m.invoiced)}${collected ? `, collected ${m.collected === null ? "not known" : inrShort(m.collected)}` : ""}`} style={{ "--j": j } as CSSProperties}>
            <span className={css.bars}>
              <i data-tone="accent" style={{ "--h": `${(m.invoiced / top) * 100}%` } as CSSProperties} />
              {collected ? <i data-tone="good" style={{ "--h": `${((m.collected ?? 0) / top) * 100}%` } as CSSProperties} /> : null}
            </span>
            <span className={css.colLabel}>{m.label.split(" ")[0]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MiniRows({ rows, empty, action }: { rows: Row[]; empty?: string; action?: boolean }) {
  if (!rows.length) return <p className={css.empty}>{empty ?? "Nothing here yet."}</p>;
  return <div className={css.mini}>{rows.map((r, n) => {
    const body = <><i className={css.dot} data-tone={r.tone} /><span className={css.rowText}><span className={css.rowTitle}>{r.title}</span><span className={css.rowSub}>{r.sub}</span></span>
      <span className={action ? css.miniAction : css.rowValue} data-tone={r.tone}>{r.value}{action ? <ChevronRight size={14} aria-hidden="true" /> : null}</span></>;
    return r.href ? <Link key={n} href={r.href} className={css.miniRow} style={{ "--i": n } as CSSProperties}>{body}</Link> : <div key={n} className={css.miniRow} style={{ "--i": n } as CSSProperties}>{body}</div>;
  })}</div>;
}

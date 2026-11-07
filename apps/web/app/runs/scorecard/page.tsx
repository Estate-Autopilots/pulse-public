import Link from "next/link";
import { apiV1 } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import css from "../team.module.css";

type Metric = { key: string; label: string; kind: "on-time" | "first-time" | "revisions" | "verdict" | "count"; note: string | null; total: { n: number; value: number | null }; people: { personId: string; name: string; n: number; value: number | null }[] };
type Card = { from: string; to: string; processes: { processId: string; process: string; metrics: Metric[] }[] };

const value = (m: Metric, v: number | null) => v === null ? "—" : m.kind === "revisions" ? v.toFixed(1) : m.kind === "count" ? String(Math.round(v)) : `${Math.round(v)}%`;
const unit = (m: Metric) => m.kind === "revisions" ? "per deliverable" : m.kind === "count" ? "" : "";
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => { const d = new Date(`${iso}T00:00:00`); return `${d.getDate()} ${MONTH[d.getMonth()]}`; };

/** FLOW-C: the scorecard, for leadership: each process's numbers from its steps' events (done on time, confirmed the
 *  first time, changes per deliverable, review verdicts), for the whole team and per person. Live runs only. */
export default async function ScorecardPage({ searchParams }: { searchParams: Promise<{ processId?: string; from?: string; to?: string }> }) {
  const q = await searchParams;
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => typeof v === "string" && v) as [string, string][]).toString();
  const r = await apiV1<Card>(`/v1/flow/scorecard${qs ? `?${qs}` : ""}`);
  if (!r.data) return <Message text={r.error ?? "The scorecard did not load."} />;
  const card = r.data, procs = card.processes.filter((p) => p.metrics.length);
  const counted = procs.reduce((n, p) => n + p.metrics.reduce((k, m) => k + m.total.n, 0), 0);
  return <Page>
    <PageHeader title="Scorecard" back={{ href: "/runs", label: "Runs" }} recent={{ title: "Scorecard" }} context={[`${day(card.from)} – ${day(card.to)}`, counted ? `${counted} counted` : "Nothing counted yet"]}
      actions={<Link className={css.headLink} href="/runs/capacity">Capacity</Link>} />
    <p className={css.lead}>From what the steps of live runs did: when each was done against its due date, how many rounds a review took, the verdict on each deliverable. Coaching numbers, not a ranking.</p>
    {procs.map((p) => <section key={p.processId} className={css.block} aria-label={p.process}>
      <h2><Link href={`/processes/${encodeURIComponent(p.processId)}`}>{p.process}</Link></h2>
      <div className={css.metrics}>{p.metrics.map((m) => <article key={m.key} className={css.metric}>
        <header><b>{m.label}</b>{m.note ? <small>{m.note}</small> : null}</header>
        <p className={css.big}>{value(m, m.total.value)}<small>{m.total.n ? `${unit(m)} · ${m.total.n} counted` : "nothing counted yet"}</small></p>
        {m.kind !== "count" && m.kind !== "revisions" && m.total.value !== null ? <span className={css.meter}><i style={{ width: `${Math.max(2, Math.min(100, m.total.value))}%` }} /></span> : null}
        {m.people.length ? <ul className={css.people}>{m.people.map((x) => <li key={x.personId}><Link href={`/people/${x.personId}`}>{x.name}</Link><b>{value(m, x.value)}</b><small>{x.n}</small></li>)}</ul> : null}
      </article>)}</div>
    </section>)}
    {!procs.length ? <p className={css.empty}>No process has a scorecard yet. A process&apos;s scorecard lists the numbers it counts; live runs fill them.</p> : null}
  </Page>;
}

import Link from "next/link";
import { apiV1 } from "../../lib/api";
import { Avatar, Message, Page, PageHeader } from "../../ui";
import css from "../team.module.css";

type Capacity = { weekHours: number; people: { personId: string; name: string; steps: number; hours: number; late: number; byVariant: Record<string, number>; weeks: number }[] };

/** FLOW-C: capacity, for leadership: the focused hours each person's open steps add up to (the hours each step of a
 *  process takes, per variant), against the hours a person has in a week, so a new run goes to whoever has room. */
export default async function CapacityPage() {
  const r = await apiV1<Capacity>("/v1/flow/capacity");
  if (!r.data) return <Message text={r.error ?? "Capacity did not load."} />;
  const { weekHours, people } = r.data;
  const sorted = [...people].sort((a, b) => b.hours - a.hours);
  const max = Math.max(weekHours * 2, ...sorted.map((p) => p.hours));
  return <Page>
    <PageHeader title="Capacity" back={{ href: "/runs", label: "Runs" }} recent={{ title: "Capacity" }} context={[`${weekHours} focused hours a week each`, `${people.length} people with open steps`]}
      actions={<Link className={css.headLink} href="/runs/scorecard">Scorecard</Link>} />
    <p className={css.lead}>The focused hours of everyone&apos;s open steps in live runs. Past the line, the work takes more than a week; give the next run to someone with room.</p>
    {sorted.length ? <ul className={css.load} aria-label="Load per person">{sorted.map((p) => { const over = p.hours > weekHours;
      return <li key={p.personId} data-over={over ? "" : undefined}>
        <span className={css.who}><Avatar name={p.name} id={p.personId} size={28} /><span><Link href={`/people/${p.personId}`}>{p.name}</Link><small>{p.steps} open step{p.steps === 1 ? "" : "s"}{p.late ? ` · ${p.late} late` : ""}</small></span></span>
        <span className={css.bar} role="img" aria-label={`${p.hours.toFixed(1)} of ${weekHours} hours`}><i style={{ width: `${Math.min(100, (p.hours / max) * 100)}%` }} /><em style={{ left: `${(weekHours / max) * 100}%` }} /></span>
        <b>{p.hours.toFixed(1)} h<small>{p.weeks > 1 ? ` · ${p.weeks.toFixed(1)} weeks` : ""}</small></b>
        {Object.keys(p.byVariant).length ? <small className={css.split}>{Object.entries(p.byVariant).map(([k, h]) => `${k}: ${Number(h).toFixed(1)} h`).join(" · ")}</small> : null}
      </li>; })}</ul>
      : <p className={css.empty}>Nobody has open steps in a live run yet. When runs go live, each person&apos;s focused hours show here.</p>}
  </Page>;
}

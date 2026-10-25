import Link from "next/link";
import { plural } from "../lib/format";
import { Avatar } from "../ui";
import css from "./people.module.css";

/** LIFECYCLE part 4: where staffing is thin. Open work nobody holds (with who fits best and why), people carrying too
 *  much, seats nobody holds now, clients whose recent work was done by people who left, and work only one person does. */
export type FitPerson = { id: string; name: string; pod: string | null; role: string | null; photoAt: string | null; score: number; why: string };
export type Gaps = { openWork: { category: string | null; label: string; open: number; pooled: number; urgent: number; best: FitPerson[] }[];
  overloaded: { id: string; name: string; pod: string | null; open: number; overdue: number }[];
  vacantSeats: { id: string; label: string; lastHolder: { id: string; name: string; to: string | null } | null }[];
  clientsAtRisk: { id: string; name: string; units: number; leaving: number; people: string[] }[];
  singlePerson: { category: string; label: string; person: { id: string; name: string }; share: number; units: number }[]; medianOpen: number | null };

export function FitList({ people, empty = "Nobody fits yet: no one has a domain or history in this kind of work." }: { people: FitPerson[]; empty?: string }) {
  return people.length ? <ul className={css.fit}>{people.map((p) => <li key={p.id}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={20} /><span><Link href={`/people/${p.id}`}><b>{p.name}</b></Link><small>{p.why}</small></span></li>)}</ul>
    : <p className={css.note}>{empty}</p>;
}

export function StaffingGaps({ data, seatsHref }: { data: Gaps; seatsHref: string }) {
  const block = (title: string, n: number, sub: string, body: React.ReactNode, empty: string) => <section className={css.gap} aria-label={title}>
    <h3>{title}<small>{n ? sub : "none"}</small></h3>{n ? body : <p className={css.note}>{empty}</p>}</section>;
  return <div className={css.gaps} data-grow="">
    {block("Open work nobody holds", data.openWork.length, plural(data.openWork.reduce((t, x) => t + x.open, 0), "task"), <ul>{data.openWork.slice(0, 8).map((x) => <li key={x.category ?? "none"}>
      <span><b>{x.label}</b> · {x.open} open{x.pooled ? ` (${x.pooled} in the pool)` : ""}{x.urgent ? ` · ${x.urgent} urgent` : ""}</span><FitList people={x.best} /></li>)}</ul>, "Every open task has someone on it.")}
    {block("Carrying too much", data.overloaded.length, plural(data.overloaded.length, "person", "people"), <ul>{data.overloaded.map((p) => <li key={p.id}>
      <span><Link href={`/tasks/people/${p.id}`}><b>{p.name}</b></Link>{p.pod ? ` · ${p.pod}` : ""} · {p.open} open tasks{p.overdue ? `, ${p.overdue} overdue` : ""}</span></li>)}</ul>,
      `Nobody has more than ${Math.max(8, 2 * (data.medianOpen ?? 0))} open tasks.`)}
    {block("Seats nobody holds now", data.vacantSeats.length, plural(data.vacantSeats.length, "seat"), <ul>{data.vacantSeats.map((s) => <li key={s.id}>
      <span><Link href={`${seatsHref}&seat=${s.id}`}><b>{s.label}</b></Link>{s.lastHolder ? ` · last held by ${s.lastHolder.name}` : ""}</span></li>)}</ul>, "Every seat held in the last year has someone in it.")}
    {block("Clients losing their people", data.clientsAtRisk.length, plural(data.clientsAtRisk.length, "client"), <ul>{data.clientsAtRisk.map((c) => <li key={c.id}>
      <span><Link href={`/clients/${c.id}`}><b>{c.name}</b></Link> · {Math.round((c.leaving / Math.max(1, c.units)) * 100)}% of the last 90 days’ work by {c.people.join(", ")}, who left or are leaving</span></li>)}</ul>,
      "No client depends mostly on someone who has left.")}
    {block("Work only one person does", data.singlePerson.length, plural(data.singlePerson.length, "kind"), <ul>{data.singlePerson.map((x) => <li key={x.category}>
      <span><b>{x.label}</b> · {Math.round(x.share * 100)}% by <Link href={`/people/${x.person.id}`}>{x.person.name}</Link> ({x.units} units, 90 days)</span></li>)}</ul>,
      "No kind of work rests on one person.")}
  </div>;
}

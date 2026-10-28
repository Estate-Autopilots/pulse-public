import Link from "next/link";
import type { CSSProperties } from "react";
import { Armchair, ChevronLeft } from "lucide-react";
import { dayYear } from "../lib/format";
import { monthYear } from "../people/shared";
import { Avatar, Badge, Empty } from "../ui";
import { AddHolder } from "./seat-actions";
import { inr } from "./value";
import css from "./people.module.css";

/** LIFECYCLE part 3: role seats (a role in a pod with its main kind of work) and who held each, for leadership. */
export type Seat = { id: string; label: string; role: string; pod: string | null; domain: string | null; past: number; current: number;
  holders: { id: string; name: string; from: string; to: string | null; current: boolean; source: string }[] };
type Month = { k: number; month: string; units: number; normUnits: number; tasks: number; accepted: number; returned: number; deliveries: number; onTime: number; withDue: number;
  assigned: number; present: number; workdays: number; tracked: boolean; season: number; cost: number | null };
export type SeatCompare = { seat: { id: string; label: string }; window: number | null; cost: boolean; method: string; people: { id: string; name: string; role: string; status: string }[];
  holders: { person: { id: string; name: string; photoAt: string | null; current: boolean }; from: string; to: string | null; source: string; note: string | null; tenureDays: number; tooEarly: boolean; months: Month[] }[] };

const months = (days: number) => days < 60 ? `${days} days` : `${Math.round(days / 30.4)} months`;

export function SeatList({ seats, base }: { seats: Seat[]; base: string }) {
  if (!seats.length) return <Empty icon={Armchair} first title="No seats yet" text={`A seat appears for each role in a pod as soon as someone holds it.`} />;
  const changed = seats.filter((s) => s.holders.length > 1), single = seats.filter((s) => s.holders.length <= 1);
  const card = (s: Seat) => <Link key={s.id} href={`${base}&seat=${s.id}`} className={css.seat} data-seat={s.id} data-vacant={s.current ? undefined : ""}>
    <h4>{s.label}</h4>
    <span className={css.holders}>{s.holders.map((h) => <span key={`${h.id}${h.from}`} className={css.holder} data-past={h.current ? undefined : ""}><Avatar name={h.name} id={h.id} size={20} />{h.name.split(" ")[0]}{h.current ? "" : ` · to ${monthYear(h.to ?? h.from)}`}</span>)}</span>
    <small className={css.sub}>{s.current ? `${s.current} holding it now` : "Nobody holds it now"}{s.past ? ` · ${s.past} before` : ""}{s.holders.length > 1 ? " · compare" : ""}</small>
  </Link>;
  return <div className={css.seats}>{[...changed, ...single].map(card)}</div>;
}

export function SeatComparison({ data, back }: { data: SeatCompare; back: string }) {
  const n = data.window ?? 0;
  const sum = (ms: Month[], f: (m: Month) => number) => ms.reduce((t, m) => t + f(m), 0);
  return <div className={css.compare} data-seat-compare={data.seat.id}>
    <div className={css.toolbar}><Link href={back} className={css.who}><ChevronLeft size={14} aria-hidden="true" />All seats</Link>
      <span className={css.note}>{data.seat.label} · compared over {n ? `their first ${n} month${n === 1 ? "" : "s"}` : "the months each has"}, by tenure month</span></div>
    <div className={css.cols} style={{ "--n": Math.max(1, data.holders.length) } as CSSProperties}>{data.holders.map((h) => {
      const w = n ? h.months.slice(0, n) : h.months; const tasks = sum(w, (m) => m.tasks), given = sum(w, (m) => m.assigned), withDue = sum(w, (m) => m.withDue);
      const tracked = w.filter((m) => m.tracked && m.workdays > 0); const present = sum(tracked, (m) => m.present), workdays = sum(tracked, (m) => m.workdays);
      const per = (x: number) => w.length ? (x / w.length).toFixed(1) : "–";
      const costs = w.map((m) => m.cost).filter((c): c is number => c !== null);
      const max = Math.max(1, ...h.months.map((m) => m.normUnits));
      return <section key={`${h.person.id}${h.from}`} className={css.col} data-holder={h.person.id}>
        <span className={css.who}><Avatar name={h.person.name} id={h.person.id} photoAt={h.person.photoAt} size={32} /><span><b>{h.person.name}</b>
          <small>{dayYear(h.from)} – {h.to ? dayYear(h.to) : "now"} · {months(h.tenureDays)}{h.source === "manual" ? " · placed by hand" : ""}</small></span></span>
        <span className={css.state}>{h.tooEarly ? <Badge tone="accent">Too early to judge</Badge> : h.person.current ? <Badge tone="success">Holds it now</Badge> : <Badge>Held it before</Badge>}</span>
        <span className={css.bars} role="img" aria-label={`Work units per tenure month, season-normalised: ${h.months.map((m) => m.normUnits).join(", ")}`}>
          {h.months.map((m) => <i key={m.k} data-early={n && m.k > n ? "" : undefined} style={{ height: `${Math.max(m.normUnits ? 6 : 0, (m.normUnits / max) * 100)}%` }} title={`Month ${m.k}: ${m.normUnits} units (season ×${m.season})`} />)}</span>
        <dl>
          <dt>Work units a month</dt><dd>{per(sum(w, (m) => m.normUnits))}<small>season-normalised · {w.length} months</small></dd>
          <dt>Tasks finished</dt><dd>{tasks}<small>{given ? `of ${given} given (${Math.round((tasks / given) * 100)}%)` : "none given in Pulse"}</small></dd>
          <dt>Accepted</dt><dd>{tasks ? `${Math.round((sum(w, (m) => m.accepted) / tasks) * 100)}%` : "–"}<small>n = {tasks}</small></dd>
          <dt>Sent back</dt><dd>{sum(w, (m) => m.returned)}<small>revisions</small></dd>
          <dt>On time</dt><dd>{withDue ? `${Math.round((sum(w, (m) => m.onTime) / withDue) * 100)}%` : "–"}<small>n = {withDue} with a due date</small></dd>
          <dt>Deliveries</dt><dd>{sum(w, (m) => m.deliveries)}<small>credited</small></dd>
          <dt>Attendance</dt><dd>{workdays ? `${Math.round((present / workdays) * 100)}%` : "–"}<small>{workdays ? `${present} of ${workdays} working days` : "not recorded then"}</small></dd>
          {data.cost ? <><dt>Cost a month</dt><dd>{costs.length ? inr(costs.reduce((a, b) => a + b, 0) / costs.length) : "–"}<small>{costs.length} months on record</small></dd></> : null}
        </dl>
        {h.note ? <small className={css.sub}>“{h.note}”</small> : null}
      </section>; })}</div>
    <p className={css.note}>{data.method}{data.cost ? "" : " Cost shows only with the salary permission."}</p>
    <AddHolder seat={data.seat.id} people={data.people} />
  </div>;
}


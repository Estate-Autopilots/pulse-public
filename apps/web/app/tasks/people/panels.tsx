"use client";
// TASKS-4A: a person's Work page panels drawn as pictures with real numbers: what they finished this week day by day
// (accepted, and finished but waiting for acceptance), and their domains as cards.
import Link from "next/link";
import { Compass, Plus, ShieldCheck } from "lucide-react";
import { Tooltip } from "../../kit";
import type { Domain } from "../types";
import css from "./person.module.css";

export type Shipped = { id: string; title: string; status: string; doneOn: string };
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const add = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Finished this week: one column per day, accepted (solid) on waiting (washed), the count as the headline. Tasks, not
 *  points (INTEGRITY, owner 22 Oct 2026: a task carries no value). */
export function ValueWeek({ week, today, shipped, lastWeek, first }: { week: string; today: string; shipped: Shipped[]; lastWeek: number; first: string }) {
  const days = DAYS.map((label, i) => {
    const day = add(week, i), items = shipped.filter((s) => s.doneOn === day);
    const accepted = items.filter((s) => s.status === "accepted").length, waiting = items.length - accepted;
    return { label, day, items, accepted, waiting, total: items.length, future: day > today };
  });
  const done = shipped.length, waiting = days.reduce((n, d) => n + d.waiting, 0);
  const peak = Math.max(4, ...days.map((d) => d.total));
  const H = 96;
  return <section className={css.card} aria-labelledby="value-week">
    <div className={css.cardHead}><h3 id="value-week">Finished this week</h3><small>{done ? `${done} finished` : "nothing finished yet"}</small></div>
    <div className={css.hero}>
      <span><b>{done - waiting}</b><small>accepted</small></span>
      {waiting ? <span><b className={css.waitNum}>{waiting}</b><small>waiting for acceptance</small></span> : null}
      <span className={css.delta} data-up={done > lastWeek ? "" : undefined}>{lastWeek ? `${done >= lastWeek ? "+" : "−"}${Math.abs(done - lastWeek)} on last week` : "the first finished task starts the chart"}</span>
    </div>
    <div className={css.chart} role="img" aria-label={`Tasks finished per day this week: ${days.map((d) => `${d.label} ${d.total}`).join(", ")}`}>
      {days.map((d) => <Tooltip key={d.day} content={d.total ? `${d.label}: ${d.total} finished${d.waiting ? `, ${d.waiting} waiting` : ""}` : `${d.label}: nothing finished`}>
        <span className={css.col} data-today={d.day === today ? "" : undefined} data-future={d.future ? "" : undefined} tabIndex={0} aria-label={`${d.label}: ${d.total} finished`}>
          <span className={css.stack} style={{ height: H }}>
            {d.total ? <em className={css.label}>{d.total}</em> : null}
            {d.waiting ? <i className={css.waiting} style={{ height: Math.max(3, Math.round(H * d.waiting / peak)) }} /> : null}
            {d.accepted ? <i className={css.credited} style={{ height: Math.max(3, Math.round(H * d.accepted / peak)) }} /> : null}
          </span>
          <span className={css.dayLabel}>{d.label}</span>
        </span>
      </Tooltip>)}
    </div>
    {waiting ? <p className={css.legend} aria-hidden="true"><span><i className={css.credited} />Accepted</span><span><i className={css.waiting} />Finished, waiting for acceptance</span></p> : null}
    {shipped.length ? <ul className={css.shipped}>{shipped.slice(0, 5).map((s) => <li key={s.id}><Link href={`/tasks/${s.id}`} title={s.title}>{s.title}</Link>
      <span className={css.pts} data-waiting={s.status === "accepted" ? undefined : ""}>{s.status === "accepted" ? "accepted" : "waiting"}</span></li>)}</ul>
      : <p className={css.quiet}>When {first} finishes work this week it shows here.</p>}
    <table className={css.srOnly}><caption>Tasks finished per day this week</caption><thead><tr><th>Day</th><th>Accepted</th><th>Waiting</th><th>Finished</th></tr></thead>
      <tbody>{days.map((d) => <tr key={d.day}><td>{d.label}</td><td>{d.accepted}</td><td>{d.waiting}</td><td>{d.items.length}</td></tr>)}</tbody></table>
  </section>;
}

/** Domains as cards: what they are responsible for, agreed or by policy, with what each covers. */
export function DomainCards({ domains, personId, first, self }: { domains: Domain[]; personId: string; first: string; self: boolean }) {
  return <section className={css.card} aria-labelledby="domains-title">
    <div className={css.cardHead}><h3 id="domains-title">Domains</h3><Link href={`/people/${personId}?tab=domains`}>{domains.length ? "Manage" : "Set up"}</Link></div>
    {domains.length ? <ul className={css.domains}>{domains.map((d) => <li key={d.id} className={css.domain} data-status={d.status} data-basis={d.basis}>
      <span className={css.domainIcon} aria-hidden="true">{d.basis === "policy" ? <ShieldCheck size={16} /> : <Compass size={16} />}</span>
      <span className={css.domainMain}><b>{d.title}</b>
        <span className={css.domainTags}>{(d.categoryLabels ?? []).slice(0, 3).map((c) => <span key={c}>{c}</span>)}{d.pod ? <span>{d.pod}</span> : null}{d.projectName ? <span>{d.projectName}</span> : null}{d.clientName ? <span>{d.clientName}</span> : null}</span></span>
      <span className={css.basis}>{d.status === "proposed" ? "Waiting" : d.basis === "policy" ? "Policy" : "Agreed"}</span>
    </li>)}</ul>
      : <Link href={`/people/${personId}?tab=domains`} className={css.domainEmpty}><Plus size={16} aria-hidden="true" /><span><b>{self ? "Agree your domains" : `Agree ${first}’s domains`}</b><small>Work inside a domain is assigned at once; anything else arrives as a request.</small></span></Link>}
  </section>;
}

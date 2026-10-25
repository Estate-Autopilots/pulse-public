// TASKS-4B (owner's point 13): the My tasks rail made visual and actionable. "Your domains" as chips, with Pulse's
// suggestions from the work already done and "Propose a domain" right there; "Value this week" as a chart of each day's
// value (credited, and waiting for acceptance) with what shipped beneath it.
import Link from "next/link";
import { Compass, Inbox, ShieldCheck, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { plural } from "../lib/format";
import { WeekColumns } from "./outcome-charts";
import type { DomainsView } from "./domains-panel";
import type { Home, Task } from "./types";
import { ProposeDomain } from "./work-two";
import css from "./work3.module.css";
import life from "./life.module.css";
import oc from "./outcomes.module.css";

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Your domains: active ones as chips (company policy shielded), proposals waiting dashed, suggestions to propose. */
export async function DomainsCard({ home }: { home: Home }) {
  if (!home.me) return null;
  const r = await api<DomainsView>(`work/domains?person=${home.me}`);
  const d = r.data;
  const live = (d?.domains ?? []).filter((x) => x.status === "active" || x.status === "proposed");
  return <section className={css.card} aria-label="Your domains">
    <div className={css.cardHead}><h3>Your domains</h3>{live.length ? <Link href={`/people/${home.me}?tab=domains`}>All</Link> : null}</div>
    <div className={css.cardBody}>
      {live.length ? <ul className={life.domainChips} aria-label="What you are responsible for">{live.slice(0, 8).map((x) => <li key={x.id} data-status={x.status} data-basis={x.basis}>
        {x.basis === "policy" ? <ShieldCheck size={13} aria-hidden="true" /> : <Compass size={13} aria-hidden="true" />}<span>{x.title}</span>
        <small>{x.status === "proposed" ? "waiting for an answer" : x.basis === "policy" ? "company policy" : "agreed"}</small></li>)}</ul>
        : <p className={css.line}>Work inside your domains comes to you directly; anything else arrives as a request.</p>}
      {!live.length && d?.suggestions?.length && d.options ? <div className={life.suggest}>
        <p><Sparkles size={13} aria-hidden="true" />From the work you already do:</p>
        <ul>{d.suggestions.slice(0, 2).map((s) => <li key={s.title}><span><b>{s.title}</b><small>{s.evidence[0]}</small></span>
          <ProposeDomain personId={home.me!} personName={d.person.name} self canPolicy={false} options={d.options!} prefill={s} label="Propose" /></li>)}</ul>
      </div> : null}
      {d?.options && d.can.propose ? <div className={life.domainSetUp}><ProposeDomain personId={home.me} personName={d.person.name} self canPolicy={false} options={d.options} label={live.length ? "Propose another" : "Set one up"} /></div> : null}
      {home.pool?.fits ? <p className={css.line}><Inbox size={13} aria-hidden="true" /><Link href="/tasks?scope=pool&fits=1">{plural(home.pool.fits, "pool task")} fit{home.pool.fits === 1 ? "s" : ""} your domains</Link></p>
        : home.pool?.open ? <p className={css.line}><Inbox size={13} aria-hidden="true" /><Link href="/tasks?scope=pool">{plural(home.pool.open, "task")} in the pool</Link></p> : null}
    </div>
  </section>;
}

/** Finished this week: a column per day, then what shipped and whether it was accepted (INTEGRITY: no points). */
export function ValueWeekCard({ home }: { home: Home }) {
  const s = home.summary; if (!s) return null;
  const days = s.days ?? [];
  const today = days.findIndex((d) => d.day === home.today);
  const done = days.reduce((n, d) => n + d.done, 0);
  return <section className={css.card} aria-label="Finished this week">
    <div className={css.cardHead}><h3>Finished this week</h3><Link href="/tasks/outcomes">My outcomes</Link></div>
    <div className={css.cardBody}>
      <p className={life.valueTotals}><span><b>{done}</b> {done === 1 ? "task" : "tasks"} finished</span>{s.pendingTasks ? <span><b>{s.pendingTasks}</b> waiting for acceptance</span> : null}</p>
      {days.length ? <div className={oc.viz}><WeekColumns title="Tasks finished each day this week" weeks={days.map((d) => d.day)} labels={days.map((d) => `${DAY[new Date(`${d.day}T00:00:00Z`).getUTCDay()]}${d.done ? ` · ${plural(d.done, "task")} finished` : ""}`)}
        now={today >= 0 ? today : undefined} unit="tasks" height={110}
        series={[{ key: "done", label: "Finished", slot: 1, values: days.map((d) => d.done) }]} /></div> : null}
      {s.shipped.length ? <ul className={life.shipped} aria-label="What shipped this week">{s.shipped.slice(0, 5).map((t) =>
        <li key={t.id}><Link href={`/tasks/${t.id}`} title={t.title}>{t.title}</Link>
          <span data-tone={t.status === "accepted" ? "success" : undefined}>{t.status === "accepted" ? "accepted" : "waiting"}</span></li>)}</ul>
        : <p className={css.line}>What you finish this week shows here.</p>}
    </div>
  </section>;
}

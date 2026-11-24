"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Clock, Folder, Search } from "lucide-react";
import { ICONS, day } from "./pm-shared";
import { Avatar } from "../avatar";
import css from "./pm-home.module.css";

/** PM-BUILD-3: the cards of Work → Projects (screen 01), filtered and searched in the page (no round trip, so a search
 *  answers at once). The words come from the API's card (SPEC v1.1 health with its reason). */
export type PmHealth = "paused" | "done" | "needs_setup" | "not_started" | "waiting_client" | "late" | "at_risk" | "on_track";
export type PmPhase = { n: number; label: string; state: "none" | "todo" | "active" | "waiting" | "late" | "done"; total: number; done: number };
export type PmNext = { id: string; code: string | null; title: string; who: string | null; whoId: string | null; due: string | null; planned: boolean; late: number; client: boolean; status: string };
export type PmCard = { health: PmHealth; word: string; reason: string | null; color: string; icon: string; quiet: boolean; updated?: string | null; updateMissing?: boolean; phases: PmPhase[]; current: number | null;
  next: PmNext | null; line: string | null; progress: { done: number; total: number; pct: number }; clocks: { key: string; label: string; on: string | null; happened: boolean }[] };
export type PmRow = { id: string; title: string; client: string | null; lead: string | null; mine: boolean; pm: PmCard };

const RANK: Record<PmHealth, number> = { late: 0, at_risk: 1, waiting_client: 2, on_track: 3, needs_setup: 4, not_started: 5, paused: 6, done: 7 };
type Chip = "mine" | "risk" | "client" | "quiet" | "all";
const CHIPS: { key: Chip; label: string; test: (r: PmRow) => boolean }[] = [
  { key: "mine", label: "Mine", test: (r) => r.mine },
  { key: "risk", label: "At risk", test: (r) => r.pm.health === "late" || r.pm.health === "at_risk" },
  { key: "client", label: "Waiting on client", test: (r) => r.pm.health === "waiting_client" },
  { key: "quiet", label: "Quiet (14 days)", test: (r) => r.pm.quiet },
  { key: "all", label: "All", test: () => true },
];
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** The health chip: the word, and the reason after a dot (On track alone needs none). */
export function HealthChip({ pm, short }: { pm: Pick<PmCard, "health" | "word" | "reason">; short?: boolean }) {
  return <span className={css.health} data-health={pm.health} title={pm.reason ? `${pm.word}: ${pm.reason}` : pm.word}>
    <b>{pm.word}</b>{pm.reason && !short ? <span><span aria-hidden="true">{"\u00a0·\u00a0"}</span>{pm.reason}</span> : null}</span>;
}

/** When the next step is due, in words: late is red, a client's lateness amber, a planned day says so. */
export function DueWords({ next, today }: { next: PmNext; today: string }) {
  if (!next.due) return null;
  if (next.late > 0) return <span className={css.due} data-tone="late">Late · {next.late} {next.late === 1 ? "day" : "days"}</span>;
  if (next.client && next.due < today) { const n = daysBetween(next.due, today); return <span className={css.due} data-tone="client">Client late · {n} {n === 1 ? "day" : "days"}</span>; }
  if (next.due === today) return <span className={css.due} data-tone="today">Due today</span>;
  return <span className={css.due}>{next.planned ? "Planned" : "Due"} {day(next.due)}</span>;
}

/** The phase strip: one segment per phase in its state; the current phase named with its place ("Shoot · 3 of 9"). */
export function PhaseStrip({ pm, tap }: { pm: PmCard; tap?: (n: number) => string }) {
  const shown = pm.phases.filter((p) => p.state !== "none");
  if (!shown.length) return null;
  const at = shown.findIndex((p) => p.n === pm.current);
  const cur = at >= 0 ? shown[at] : null;
  return <div className={css.phases}>
    <span className={css.strip} role="img" aria-label={`${cur ? `${cur.label}, phase ${at + 1} of ${shown.length}` : `${shown.length} phases`}. ${shown.filter((p) => p.state === "done").length} done.`}>
      {shown.map((p) => tap ? <Link key={p.n} href={tap(p.n)} className={css.seg} data-state={p.state} data-current={p.n === pm.current ? "" : undefined} title={`${p.label}: ${p.done} of ${p.total} steps done`} />
        : <i key={p.n} className={css.seg} data-state={p.state} data-current={p.n === pm.current ? "" : undefined} />)}
    </span>
    {cur ? <small className={css.phaseName}>{cur.label} · {at + 1} of {shown.length}</small> : null}
  </div>;
}

function Card({ r, today }: { r: PmRow; today: string }) {
  const Icon = ICONS[r.pm.icon] ?? Folder; const n = r.pm.next;
  return <article className={`${css.card} ${css.pc}`} data-color={r.pm.color} data-health={r.pm.health}>
    <header className={css.cardHead}>
      <span className={css.tile} aria-hidden="true"><Icon size={22} /></span>
      <div className={css.names}>
        <h3><Link href={`/tasks/projects/${r.id}`} className={css.cardLink}>{r.title}</Link></h3>
        {r.client ? <p className={css.client}>{r.client}</p> : null}
      </div>
      <HealthChip pm={r.pm} />
    </header>
    <PhaseStrip pm={r.pm} />
    {n ? <p className={css.next}><span className={css.nextWhat}><b>Next:</b> {n.title}</span>
      <span className={css.nextWho}>{n.who ? <><Avatar name={n.who} id={n.whoId} size={22} /><span>{n.who}</span></> : <span className={css.nobody}>Nobody yet</span>}<DueWords next={n} today={today} /></span></p>
      : r.pm.health === "needs_setup" ? <p className={css.next}><span className={css.nextWhat}>{r.pm.reason === "no plan yet" ? "Pick a template to lay out its steps and dates." : "Give it a lead to start the plan."}</span>
        <Link href={r.pm.reason === "no plan yet" ? `/tasks/projects/${r.id}/setup` : `/tasks/projects/${r.id}`} className={css.setup}>Set up this project</Link></p> : null}
    {r.pm.line ? <p className={css.line}><Clock size={14} aria-hidden="true" /><span>{r.pm.line}</span>
      {r.pm.updated === today ? <span className={css.upd}>Updated today</span> : r.pm.updateMissing ? <span className={css.upd} data-missing="">No update this week</span> : null}</p> : null}
  </article>;
}

export function PmCards({ rows, today, initial, q: q0 }: { rows: PmRow[]; today: string; initial?: string; q: string }) {
  const first: Chip = CHIPS.some((c) => c.key === initial) ? initial as Chip : rows.some((r) => r.mine) ? "mine" : "all";
  const [chip, setChip] = useState<Chip>(first);
  const [q, setQ] = useState(q0);
  // The chosen chip and search stay in the address, so a link or a reload opens the same list.
  useEffect(() => {
    const u = new URL(window.location.href); u.searchParams.set("f", chip); if (q.trim()) u.searchParams.set("q", q.trim()); else u.searchParams.delete("q");
    window.history.replaceState(window.history.state, "", u.toString());
  }, [chip, q]);
  const sorted = useMemo(() => [...rows].sort((a, b) => RANK[a.pm.health] - RANK[b.pm.health] || (a.pm.next?.due ?? "9999").localeCompare(b.pm.next?.due ?? "9999") || a.title.localeCompare(b.title)), [rows]);
  const needle = q.trim().toLowerCase();
  const found = needle ? sorted.filter((r) => `${r.title} ${r.client ?? ""} ${r.lead ?? ""}`.toLowerCase().includes(needle)) : sorted;
  const test = CHIPS.find((c) => c.key === chip)!.test;
  const list = found.filter(test);
  return <section className={css.home} aria-label="Projects">
    <div className={css.tools}>
      <label className={css.search}><Search size={16} aria-hidden="true" /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects" aria-label="Search projects by name, client or lead" /></label>
      <div className={css.chips} role="group" aria-label="Show">
        {CHIPS.map((c) => { const n = found.filter(c.test).length;
          return <button key={c.key} type="button" className={css.chip} aria-pressed={chip === c.key} onClick={() => setChip(c.key)}>
            {c.label}{c.key === "mine" ? null : <span className={css.count}>{n}</span>}</button>; })}
      </div>
    </div>
    {list.length ? <div className={css.grid} data-items="">{list.map((r) => <Card key={r.id} r={r} today={today} />)}</div>
      : <div className={css.empty}><b>{needle ? `Nothing matches “${q.trim()}”` : chip === "mine" ? "No projects of yours yet" : `No projects ${CHIPS.find((c) => c.key === chip)!.label.toLowerCase()} right now`}</b>
        <span>{needle ? "Search looks at the project, its client and its lead." : "Every project is one tap away under All."}</span>
        <button type="button" className={css.emptyBtn} onClick={() => { setQ(""); setChip("all"); }}>Show all projects</button></div>}
  </section>;
}

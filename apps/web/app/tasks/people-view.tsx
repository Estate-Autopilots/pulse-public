import Link from "next/link";
import { GraduationCap } from "lucide-react";
import { api } from "../lib/api";
import { plural } from "../lib/format";
import { Avatar, PartFailed, styles } from "../ui";
import { RoleTargets, type RoleTarget } from "./role-targets";
import css from "./people-view.module.css";

/** WORK-TAB (27 Oct 2026): performance and quality per person, Kazuk's number 1. */
export type Ratio = { n: number; of: number };
export type Score = { id: string; name: string; pod: string | null; role: string | null; photoAt: string | null; joinedOn: string | null; newcomer: boolean;
  open: number; late: number; blocked: number; doneWeek: number; doneLastWeek: number; usual: number | null;
  onTime: Ratio; firstTime: Ratio; returned: number; quality: number | null; now: { id: string; title: string } | null; target?: RoleTarget | null };
type Board = { today: string; week: string; role: string; everyone: boolean; pods: string[]; pod: string | null;
  totals: { open: number; late: number; blocked: number; doneWeek: number; doneLastWeek: number; onTime: number; withDue: number; first: number; reviewed: number };
  fix?: { noOwner: number; noDue: number; late: number }; targets?: RoleTarget[]; rows: Score[] };

/** A share worth reading only with enough behind it: three or more. */
export const pct = (r: Ratio) => r.of ? Math.round(100 * r.n / r.of) : null;
export const tone = (r: Ratio) => { const p = pct(r); return p === null || r.of < 3 ? undefined : p >= 85 ? "good" : p >= 60 ? "watch" : "low"; };
/** What needs a lead's eye first: late work, then blocked, then low quality, then low output against their usual. */
const attention = (s: Score) => s.late * 3 + s.blocked * 2 + (tone(s.onTime) === "low" ? 2 : 0) + (tone(s.firstTime) === "low" ? 2 : 0)
  + (s.usual && s.doneWeek < s.usual / 2 ? 1 : 0);
export function needs(s: Score): string[] {
  const out: string[] = [];
  if (s.late) out.push(`${s.late} late`);
  if (s.blocked) out.push(`${s.blocked} blocked`);
  if (tone(s.onTime) === "low") out.push(`${pct(s.onTime)}% on time`);
  if (tone(s.firstTime) === "low") out.push(`${s.returned} sent back`);
  return out;
}

export function Share({ r, label }: { r: Ratio; label: string }) {
  const p = pct(r);
  if (p === null) return <span className={css.none} title={`No ${label} in the last four weeks`}>–</span>;
  return <span className={css.share} data-tone={tone(r)} title={`${r.n} of ${r.of} ${label}`}><b>{p}%</b><small>{r.n} of {r.of}</small></span>;
}

function Output({ s }: { s: Score }) {
  // Against the role's weekly target when leadership set one, else against the person's own usual week.
  if (s.target) {
    const t = s.target, part = Math.min(100, Math.round(100 * s.doneWeek / t.perWeek));
    return <span className={css.output} title={`${s.doneWeek} of ${t.perWeek} ${t.unit ?? "tasks"} this week (the ${s.role} target)`}>
      <span className={css.outputLine}><b>{s.doneWeek} of {t.perWeek}</b><small>{t.unit ?? "tasks"}</small></span>
      <span className={css.bar} aria-hidden="true"><i style={{ width: `${part}%` }} /></span>
    </span>;
  }
  const goal = Math.max(1, s.usual ?? 0, s.doneWeek);
  return <span className={css.output}>
    <span className={css.outputLine}><b>{s.doneWeek}</b><small>{s.usual !== null ? `usual ${s.usual}` : "this week"}</small></span>
    <span className={css.bar} aria-hidden="true"><i style={{ width: `${Math.round(100 * s.doneWeek / goal)}%` }} />{s.usual ? <em style={{ left: `${Math.min(100, Math.round(100 * s.usual / goal))}%` }} /> : null}</span>
  </span>;
}

/** Work → People: the CEO's, HR's and a pod head's "People this week". */
export async function PeopleView({ q }: { q: Record<string, string> }) {
  const r = await api<Board>(`work/scorecard${q.pod ? `?pod=${encodeURIComponent(q.pod)}` : ""}`);
  if (r.error || !r.data) return <PartFailed error={r.error ?? "The people view did not load."} />;
  const d = r.data, t = d.totals;
  const rows = [...d.rows].sort((a, b) => attention(b) - attention(a) || b.open - a.open || a.name.localeCompare(b.name));
  const onTime = { n: t.onTime, of: t.withDue }, first = { n: t.first, of: t.reviewed };
  const delta = t.doneWeek - t.doneLastWeek;
  return <div className={css.view} data-grow="">
    {d.pods.length > 1 ? <nav className={css.scope} aria-label="Whose people">
      <div className={styles.segmented}>
        <Link className={styles.segment} href="/tasks?view=people" aria-current={!d.pod ? "true" : undefined}>{d.everyone ? "Everyone" : "All my pods"}</Link>
        {d.pods.map((p) => <Link key={p} className={styles.segment} href={`/tasks?view=people&pod=${encodeURIComponent(p)}`} aria-current={d.pod === p ? "true" : undefined}>{p}</Link>)}
      </div>
    </nav> : null}
    <section className={css.tiles} aria-label="At a glance">
      <Tile label="Open" value={t.open} note={plural(d.rows.length, "person", "people")} />
      <Tile label="Late" value={t.late} tone={t.late ? "low" : undefined} note={t.late ? "past their due day" : "nothing late"} />
      <Tile label="Blocked" value={t.blocked} tone={t.blocked ? "watch" : undefined} note={t.blocked ? "waiting on something" : "nothing stuck"} />
      <Tile label="Finished this week" value={t.doneWeek} note={delta === 0 ? "same as last week" : `${delta > 0 ? "+" : ""}${delta} on last week`} />
      <Tile label="On time" value={pct(onTime) === null ? "–" : `${pct(onTime)}%`} tone={tone(onTime)} note={onTime.of ? `${onTime.n} of ${onTime.of} with a due day · 4 weeks` : "no due days yet"} />
      <Tile label="Right first time" value={pct(first) === null ? "–" : `${pct(first)}%`} tone={tone(first)} note={first.of ? `${first.n} of ${first.of} reviewed · 4 weeks` : "nothing reviewed yet"} />
    </section>
    {d.fix && (d.fix.noOwner || d.fix.noDue || d.fix.late) ? <nav className={css.fix} aria-label="Fix first">
      <span className={css.fixLabel}>Fix first</span>
      {d.fix.late ? <Link href="/tasks?scope=company&due=overdue&layout=table" data-tone="low"><b>{d.fix.late}</b> late</Link> : null}
      {d.fix.noOwner ? <Link href="/tasks?scope=company&people=none&layout=table"><b>{d.fix.noOwner}</b> with nobody on them</Link> : null}
      {d.fix.noDue ? <Link href="/tasks?scope=company&due=none&layout=table"><b>{d.fix.noDue}</b> with no due day</Link> : null}
      <small>Work with no owner or due day cannot be tracked or credited to anyone.</small>
    </nav> : null}
    <section className={css.panel} aria-label="People">
      <header className={css.head}><h3>People</h3><small>Output and quality over the last four weeks · needs you first · coaching only in someone’s first 30 days</small></header>
      {rows.length ? <div className={css.scroll}><table className={css.table}>
        <thead><tr><th>Person</th><th>On now</th><th className={css.num}>Open</th><th className={css.num}>Late</th><th>Finished this week</th><th>On time</th><th>Right first time</th><th className={css.num}>Sent back</th></tr></thead>
        <tbody>{rows.map((s) => <tr key={s.id} data-attention={attention(s) ? "" : undefined}>
          <td data-label="Person"><Link href={`/tasks/people/${s.id}`} className={css.who}><Avatar name={s.name} id={s.id} photoAt={s.photoAt} size={30} status />
            <span><b>{s.name}</b><small>{[s.role, s.pod].filter(Boolean).join(" · ") || "No role recorded"}{s.newcomer ? <span className={css.coach}><GraduationCap size={11} aria-hidden="true" />First 30 days</span> : null}</small></span></Link></td>
          <td data-label="On now" className={css.now}>{s.now ? <Link href={`/tasks/${s.now.id}`} title={s.now.title}>{s.now.title}</Link> : <span className={css.none}>Nothing started</span>}</td>
          <td data-label="Open" className={css.num}>{s.open}</td>
          <td data-label="Late" className={css.num} data-tone={s.late ? "low" : undefined}>{s.late}</td>
          <td data-label="Finished this week"><Output s={s} /></td>
          <td data-label="On time"><Share r={s.onTime} label="tasks with a due day finished by it" /></td>
          <td data-label="Right first time"><Share r={s.firstTime} label="reviewed tasks accepted without being sent back" /></td>
          <td data-label="Sent back" className={css.num}>{s.returned || <span className={css.none}>0</span>}</td>
        </tr>)}</tbody></table></div>
        : <p className={css.empty}><b>Nobody in view yet</b>People you lead show here with their output and quality.</p>}
      {d.role === "leadership" ? <RoleTargets roles={[...new Set(d.rows.map((s) => s.role).filter((r): r is string => !!r))].sort()} targets={d.targets ?? []} /> : null}
      <p className={css.foot}>On time: finished by the due day. Right first time: accepted by someone else without being sent back. Sent back: returned for changes. Numbers come from the work itself; there are no points.</p>
    </section>
  </div>;
}

function Tile({ label, value, note, tone: t }: { label: string; value: number | string; note: string; tone?: string }) {
  return <div className={css.tile} data-tone={t}><span>{label}</span><b>{value}</b><small>{note}</small></div>;
}

/** The lead's card beside their own tasks: who needs them today (three at most) and the way to everyone. */
export async function TeamTodayCard() {
  const r = await api<Board>("work/scorecard");
  if (r.error || !r.data || !r.data.rows.length) return null;
  const d = r.data;
  const top = [...d.rows].filter((s) => attention(s) > 0).sort((a, b) => attention(b) - attention(a)).slice(0, 3);
  return <section className={css.card} aria-label="Your people today">
    <div className={css.cardHead}><h3>Your people</h3><Link href="/tasks?view=people">Everyone</Link></div>
    <p className={css.cardLine}>{[plural(d.rows.length, "person", "people"), d.totals.late ? `${d.totals.late} late` : "nothing late", d.totals.blocked ? `${d.totals.blocked} blocked` : null].filter(Boolean).join(" · ")}</p>
    {top.length ? <ul className={css.cardList}>{top.map((s) => <li key={s.id}><Link href={`/tasks/people/${s.id}`}><Avatar name={s.name} id={s.id} photoAt={s.photoAt} size={24} />
      <span><b>{s.name}</b><small>{needs(s).join(" · ") || "below their usual week"}</small></span></Link></li>)}</ul>
      : <p className={css.cardLine}>Nobody is late, blocked or slipping on quality.</p>}
  </section>;
}

/** A person's own card beside their tasks: how they are doing, from their work. */
export async function MyScoreCard({ me }: { me: string }) {
  const r = await api<{ score: Score }>(`work/scorecard/${me}`);
  if (r.error || !r.data) return null;
  const s = r.data.score;
  // Nothing finished, due or reviewed yet: no card of dashes.
  if (!s.doneWeek && !s.doneLastWeek && !s.onTime.of && !s.firstTime.of && s.usual === null) return null;
  return <section className={css.card} aria-label="How you are doing">
    <div className={css.cardHead}><h3>How you are doing</h3><Link href={`/tasks/people/${me}`}>Your page</Link></div>
    <dl className={css.mini}>
      <div><dt>Finished this week</dt><dd>{s.doneWeek}</dd><small>{s.usual !== null ? `usual ${s.usual}` : `${s.doneLastWeek} last week`}</small></div>
      <div><dt>On time</dt><dd data-tone={tone(s.onTime)}>{pct(s.onTime) === null ? "–" : `${pct(s.onTime)}%`}</dd><small>{s.onTime.of ? `${s.onTime.n} of ${s.onTime.of}` : "no due days"}</small></div>
      <div><dt>Right first time</dt><dd data-tone={tone(s.firstTime)}>{pct(s.firstTime) === null ? "–" : `${pct(s.firstTime)}%`}</dd><small>{s.firstTime.of ? `${s.firstTime.n} of ${s.firstTime.of}` : "none reviewed"}</small></div>
    </dl>
    {s.newcomer ? <p className={css.cardLine}><GraduationCap size={13} aria-hidden="true" /> Your first 30 days: these numbers are for coaching only.</p> : null}
  </section>;
}

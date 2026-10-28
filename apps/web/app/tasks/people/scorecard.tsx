import { GraduationCap } from "lucide-react";
import { api } from "../../lib/api";
import { shortDay } from "../parts";
import { pct, tone, type Score } from "../people-view";
import dash from "../dashboard.module.css";
import pv from "../people-view.module.css";
import css from "./person.module.css";

type Week = { week: string; done: number; withDue: number; onTime: number; accepted: number; returned: number };

/** WORK-TAB (27 Oct 2026): one person's performance and quality, for them, their head, HR and leadership. Four weeks of
 *  numbers from the work itself and eight weeks of on-time and right-first-time, each week on its own bar. */
export async function ScoreCard({ personId, first, self }: { personId: string; first: string; self: boolean }) {
  const r = await api<{ score: Score; weeks: Week[] }>(`work/scorecard/${encodeURIComponent(personId)}`);
  if (r.error || !r.data) return null;
  const s = r.data.score, weeks = r.data.weeks;
  const share = (n: number, of: number) => of ? Math.round(100 * n / of) : null;
  const series: [string, (w: Week) => number | null, (w: Week) => string][] = [
    ["On time", (w) => share(w.onTime, w.withDue), (w) => w.withDue ? `${w.onTime} of ${w.withDue} on time` : "no due days"],
    ["Right first time", (w) => share(w.accepted, w.accepted + w.returned), (w) => w.accepted + w.returned ? `${w.accepted} accepted, ${w.returned} sent back` : "nothing reviewed"],
  ];
  return <section className={`${css.card} ${pv.card}`} aria-label={self ? "Your performance and quality" : `${first}’s performance and quality`}>
    <div className={css.cardHead}><h3>Performance and quality</h3><small>last 4 weeks</small></div>
    <dl className={pv.mini}>
      <div><dt>On time</dt><dd data-tone={tone(s.onTime)}>{pct(s.onTime) === null ? "–" : `${pct(s.onTime)}%`}</dd><small>{s.onTime.of ? `${s.onTime.n} of ${s.onTime.of}` : "no due days"}</small></div>
      <div><dt>Right first time</dt><dd data-tone={tone(s.firstTime)}>{pct(s.firstTime) === null ? "–" : `${pct(s.firstTime)}%`}</dd><small>{s.firstTime.of ? `${s.firstTime.n} of ${s.firstTime.of}` : "none reviewed"}</small></div>
      <div><dt>Sent back</dt><dd data-tone={s.returned >= 3 ? "low" : undefined}>{s.returned}</dd><small>{s.quality !== null ? `rated ${s.quality} of 5` : "for changes"}</small></div>
    </dl>
    <p className={pv.cardLine}>Finished {s.doneWeek} this week{s.usual !== null ? `, usually ${s.usual}` : ""}{s.late ? ` · ${s.late} late` : ""}{s.blocked ? ` · ${s.blocked} blocked` : ""}</p>
    {series.map(([label, val, text]) => <div key={label} className={css.trend}><span className={css.trendLabel}>{label}<b>{((x) => x === null ? "–" : `${x}%`)(pct(label === "On time" ? s.onTime : s.firstTime))}</b></span>
      <span className={dash.minis} role="img" aria-label={`${label} per week: ${weeks.map(text).join(", ")}`}>{weeks.map((w, i) => { const v = val(w); return <span key={w.week} className={dash.mini} data-now={i === weeks.length - 1 ? "" : undefined}>
        <i style={{ height: `${v === null ? 0 : Math.max(8, v)}%` }} data-zero={v ? undefined : ""} /><span className={dash.tip} role="tooltip"><b>{v === null ? "–" : `${v}%`}</b><span>{text(w)} · week of {shortDay(w.week)}</span></span></span>; })}</span></div>)}
    {s.newcomer ? <p className={pv.cardLine}><GraduationCap size={13} aria-hidden="true" />{self ? "Your" : `${first}’s`} first 30 days: coaching only, not a rating.</p> : null}
  </section>;
}

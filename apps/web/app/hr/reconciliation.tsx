import { styles } from '../ui';
import { Regularise } from './actions';
import { duration } from './types';
import { longDay, time } from '../lib/format';
import css from './reconciliation.module.css';
import { AttendanceOff } from './attendance-off';
export type Reconciliation = {
 automaticClosureEnabled:false;dryRun:true;policy:{version:number;approved:boolean;capMinutes:number;promptMinutes:number;timezone:string};
 queue:{id:string;date:string;in:string;originalOut:string|null;reasons?:string[];proposedEnd:string|null;suggestion:{state:string;proposedEnd:string|null}}[];
 baseline:{from:string;to:string;sampleDays:number;expectedDays:number;coverage:number|null;minimumDays:number;minutes:number|null;source:string;label:string;provisional:boolean;comparable:string};
 historicalMonthly:{label:string;dailyPunchesDerived:false;summary:{counts:Record<string,{median:number|null;sampleMonths:number}>};rows:{sourceKey:string;month:string;monthLabel:string;leaveDays:string|null;wfhDays:string|null;halfDays:string|null}[]};
};
export function AttendanceReconciliation({data,today,canAct,attendanceEnabled}:{data:Reconciliation;today:string;canAct:boolean;attendanceEnabled?:boolean}) {
 if (attendanceEnabled !== true) return <AttendanceOff />;
 const b=data.baseline;
 return <div aria-label="Attendance reconciliation" data-attendance-reconciliation className={css.panel}>
  <p>Automatic closure is off. Policy v{data.policy.version} is suggestion-only{data.policy.approved?'':' and awaiting HR validation'}: prompt {data.policy.promptMinutes/60} hours after shift end; proposed cap {data.policy.capMinutes/60} hours. Long shifts need HR review.</p>
  <p><strong>Current 28-day baseline</strong> · {b.from} to {b.to}<br/>Comparable {b.comparable.split(':').at(-1)} shifts · {b.minutes===null?'Unknown':duration(b.minutes)} · {b.sampleDays} accepted comparable days / {b.expectedDays} scheduled comparable days · {b.coverage===null?'coverage unknown':`${Math.round(b.coverage*100)}% coverage`}. {b.source==='accepted_comparable_shifts'?'Median of accepted shifts.':b.source==='confirmed_shift_policy'?'Low sample: confirmed shift-policy fallback.':'Low sample: no confirmed shift-policy fallback.'} Minimum {b.minimumDays} days; provisional eligibility.</p>
  <ul className={styles.list}>{data.queue.map(q=><li key={q.id} className={styles.row}><span className={styles.rowMain}><strong>{longDay(q.date)}</strong><span className={styles.cellSub}>{q.proposedEnd?'Provisionally closed — needs review':q.suggestion.state==='waiting'?'Open receipt':q.suggestion.state.replaceAll('_',' ')}. Original check-in {time(q.in)}{q.originalOut?`; recorded end ${time(q.originalOut)}`:""}; proposed end {q.proposedEnd||q.suggestion.proposedEnd ? new Intl.DateTimeFormat("en-GB",{dateStyle:"medium",timeStyle:"short",timeZone:data.policy.timezone}).format(new Date((q.proposedEnd||q.suggestion.proposedEnd)!)) : "unknown"}. Unresolved hours are excluded from averages. {q.reasons?.join("; ")}</span></span>{canAct?<Regularise today={today} entryId={q.id} date={q.date} label="Request correction" small/>:null}</li>)}</ul>
  <details><summary>Historical monthly reports — separate from daily baseline ({data.historicalMonthly.rows.length})</summary><p>Monthly totals have their own source provenance. They do not create daily punches or personal shift samples. Blank counts stay unknown.</p><p>Reported monthly baseline (HR identity/eligibility validation pending): leave median {data.historicalMonthly.summary.counts.leaveDays.median??'unknown'} days ({data.historicalMonthly.summary.counts.leaveDays.sampleMonths} known months); work from home median {data.historicalMonthly.summary.counts.wfhDays.median??'unknown'} days ({data.historicalMonthly.summary.counts.wfhDays.sampleMonths} known months).</p><p data-monthly-hours>Historical hours baseline is unknown.</p><ul>{data.historicalMonthly.rows.map(r=><li key={r.sourceKey}>{r.monthLabel}: leave {r.leaveDays??'unknown'}; work from home {r.wfhDays??'unknown'}; half days {r.halfDays??'unknown'}.</li>)}</ul></details>
 </div>;
}

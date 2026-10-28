import Link from 'next/link';
import { CheckCheck, Gauge, Target, Users } from 'lucide-react';
import { api } from '../lib/api';
import { count } from '../lib/format';
import { Badge, Kpi, Pager, Panel, Spark, Tiles, Workspace, styles } from '../ui';
import css from './performance.module.css';
import { W } from "../kit/word";
import { lower } from "../lib/words.mjs";
import { vocabulary } from "../lib/api";
type Person={id:string;name:string;pod:string|null;role:string|null;taskCount:number;doneTasks:number;blockedTasks:number;unknownTasks:number;observedActions:number;deliveries:number;allTimeDeliveries:number;attendanceDays:number;workEvents:number;workUnits:number;qualitySignals:number;outcomeSignals:number};
type Data={attendanceEnabled?:boolean;people:Person[];pods:{name:string;people:number;deliveries:number;taskCount:number;doneTasks:number;observedActions:number;qualitySignals:number;outcomeSignals:number}[];weeks:{personId:string;week:string;deliveries:number}[];period:string;taskPeriod:string;detail:string;connections:{source:string;state:string}[]};

const STATE: Record<string, 'success' | 'warning' | 'neutral'> = { connected: 'success', partial: 'warning', live: 'success' };

/** Recorded work, never a score: deliveries credited to a person, tracker tasks, upload/create actions and check-ins.
 *  Company view (leadership): pods, then people, then which sources feed the numbers. Person view: one person's figures. */
export async function PerformanceSignals({personId,company=false,compact=false}:{personId?:string;company?:boolean;compact?:boolean}){
  const words = await vocabulary();
  const result=await api<Data>(`performance?${new URLSearchParams(company?{scope:'company'}:{person:personId??''})}`);const d=result.data;
  if(!d)return <p className={css.note}>{result.error??'Performance signals are unavailable right now.'}</p>;
  const coverage=<Panel fill title="What feeds these numbers" sub="Sources and their state">
    <ul className={styles.list}>{d.connections.map(c=><li key={c.source} className={styles.row}><span className={styles.rowMain}><span className={styles.rowTitle}>{c.source}</span></span><span className={styles.rowEnd}><Badge tone={STATE[c.state]??'neutral'}>{c.state.replaceAll('_',' ')}</Badge></span></li>)}</ul>
  </Panel>;
  const attendanceEnabled = d.attendanceEnabled === true;
  const note=<p className={css.note}>Counts what Pulse can see: files credited to a person, tracker tasks, upload and create actions{attendanceEnabled ? `, and check-ins (${d.period.charAt(0).toLowerCase() + d.period.slice(1)})` : ''}. Work through a shared login is credited to no one. These are records, not a productivity score.</p>;
  if(company) return <Workspace>
    {note}
    <Panel fill title={`${words.teams}`} sub={`${d.pods.length} ${lower(words.teams)} · current members`}>
      <Pager unit="pods"><div className={css.pods} data-items="">{d.pods.map(p=><article key={p.name} className={css.pod}>
        <h4><Users size={15} aria-hidden="true"/>{p.name}<Badge>{p.people} people</Badge></h4>
        <dl><div><dt>Credited deliveries</dt><dd>{count(p.deliveries)}</dd></div><div><dt>Tracker tasks</dt><dd>{count(p.taskCount)}<small>{count(p.doneTasks)} done</small></dd></div><div><dt>Upload / create</dt><dd>{count(p.observedActions)}</dd></div></dl>
        <small className={css.muted}>{p.qualitySignals} quality and {p.outcomeSignals} outcome signals recorded</small>
      </article>)}</div></Pager>
    </Panel>
    <Panel fill title="Team queues" sub={`${d.people.length} people · assigned work context`}>
      <table className={styles.table}><thead><tr><th>Person</th><th><W k="team" /></th><th className={styles.right}>Assigned tasks</th><th className={styles.right}>Blocked obligations</th><th className={styles.right}>Unknown state</th></tr></thead><tbody>{[...d.people].sort((a,b)=>a.name.localeCompare(b.name)).map(p=><tr key={p.id}><td><Link href={`/people/${p.id}?tab=work`}>{p.name}</Link><span className={styles.cellSub}>{p.role??'Role not set'}</span></td><td>{p.pod??`No ${lower(words.team)}`}</td><td className={styles.right}>{count(p.taskCount)}</td><td className={styles.right}>{count(p.blockedTasks)}</td><td className={styles.right}>{count(p.unknownTasks)}</td></tr>)}</tbody></table>
    </Panel>
    {coverage}
  </Workspace>;
  const p=d.people[0];
  if(!p) return <Workspace>{note}{coverage}</Workspace>;
  const trend=d.weeks.filter(w=>w.personId===p.id).map(w=>w.deliveries);
  // Inside another page's views (a person's Work tab): one panel, so views are never nested.
  if(compact) return <Panel fill title="Recorded work" sub={`${d.period} · records, not a score`}>
    <dl className={css.facts}>
      <div><dt>Credited deliveries</dt><dd>{count(p.deliveries)}<small>{count(p.allTimeDeliveries)} all time</small></dd></div>
      <div><dt>Upload / create</dt><dd>{count(p.observedActions+p.workEvents)}</dd></div>
      <div><dt>Tracker tasks</dt><dd>{count(p.taskCount+p.workUnits)}<small>{count(p.doneTasks)} done · {count(p.blockedTasks)} blocked</small></dd></div>
      {attendanceEnabled ? <div><dt>Check-in days</dt><dd>{count(p.attendanceDays)}</dd></div> : null}
      <div><dt>Quality & outcome signals</dt><dd>{p.qualitySignals+p.outcomeSignals||'Not recorded'}</dd></div>
    </dl>
    <p className={css.note} style={{padding:'0 16px 14px'}}>Files through a shared login are credited to no one; folder names do not prove quality; check-ins show presence, not hours.</p>
  </Panel>;
  return <Workspace>
    {note}
    <Tiles count={attendanceEnabled ? 5 : 4} dense>
      <Kpi label="Credited deliveries" value={p.deliveries} note={`${count(p.allTimeDeliveries)} across all history`} spark={trend.some(Boolean)?<Spark values={trend} label="Twelve weeks of credited deliveries"/>:undefined}/>
      <Kpi label="Upload / create" value={p.observedActions+p.workEvents} note="Actions on files in your name"/>
      <Kpi label="Tracker tasks" value={p.taskCount+p.workUnits} note={`${count(p.doneTasks)} done · ${count(p.blockedTasks)} blocked`}/>
      {attendanceEnabled ? <Kpi label="Check-in days" value={p.attendanceDays} note="Last 12 weeks"/> : null}
      <Kpi label="Quality & outcomes" value={p.qualitySignals+p.outcomeSignals||'Not recorded'} note="Approvals, revisions, client results"/>
    </Tiles>
    <Panel fill title="How to read this" sub={p.pod??`No ${lower(words.team)} yet`}>
      <ul className={styles.list}>
        <li className={styles.row}><CheckCheck size={16} aria-hidden="true" className={css.icon}/><span className={styles.rowMain}><span className={styles.rowTitle}>Quality</span><span className={styles.rowMeta}><span>Only explicit approvals, revisions and defects count ({p.qualitySignals} so far). A draft or final folder describes a file, not its quality.</span></span></span></li>
        <li className={styles.row}><Target size={16} aria-hidden="true" className={css.icon}/><span className={styles.rowMain}><span className={styles.rowTitle}>Outcomes</span><span className={styles.rowMeta}><span>Client approvals, leads and releases ({p.outcomeSignals} so far). Volume of files alone is not an outcome.</span></span></span></li>
        <li className={styles.row}><Gauge size={16} aria-hidden="true" className={css.icon}/><span className={styles.rowMain}><span className={styles.rowTitle}>{attendanceEnabled ? "Tasks and attendance" : "Tasks"}</span><span className={styles.rowMeta}><span>{d.taskPeriod}. {count(p.unknownTasks)} tasks have no recorded state.{attendanceEnabled ? " Check-ins show presence, not hours of work." : ""}</span></span></span></li>
      </ul>
    </Panel>
    {coverage}
  </Workspace>;
}

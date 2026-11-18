import Link from 'next/link';
import { api } from '../lib/api';
import { UserRoundCheck } from 'lucide-react';
import { Pager, Message, Page, PageHeader, QueryTabs, Empty, styles } from '../ui';
import { Navigation, text, s, time, type Row } from '../company/common';
import css from '../company/company.module.css';
import log from './activity.module.css';
import { orgZone } from '../lib/brand-server';
import { ActivityChats } from './chats';
import { Say } from '../kit/word';
// VISUAL-QA (D127, 13 Nov 2026): the three views are tabs that show which one is open (they were three plain buttons,
// only Chats marked current), and the note says in plain words what the API's detail said ("qualified attribution",
// "missing actors", "snapshot delivery time").
const CREDIT='An action counts for a person when it comes from their own account. What a shared login does, or an action with no one named, counts for no one. Times are when the action happened, not when Pulse saw it.';
/** "permissionChange" / "file_upload" → "Permission change" / "File upload". */
const action=(v:unknown)=>{const t=s(v).replace(/[_-]+/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase().trim();return t?t[0].toUpperCase()+t.slice(1):'Unknown';};
// VISUAL-QA (D129): who an action counts for, in words. The API's "unknown behind shared login", "unknown actor" and
// "account identity only; human unverified" repeated the Actor column, and the basis line ("single actor inherited from
// activity summary · 99%") pushed the table past the card's right edge at 1440 (a hidden sideways scroll).
const credit=(a:Row)=>{const h=s(a.human_attribution),sure=`${Math.round(Number(a.confidence)*100)}% sure`;
 if(/shared login/i.test(h))return {who:'No one',why:`Shared login · ${sure}`};
 if(/^unknown actor$/i.test(h))return {who:'No one',why:`No name · ${sure}`};
 if(/account identity only/i.test(h))return {who:'Their account',why:`Not confirmed · ${sure}`};
 return {who:text(h),why:sure};};
function ActivityTabs({current}:{current?:string}){return <QueryTabs base="/activity" current={current==='signals'||current==='chats'?current:'actions'} items={[{key:'actions',label:'Observed actions'},{key:'signals',label:'Starting signals by role'},{key:'chats',label:<Say t="Group and {team} chats"/>}]}/>;}
export default async function Activity({searchParams}:{searchParams:Promise<Record<string,string>>}) {
 const q=await searchParams;
 // AGENT-MEMORY: group, unit and function conversations (the viewer's own).
 if(q.tab==='chats')return <Page fit><PageHeader title="Activity" context={['Conversations you are in']}/><ActivityTabs current={q.tab}/><div className={css.content} data-grow=""><ActivityChats q={q} zone={await orgZone()}/></div></Page>;
 const signals=q.tab==='signals'?await api<{people:Row[];signals:Row[]}>('tracking-signals'):null;const r=await api<{rows:Row[];counts:Row;page:number;detail:string}>(`activity?${new URLSearchParams(q)}`);if(r.error)return <Message text={r.error}/>;const d=r.data;if(!d)return null;
 return <Page fit><PageHeader title="Activity" context={[`${text(d.counts.observations)} observed actions · ${text(d.counts.named)} attributed to people`]}/><ActivityTabs current={q.tab}/><p className={css.note}>{CREDIT}</p><div className={css.content} data-grow=""><Pager className={css.sheet} primary mobile={6}>{signals?.data?<>{q.view!=='people'?<table><thead><tr><th>Role</th><th>Starting signals</th><th>Connected</th><th>Pending</th></tr></thead><tbody>{signals.data.signals.map(x=><tr key={s(x.role)}><td>{text(x.role)}</td><td>{text(x.starting)}</td><td>{text(x.connected)}</td><td>{text(x.pending)}</td></tr>)}</tbody></table>:null}<QueryTabs sub base="/activity" keep="tab=signals" param="view" current={q.view==='people'?'people':'roles'} items={[{key:'roles',label:'Role signals'},{key:'people',label:'Connected people'}]}/>{q.view==='people'?<table><thead><tr><th>Person</th><th>Role</th><th>Qualified uploads / creates</th><th>Assigned tracker tasks</th></tr></thead><tbody>{signals.data.people.map(p=><tr key={s(p.id)}><td><Link href={`/activity?person=${p.id}`}>{text(p.name)}</Link></td><td>{text(p.role)}</td><td>{text(p.actions)}</td><td><Link href={`/tasks?person=${p.id}`}>{text(p.tasks)}</Link></td></tr>)}</tbody></table>:null}</>:!d.rows.length?<Empty first icon={UserRoundCheck} title="No actions to show yet" text="Uploads, edits and approvals appear here with who did them."/>:<><table className={log.log}><thead><tr><th>When / action</th><th>Actor</th><th>Project / file</th><th>Counts for</th></tr></thead><tbody>{d.rows.map(a=><tr key={s(a.source_key)}><td>{time(a.at)}<span className={styles.cellSub}>{action(a.operation)}</span></td><td>{a.actor_id?<Link href={`/people/${a.actor_id}`}>{text(a.personName)}</Link>:a.actor_kind==='shared_account'?'Shared login — person unknown':'Person unknown'}{a.actor_account?<span className={styles.cellSub}>{s(a.actor_account)}</span>:null}</td><td>{a.project_id?<Link href={`/projects/${a.project_id}`}>{text(a.projectName)}</Link>:s(a.project_key)||'No project'}<span className={styles.cellSub} title={s(a.fileName||a.file_id)}>{text(a.fileName||a.file_id)}</span></td><td>{credit(a).who}<span className={styles.cellSub} title={s(a.basis)||undefined}>{credit(a).why}</span></td></tr>)}</tbody></table></>}</Pager>{d.rows.length||d.page?<Navigation base="/activity" page={d.page} query={q}/>:null}</div></Page>;
}

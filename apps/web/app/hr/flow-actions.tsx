'use client';
import {useId,useState,type FormEvent} from 'react';
import {ChevronDown,Inbox,Sun} from 'lucide-react';
import {notify} from '@pulse/ui-shell';
import {Drawer,DrawerFooter,DrawerSection,Select} from '../kit';
import {useDoParam} from '../lib/do-param';
import {dest} from '../destinations/registry.mjs';
import {useRouter} from 'next/navigation';
import {post} from '../records';
import {Avatar,Badge,Empty,Fit,Panel,Why,styles} from '../ui';
import {ago,dayTime,longDay} from '../lib/format';
import {Clamp} from './desk/clamp';
import {shortRange} from './desk/parts';
import {REG_KIND,dayCount,type RegKind} from './types';
import type {Flow,FlowData,FlowSettings,WorkCalendar} from './flow-types';
import css from './flows.module.css';
import {PodCards} from './pods';
const weekdays=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
// UX-5A: "Saved" (or an error) shows in a status line that is always there, so nothing moves when it appears.
function useSave(){const router=useRouter();const[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState('');return {busy,error,done,save:async(path:string,data:unknown,said='Saved')=>{setBusy(true);setError('');setDone('');try{await post(path,data);setDone(said);router.refresh();return true;}catch(e){setError(e instanceof Error?e.message:'Could not save');return false;}finally{setBusy(false);}}};}
/** UX-5A: working on a weekly off or holiday is an action, not a block on the page: "Work on a day off…" opens a small
 *  drawer: the day (days already asked for are marked, never a button that changes its words), a note, and comp-off
 *  credits. The confirmation shows in Pip's island; nothing on the page moves. `?do=day-off` opens it (Ctrl+K). */
export function WorkDays({data,variant='ghost'}:{data:WorkCalendar;variant?:'ghost'|'plain'}){
 const router=useRouter();const[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const requests=new Set(data.work.filter(d=>d.status==='pending'&&d.personId===data.me).map(d=>d.day));
 const off=data.days.filter(d=>!d.working),first=off.find(d=>!requests.has(d.day))??off[0];
 const[chosen,setChosen]=useState(first?.day??''),[note,setNote]=useState('');
 const selected=off.some(d=>d.day===chosen)?chosen:first?.day??'';
 useDoParam('day-off',()=>setOpen(true));
 async function ask(){setBusy(true);setError('');try{await post('hr/work-days',{day:selected,note});notify({id:'work-day',tone:'success',title:`Asked to work on ${longDay(selected)}`,message:'Your pod head and HR decide; you hear back here.',timeout:3500});setOpen(false);setNote('');router.refresh();}catch(e){setError(e instanceof Error?e.message:'Could not save');}finally{setBusy(false);}}
 return <>
  <button type="button" className={`${styles.btn}${variant==='ghost'?` ${styles.btnGhost}`:''}`} onClick={()=>{setError('');setOpen(true);}} {...dest("me.attendance.day-off")}><Sun size={14} aria-hidden="true"/>Work on a day off…</button>
  {open?<Drawer title="Working on a day off?" icon={<Sun size={16}/>} size="sm" onClose={()=>setOpen(false)}
   help={<>Your pod head and HR see the request. After approval and a check-in that day, you earn {data.compPolicy.credit} day comp-off, valid for {data.compPolicy.expiryDays} days. Standing working days use your moved weekly off.</>}
   footer={<DrawerFooter status={error}><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={()=>setOpen(false)}>Cancel</button>
    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy||!selected||requests.has(selected)} onClick={()=>void ask()}>{selected?`I'll work on ${longDay(selected)}`:'Choose a day'}</button></DrawerFooter>}>
   <section className={css.dayOff} aria-label="Work on a weekly off or holiday">
    <DrawerSection title="Which day">
     {off.length?<Select label="Weekly off or holiday" value={selected||null} onChange={v=>setChosen(v??'')} options={off.map(d=>({value:d.day,label:`${longDay(d.day)}${d.holiday?` · ${d.holiday}`:''}`,detail:requests.has(d.day)?'Already asked':d.holiday?'Holiday':'Weekly off'}))}/>:<p className={styles.muted}>No weekly off or holiday in the next weeks.</p>}
     {selected&&requests.has(selected)?<p className={css.meta}>You already asked for this day; it waits for a decision.</p>:null}
    </DrawerSection>
    <DrawerSection title="Note (optional)"><textarea className={css.note} aria-label="Note (optional)" maxLength={500} rows={2} value={note} onChange={e=>setNote(e.target.value)} placeholder="What you will work on"/></DrawerSection>
    {data.credits.length?<DrawerSection title="Comp-off you have" help="Apply for Comp-off from My desk → Leave. Credits must cover all requested dates.">
     <ul className={css.credits}>{data.credits.map(c=><li key={c.id}><b>{c.remaining} of {c.days}</b> day from {longDay(c.earnedOn)}<small>{c.expiresOn<data.today?'expired':`expires ${longDay(c.expiresOn)}`}</small></li>)}</ul>
    </DrawerSection>:null}
   </section>
  </Drawer>:null}
 </>;
}
function FlowAction({f,data}:{f:Flow;data:FlowData}){
 const a=useSave(),[note,setNote]=useState('');const own=f.personId===data.me;const hint=useId();
 return <div className={css.decide}><label className={styles.field}>Decision note or question<textarea className={css.note} maxLength={500} value={note} onChange={e=>setNote(e.target.value)} aria-describedby={hint} rows={2} /></label>
 {/* POLISH-2 (QA-E2E P2-21): HR deciding a correction before the pod head is an override, which needs a reason. */}
 <p id={hint} className={css.hint}>{own?'A reply needs a few words.':data.staff&&f.kind==='correction'&&f.stage==='pod_head'&&f.status==='pending'?'This is waiting for the pod head: deciding now overrides them, so say why.':'Needed to reject, ask or forward; optional to approve.'}</p><div className={css.actions}>
 {f.canDecide && (f.status==='pending'||data.staff)?<><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={a.busy} onClick={()=>a.save(`hr/flows/${f.id}/decision`,{action:'approved',note})}>{f.status==='pending'?'Approve':'Override: approve'}</button><button className={styles.btn} disabled={a.busy||note.trim().length<3} onClick={()=>a.save(`hr/flows/${f.id}/decision`,{action:'rejected',note})}>{f.status==='pending'?'Reject':'Override: reject'}</button>
 {f.status==='pending'?<><button className={`${styles.btn} ${styles.btnGhost}`} disabled={a.busy||note.trim().length<3} onClick={()=>a.save(`hr/flows/${f.id}/decision`,{action:'ask',note})}>Ask</button>{data.staff&&f.stage!=='cofounder'?<button className={`${styles.btn} ${styles.btnGhost}`} disabled={a.busy||note.trim().length<3} onClick={()=>a.save(`hr/flows/${f.id}/decision`,{action:'forward',note})}>Forward to co-founder</button>:null}</>:null}</>:null}
 {own&&f.status==='pending'?<><button className={styles.btn} disabled={a.busy||note.trim().length<3} onClick={()=>a.save(`hr/flows/${f.id}/decision`,{action:'reply',note})}>Reply</button><button className={`${styles.btn} ${styles.btnGhost}`} disabled={a.busy} onClick={()=>a.save(`hr/flows/${f.id}/decision`,{action:'cancelled',note})}>Withdraw</button></>:null}</div><p role={a.error?"alert":"status"} className={css.status} data-tone={a.error?"error":"done"}>{a.error||a.done}</p></div>;
}
const KIND:Record<string,string>={leave:'Leave',correction:'Correction',work:'Day-off work',request:'Request'};
const STAGE:Record<string,string>={pod_head:'With pod head',hr:'With HR',cofounder:'With co-founder'};
const DONE:Record<string,[string,'success'|'danger'|'neutral']>={approved:['Approved','success'],rejected:['Rejected','danger'],cancelled:['Withdrawn','neutral']};
const ACTION:Record<string,string>={submitted:'Asked',created:'Asked',approved:'Approved',rejected:'Rejected',ask:'Asked a question',reply:'Replied',forward:'Forwarded to co-founder',cancelled:'Withdrawn'};
const cap=(s:string)=>s.charAt(0).toUpperCase()+s.slice(1);
/** The request in words: "Sick leave", "Missed check-in or check-out", "Work on a day off", or the subject someone wrote. */
function subjectOf(f:Flow){
 if(f.kind==='leave'){const k=f.subject.replace(/ leave$/,'');return k==='comp_off'?'Comp-off':`${cap(k.replace(/_/g,' '))} leave`;}
 if(f.kind==='correction'){const k=f.subject.split(' ')[0] as RegKind;return REG_KIND[k]??cap(f.subject.replace(/_/g,' '));}
 if(f.kind==='work')return 'Work on a day off';
 return f.subject;
}
/** One request: who and what with its state; when, how long, who decides; why; flags. "Decide" opens the history and the decision. */
function FlowCard({f,data,selected}:{f:Flow;data:FlowData;selected:boolean}){
 // The open part is rendered only while open, so a pager around the list measures the card again.
 const [open,setOpen]=useState(selected);const own=f.personId===data.me;
 const done=DONE[f.status];const d=f.details??{};const days=Number(d.days);
 const times=d.inTime||d.outTime?`In ${String(d.inTime??'scheduled start').slice(0,5)} · out ${String(d.outTime??'scheduled end').slice(0,5)}`:'';
 const asked=f.history[0]?.at;
 const label=f.canDecide&&f.status==='pending'?'Decide':own&&f.status==='pending'?'Reply or withdraw':f.canDecide?'History and override':'History';
 return <article id={f.id} className={css.flow} data-done={done?'':undefined}>
  <div className={css.flowTop}>
   <Avatar name={f.name} id={f.personId} size={32}/>
   <span className={css.flowWho}><b>{f.name}</b><span>{subjectOf(f)}</span></span>
   <span className={css.flowState}><Badge>{KIND[f.kind]??cap(f.kind)}</Badge>{done?<Badge tone={done[1]}>{done[0]}</Badge>:<Badge tone={f.canDecide?'warning':'neutral'}>{STAGE[f.stage]??cap(f.stage)}</Badge>}</span>
  </div>
  <div className={css.flowBody}>
   <p className={css.flowMeta}><span><b>{shortRange(f.fromDate,f.toDate)}</b>{days?` · ${dayCount(days)}${d.halfDay?` (${d.halfDay} half)`:''}`:''}</span>{times?<span>{times}</span>:null}<span>{f.headName?`Pod head: ${f.headName}`:'No pod head: HR decides'}</span>{asked?<span>asked {ago(asked)}</span>:null}</p>
   {f.needsHr.length||d.advanceNotice?.late?<p className={css.flowFlags}>{f.needsHr.map(n=><Badge key={n} tone="warning">Needs HR: {n}</Badge>)}{d.advanceNotice?.late?<span title="The request is allowed for review."><Badge tone="warning">Short notice: {Math.max(0,d.advanceNotice.given)} of {d.advanceNotice.required} {d.advanceNotice.unit}</Badge></span>:null}</p>:null}
   {f.note?<Clamp className={css.flowNote} text={`“${f.note}”`}/>:null}
   {f.decisionNote?<p className={css.flowDecision}><span>Latest note</span>{f.decisionNote}</p>:null}
  </div>
  <details className={css.flowMore} open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
   <summary><ChevronDown size={14} aria-hidden="true"/><span>{label}</span>{f.history.length?<small title={`${f.history.length} in the history`}>{f.history.length}</small>:null}</summary>
   {open?<div className={css.flowOpen}>
    <ol className={css.trail} aria-label="History">{f.history.map(e=><li key={e.id}><b>{ACTION[e.action]??cap(e.action)}</b><span>{e.by??'Imported record'} · {dayTime(e.at)}</span>{e.note?<p>“{e.note}”</p>:null}</li>)}</ol>
    {f.canDecide||own?<FlowAction f={f} data={data}/>:null}
   </div>:null}
  </details>
 </article>;
}
// POLISH-2: on a phone the three filters wrapped onto two lines; they show their short words there (same names).
const FILTERS=[['waiting','Waiting for you','For you'],['mine','My requests','Mine'],['all','All visible requests','All']] as const;
const EMPTY:Record<string,[string,string]>={waiting:['Nothing waiting for you','Requests that need your decision land here, with their history and the policy they touch.'],mine:['You have no requests','Leave, corrections and day-off work you ask for are followed here until they are decided.'],all:['No requests yet','Every request you can see appears here once someone sends one.']};
/** Shared requests: one card each, paged inside the panel on a desktop HR desk (`fit`), a plain list elsewhere. */
export function FlowQueue({data,selected,fit}:{data:FlowData;selected?:string;fit?:boolean}){
 const [filter,setFilter]=useState<string>(selected?'all':'waiting');const rows=data.rows.filter(f=>filter==='all'||filter==='mine'&&f.personId===data.me||filter==='waiting'&&f.status==='pending'&&f.canDecide);
 const waiting=data.rows.filter(f=>f.status==='pending'&&f.canDecide).length;
 const panel=<Panel fill={fit} className={css.queue} title="Requests" sub={waiting?`${waiting} waiting for you`:'Nothing waiting for you'}
  tools={<><nav className={`${styles.segmented} ${css.filter}`} aria-label="Request filter">{FILTERS.map(([key,label,short])=><button key={key} type="button" className={styles.segment} aria-pressed={filter===key} aria-label={label} onClick={()=>setFilter(key)}><span className={css.full}>{label}</span><span className={css.short} aria-hidden="true">{short}</span></button>)}</nav>
   <Why detail="Pod heads and HR share each request and its history. Requests beyond policy need HR. Forwarded requests need an assigned co-founder. Nobody can decide their own request."/></>}>
  {rows.length?<div className={css.cards} data-items="">{rows.map(f=><FlowCard key={f.id} f={f} data={data} selected={selected===f.id}/>)}</div>
   :<Empty icon={Inbox} compact title={EMPTY[filter][0]} text={EMPTY[filter][1]}/>}
 </Panel>;
 return fit?<Fit className={css.queueFit}>{panel}</Fit>:panel;
}
export function FlowPolicies({data}:{data:FlowSettings}){
 const a=useSave();async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();await a.save('hr/flow-settings',Object.fromEntries(new FormData(e.currentTarget)));}
 return <section className={css.card}><h3>Approval and comp-off policy</h3><form onSubmit={submit} className={css.policyForm}>
 <fieldset className={css.group}><legend>Who approves</legend>{['leave','correction','work','request'].map(k=><label className={styles.field} key={k}>{({leave:'Leave',correction:'Attendance corrections',work:'Sunday / holiday work',request:'Other requests'} as Record<string,string>)[k]} approver<select name={`${k}_approver`} defaultValue={data.policy[`${k}_approver`]}>{[['pod_head','Pod head + HR visibility'],['hr','HR'],['cofounder','Co-founder']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>)}</fieldset>
 <fieldset className={css.group}><legend>Limits and comp-off</legend>{([['max_leave_days','Needs HR beyond days',.5,366,.5],['balance_buffer','Allowed days beyond balance',0,60,.5],['comp_credit','Comp-off credit per worked day',0,1,.5],['comp_expiry_days','Comp-off expiry (days)',1,730,1],['reminder_hours','Pending reminder after hours',1,168,1]] as const).map(([key,label,min,max,step])=><label key={key} className={styles.field}>{label}<input name={key} type="number" min={min} max={max} step={step} defaultValue={data.policy[key]} required/></label>)}</fieldset>
 <p className={`${css.meta} ${css.wide}`}>Unpaid, special/emergency and salary-affecting requests always need HR. HR may decide or forward with a note. HR’s own requests go to the assigned co-founders.</p><div className={css.actions}><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={a.busy}>Save approval policy</button></div><p role={a.error?"alert":"status"} className={css.status} data-tone={a.error?"error":"done"}>{a.error||a.done}</p></form></section>;
}
export function PodSetup({data}:{data:FlowSettings}){
 const a=useSave();
 const [co,setCo]=useState(data.people.find(p=>/kazuk/i.test(p.name))?.id??'');
 const now=data.cofounders.filter(c=>c.active).map(c=>data.people.find(p=>p.id===c.personId)).filter((p):p is FlowSettings['people'][number]=>!!p);
 // On a desktop the pods and this card scroll inside the page's body, so a long pod list is never cut off.
 return <div className={css.stack} data-grow=""><PodCards data={data}/>
 <section className={`${css.card} ${css.cofounders}`} aria-label="Co-founder decision role"><div><h3>Co-founder decision role</h3><p className={css.meta}>Assign Kazuk and the owner using their individual staff accounts. This role gives access to forwarded requests. Leadership or an admin assigns it, never to themselves.</p></div>
 <div className={css.coRow}><label className={styles.field}>Person<select value={co} onChange={e=>setCo(e.target.value)}><option value="">Choose a person</option>{data.people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><div className={css.actions}><button className={styles.btn} disabled={a.busy||!co} onClick={()=>a.save('hr/cofounders',{personId:co,active:true})}>Assign co-founder</button><button className={`${styles.btn} ${styles.btnGhost}`} disabled={a.busy||!co} onClick={()=>a.save('hr/cofounders',{personId:co,active:false})}>End co-founder role</button></div></div>
 <div className={css.coNow}><span>Co-founders now</span>{now.length?<ul>{now.map(p=><li key={p.id}><Avatar name={p.name} id={p.id} photoAt={p.photoAt??null} size={24}/>{p.name}</li>)}</ul>:<em>Nobody yet: forwarded requests wait until someone is assigned.</em>}</div>
 <p role={a.error?"alert":"status"} className={css.status} data-tone={a.error?"error":"done"}>{a.error||a.done}</p></section></div>;
}
export function PatternSetup({data,today}:{data:FlowSettings;today:string}){
 const a=useSave(),[days,setDays]=useState([2,3,4,5,6,7]);async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();await a.save('hr/work-patterns',{...Object.fromEntries(new FormData(e.currentTarget)),workDays:days});}
 return <section className={css.card}><h3>Per-person working pattern</h3><p className={css.meta}>For regular Sunday work, choose Tue–Sun and move the weekly off to Monday. Holidays remain off unless separately approved. A standing Sunday is a normal working day; comp-off is earned for an approved day off actually worked.</p><form onSubmit={submit} className={css.form}><label className={styles.field}>Person<select name="personId" required>{data.people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><div className={styles.field}><span>Working days</span><div className={css.days}>{weekdays.map((d,i)=><button type="button" key={d} className={styles.btn} aria-pressed={days.includes(i+1)} onClick={()=>setDays(days.includes(i+1)?days.filter(n=>n!==i+1):[...days,i+1])}>{d}</button>)}</div></div><label className={styles.field}>Starts<input type="date" name="fromDate" min={today} defaultValue={today} required/></label><label className={styles.field}>Ends (optional)<input type="date" name="toDate" min={today}/></label><label className={styles.field}>Reason<input name="reason" required minLength={3} maxLength={500}/></label><button className={styles.btn} disabled={a.busy||!days.length||days.length>6}>Save working pattern</button><p role={a.error?"alert":"status"} className={css.status} data-tone={a.error?"error":"done"}>{a.error||a.done}</p></form></section>;
}

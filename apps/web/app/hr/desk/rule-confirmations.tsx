"use client";
import {useEffect,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {Modal,post} from '../../records';
import {Info} from 'lucide-react';
import {Badge,Empty,Panel,Skeleton,styles} from '../../ui';
import css from '../desk.module.css';
import type {LeaveType} from '../types';
import { DateField } from "../../kit/date-field";
import { SelectField } from "../../kit/select-field";
import { Switch } from "../../kit";
import { count, dayYearOr } from "../../lib/format";
type Config=Record<string,unknown>;
type Person={id:string;name:string;handover:{label:string;done:boolean}[]}&Record<string,unknown>;
type Version={key:string;config:Config;version:number;effectiveFrom:string;confirmedAt:string};
type Data={today:string;proposals:Record<string,Config>;versions:Version[];people:Person[];emergencies:{id:string;name:string;recordBy:string;overdue:boolean;leaveId:string|null}[]};
type Preview={hash:string;asOf:string;rows:{personId:string;name:string;before:{available:number;pending:number;accrued:number;carried:number}|null;after:{available:number;pending:number;accrued:number;carried:number}|null}[]};
const titles:Record<string,string>={late_marks:'Late marks → leave deduction',half_day:'Automatic half-day attendance',advance_notice:'Advance notice for leave',emergency:'Emergency leave',special_routing:'Special leave routing',leave_balance:'Leave year and monthly balances',professional_tax:'Maharashtra Professional Tax',exit:'Notice period and exit'};
const labels:Record<string,string>={threshold:'Late marks per deduction',window:'Counting window',deduction:'Days deducted per group',balanceKind:'Leave balance',netMinutes:'Net work threshold (minutes)',arrivalCutoff:'First arrival cutoff (India time)',shortWorkingDays:'Notice for 1–2 days (working days)',longCalendarDays:'Notice for longer leave (calendar days)',longFromDays:'Longer leave starts at (days)',recordWorkingDays:'Record after return (working days)',notifyHours:`Notify pod head within (hours of shift start)`,unpaidDays:'Unpaid leave above (days) → co-founder',probationDays:'Probation leave above (consecutive days) → HR',yearStart:'Leave year starts in month',monthlyDays:'Days credited on the 1st',carryMax:'Maximum carry-forward at year end',confirmedDays:'Notice after confirmation (days)',settlementDays:'Settlement after last working day (days)'};
const descriptions:Record<string,string>={late_marks:'Each completed group deducts leave, including repeat groups. HR can waive a dated mark with a reason. A short balance can go negative and stays visible for HR review.',half_day:'Net work below the threshold OR first arrival after the cutoff marks a half day. Complete records only; approved WFH/on-duty days are exempt. Employees can request a correction.',advance_notice:'Late applications remain allowed. The approver sees the notice shortfall. Weekly offs and holidays do not count as working days.',emergency:`Notify the pod head now inside Pulse. Record matching leave after return; overdue records remain on the HR desk until recorded.`,special_routing:'Notice-period leave goes to HR. Nobody approves their own request. Existing HR exceptions still apply.',leave_balance:'Earlier monthly credits keep their existing rate. New credits start on the first monthly credit date on or after the effective date. The cap applies only at the year boundary.',professional_tax:'HR sets each employee’s tax category, work state and exemption. Missing inputs require review. Slabs use inclusive upper limits; the last slab has no limit. Versions stay dated and immutable.',exit:'HR records notice dates, last working day, handover and settlement target. Confirming supplies default notice lengths and a settlement target; dates can be reviewed by HR.'};
function RuleCard({ruleKey,data,types,reload}:{ruleKey:string;data:Data;types:LeaveType[];reload:()=>void}) {
 const latest=data.versions.filter(v=>v.key===ruleKey).at(-1);
 const [config,setConfig]=useState<Config>(latest?.config??data.proposals[ruleKey]);
 const [effective,setEffective]=useState(data.today),[review,setReview]=useState(false),[preview,setPreview]=useState<Preview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const active=data.versions.filter(v=>v.key===ruleKey&&v.effectiveFrom<=data.today).at(-1);
 const fieldLabel=(key:string)=>ruleKey==='exit'&&key==='probationDays'?'Notice during probation (days)':labels[key]??key;
 const locked=ruleKey==='leave_balance'&&!!latest;
 async function open(){setReview(true);setError('');setPreview(null);if(ruleKey==='leave_balance'){setBusy(true);try{setPreview(await post('hr/rules/preview',{key:ruleKey,config,effectiveFrom:effective}) as Preview);}catch(e){setError(e instanceof Error?e.message:'Could not preview');}finally{setBusy(false);}}}
 async function confirm(){setBusy(true);setError('');try{await post('hr/rules/confirm',{key:ruleKey,config,effectiveFrom:effective,version:latest?.version??0,previewHash:preview?.hash,confirm:true});setReview(false);reload();}catch(e){setError(e instanceof Error?e.message:'Could not confirm');}finally{setBusy(false);}}
 const patch=(key:string,value:unknown)=>setConfig({...config,[key]:value});
 return <Panel className={ruleKey==='professional_tax'?css.ruleWide:undefined} title={titles[ruleKey]} sub={latest?`Version ${latest.version} · effective ${dayYearOr(latest.effectiveFrom)}`:'Proposed · HR has not confirmed'} tools={<Badge tone={active?'success':'neutral'}>{active?'On':latest?'Scheduled — still off':'Off — awaiting HR confirmation'}</Badge>}>
  <div className={css.ruleBody}><p className={css.ruleText}>{descriptions[ruleKey]}</p>
  <fieldset disabled={busy||locked} style={{border:0,padding:0,margin:0,minWidth:0,display:'grid',gap:12,gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,220px),1fr))'}}>
   {Object.entries(config).filter(([key])=>!['slabs','timezone','state'].includes(key)).map(([key,value])=><label key={key} className={styles.field}>{fieldLabel(key)}
    {key==='balanceKind'?<SelectField value={String(value)} onChange={e=>patch(key,e.target.value)}>{types.filter(t=>t.paid&&t.annualDays!==null&&t.key!=='comp_off').map(t=><option key={t.key} value={t.key}>{t.name}</option>)}</SelectField>
     :key==='window'?<SelectField value={String(value)} onChange={e=>patch(key,e.target.value)}><option value="calendar_month">Calendar month</option><option value="calendar_week">Calendar week (Monday–Sunday)</option></SelectField>
     :<input type={key==='arrivalCutoff'?'time':'number'} min={0} max={key==='yearStart'?12:730} step={['deduction','monthlyDays','carryMax'].includes(key)?0.5:1} value={String(value)} onChange={e=>patch(key,key==='arrivalCutoff'?e.target.value:Number(e.target.value))}/>}
   </label>)}
   {ruleKey==='professional_tax'?<div className={`${styles.tableWrap} ${css.ruleTable}`}><table className={styles.table}><thead><tr><th>Category</th><th>Up to ₹ (inclusive)</th><th>Monthly ₹</th><th>February ₹</th></tr></thead><tbody>{(config.slabs as {category:string;upTo:number|null;monthly:number;february:number}[]).map((s,i)=><tr key={i}><td>{s.category}</td>{(['upTo','monthly','february'] as const).map(key=><td key={key}><input aria-label={`${s.category} slab ${i+1} ${key}`} type="number" min="0" value={s[key]??''} placeholder={key==='upTo'?'No limit':''} onChange={e=>patch('slabs',(config.slabs as Config[]).map((row,k)=>k===i?{...row,[key]:e.target.value===''&&key==='upTo'?null:Number(e.target.value)}:row))}/></td>)}</tr>)}</tbody></table></div>:null}
   <label className={styles.field}>Effective from<DateField min={data.today} value={effective} onChange={e=>setEffective(e.target.value)} required/></label>
  </fieldset>
  <div className={css.ruleFoot}>{locked?<p className={css.ruleText}>Transition confirmed. Use balance adjustments for individual corrections.</p>:<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={open}>Confirm and turn on</button>}</div></div>
  {review?<Modal title={`Confirm ${titles[ruleKey]}?`} onClose={()=>setReview(false)} scroll foot={<div className={styles.modalFoot}><p role="alert">{error}</p><button className={styles.btn} onClick={()=>setReview(false)}>Cancel</button><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy||(ruleKey==='leave_balance'&&!preview)} onClick={confirm}>{busy?'Checking…':'Confirm and turn on'}</button></div>}>
   <p>{descriptions[ruleKey]}</p><p>Starts {dayYearOr(effective, "on the day you choose")}. This confirms only this rule.</p>
   <dl>{Object.entries(config).filter(([k])=>k!=='slabs').map(([k,v])=><div key={k}><dt>{fieldLabel(k)}</dt><dd>{String(v)}</dd></div>)}</dl>
   {ruleKey==='professional_tax'?<dl>{(config.slabs as {category:string;upTo:number|null;monthly:number;february:number}[]).map((s,i)=><div key={i}><dt>{s.category} · {s.upTo===null?'above the previous limit':`up to ₹${count(s.upTo)}`}</dt><dd>₹{count(s.monthly)} monthly · ₹{count(s.february)} in February</dd></div>)}</dl>:null}
   {preview?<><p>Every employee’s balance as of {dayYearOr(preview.asOf)}. These figures will be checked again when you confirm.</p><div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Person</th><th>Before</th><th>After</th><th>Change</th><th>Pending</th></tr></thead><tbody>{preview.rows.map(r=><tr key={r.personId}><td>{r.name}</td><td>{r.before?.available??'—'}</td><td>{r.after?.available??'—'}</td><td>{r.before&&r.after?r.after.available-r.before.available:'—'}</td><td>{r.after?.pending??'—'}</td></tr>)}</tbody></table></div></>:null}
  </Modal>:null}
 </Panel>;
}
function Employment({data,reload}:{data:Data;reload:()=>void}) {
 const [chosen,setChosen]=useState(data.people[0]?.id??''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const person=data.people.find(p=>p.id===chosen);
 const [checks,setChecks]=useState(person?.handover??[]);
 async function save(event:FormEvent<HTMLFormElement>) {event.preventDefault();const d=new FormData(event.currentTarget);setBusy(true);setError('');try{await post(`hr/employment/${chosen}`,{...Object.fromEntries(d),ptCategory:d.get('ptCategory')||null,ptState:d.get('ptState')||null,ptExempt:d.get('ptExempt')==='on',handover:checks});reload();}catch(e){setError(e instanceof Error?e.message:'Could not save');}finally{setBusy(false);}}
 return <Panel className={css.ruleWide} title="Employee probation, tax and exit records"><div className={css.ruleBody}><label className={styles.field}>Person<SelectField value={chosen} onChange={e=>{setChosen(e.target.value);setChecks(data.people.find(p=>p.id===e.target.value)?.handover??[]);}}>{data.people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</SelectField></label>
  {person?<form key={chosen+JSON.stringify(person)} onSubmit={save} style={{display:'grid',gap:12}}>
   {['probationFrom','probationTo','noticeFrom','noticeTo','lastWorkingDay','settlementTarget'].map(key=><label className={styles.field} key={key}>{({probationFrom:'Probation starts',probationTo:'Probation ends',noticeFrom:'Notice starts',noticeTo:'Notice ends',lastWorkingDay:'Last working day',settlementTarget:'Settlement target'} as Record<string,string>)[key]}<DateField name={key} defaultValue={String(person[key]??'')}/></label>)}
   <label className={styles.field}>PT category<SelectField name="ptCategory" defaultValue={String(person.ptCategory??'')}><option value="">HR must review</option><option value="men">Men’s slab</option><option value="women">Women’s slab</option></SelectField></label>
   <label className={styles.field}>PT work state<SelectField name="ptState" defaultValue={String(person.ptState??'')}><option value="">HR must review</option><option value="MH">Maharashtra</option><option value="other">Other state</option></SelectField></label>
   <Switch inline name="ptExempt" defaultChecked={person.ptExempt===true} label="Professional Tax exemption verified by HR"/>
   <p className={css.ruleSub}>Handover checklist</p>{checks.map((item,i)=><label key={i} className={css.handover}><input type="checkbox" checked={item.done} onChange={e=>setChecks(checks.map((c,k)=>k===i?{...c,done:e.target.checked}:c))}/><input aria-label={`Handover item ${i+1}`} value={item.label} onChange={e=>setChecks(checks.map((c,k)=>k===i?{...c,label:e.target.value}:c))}/></label>)}
   <button type="button" className={styles.btn} onClick={()=>setChecks([...checks,{label:'Return assets and access',done:false}])}>Add handover item</button>
   <p className={css.ruleText}>When the exit rule is on, an empty notice end or settlement target uses the confirmed default. HR can enter reviewed dates.</p><p role="alert">{error}</p><button className={styles.btn} disabled={busy}>Save employee record</button>
  </form>:null}</div>
 </Panel>;
}
export function RuleConfirmations({types}:{types:LeaveType[]}) {
 const router=useRouter();const [data,setData]=useState<Data|null>(null),[error,setError]=useState('');
 async function load(){try{const r=await fetch('/api/v0/hr/rules',{cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error);setData(d);}catch(e){setError(e instanceof Error?e.message:'Rules unavailable');}}
 useEffect(()=>{queueMicrotask(()=>void load());},[]);
 const reload=()=>{void load();router.refresh();};
 // UI-POLISH-3: skeleton cards while the proposals load; a failure says so with Try again (it was a bare line of text).
 if(!data)return error?<Panel title="Proposed rules"><Empty icon={Info} compact title="The proposed rules did not load" text={`The HR service said: “${error}”. Nothing has been changed.`}><button type="button" className={styles.btn} onClick={()=>{setError('');void load();}}>Try again</button></Empty></Panel>
  :<div className={css.ruleList} aria-busy="true"><span className={styles.srOnly}>Loading the proposed rules</span>{[0,1,2,3].map(i=><div key={i} className={styles.panel} style={{display:'grid',gap:10,padding:14}}><Skeleton width="45%"/><Skeleton height={12}/><Skeleton width="80%" height={12}/><Skeleton height={34}/></div>)}</div>;
 return <div className={css.ruleList}><p className={css.note} data-tone="accent"><Info size={14} aria-hidden="true"/><span><b>Proposed rules.</b> Each one ships off. HR confirms each separately and chooses its effective date.</span></p>
  {Object.keys(data.proposals).map(key=><RuleCard key={key+data.versions.filter(v=>v.key===key).length} ruleKey={key} data={data} types={types} reload={reload}/>)}
  <Employment data={data} reload={reload}/>
  <Panel title="Late-mark waiver"><div className={css.ruleBody}><form onSubmit={async e=>{e.preventDefault();const d=new FormData(e.currentTarget);try{await post('hr/rules/waive',Object.fromEntries(d));reload();}catch(err){setError(err instanceof Error?err.message:'Could not waive');}}} style={{display:'grid',gap:12}}><label className={styles.field}>Person<SelectField name="personId">{data.people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</SelectField></label><label className={styles.field}>Late day<DateField name="date" max={data.today} required/></label><label className={styles.field}>Reason<input name="reason" required minLength={3} maxLength={500}/></label><button className={styles.btn}>Waive this late mark</button></form></div></Panel>
  <Panel title="Emergency records needing HR follow-up"><div className={css.ruleBody}>{data.emergencies.filter(e=>e.overdue).map(e=><p key={e.id} className={css.ruleText}>{e.name} · record was due {dayYearOr(e.recordBy)}</p>)}{!data.emergencies.some(e=>e.overdue)?<p className={css.ruleText}>No overdue emergency records.</p>:null}</div></Panel><p role="alert">{error}</p>
 </div>;
}

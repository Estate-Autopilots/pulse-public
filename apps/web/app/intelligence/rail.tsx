'use client';
import Link from 'next/link';
import {notify} from '@pulse/ui-shell';
import { ArrowLeft, ArrowRight, Info, Lightbulb, RefreshCw, X } from 'lucide-react';
import { usePathname, useSearchParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { post } from '../records';
import { Badge, styles } from '../ui';
import type { Insight, Projection } from './types';
import css from './intelligence.module.css';
const time=(v:string|null)=>v?new Intl.DateTimeFormat('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'}).format(new Date(v)):'Not recorded';
/** Opens the insights drawer from anywhere (the account menu, Pip's "Ask Pip"). */
export function openInsights(){window.dispatchEvent(new Event('pulse:open-insights'));}
/** The account menu's entry for this page's insights (the menu closes itself on the click). */
export function InsightsMenuItem(){
 return <button type="button" role="menuitem" onClick={openInsights}><Lightbulb size={16} aria-hidden="true"/>Insights for this page</button>;
}
const DOCKED='(min-width: 1180px) and (min-height: 600px)';
const onDocked=(done:()=>void)=>{const m=window.matchMedia(DOCKED);m.addEventListener('change',done);return()=>m.removeEventListener('change',done);};
export function IntelligenceRail() {
 const pathname=usePathname(),search=useSearchParams(),tab=search.get('tab'),subject=search.get('task')??search.get('location');
 return <RailContent key={`${pathname}:${tab}:${subject}`} pathname={pathname} tab={tab} subject={subject}/>;
}
/**
 * Insights and actions (LAYOUT-SWEEP): a drawer on the right with sections. On a computer (1180 px and wider) it sits
 * beside the page, which narrows to make room, so it never covers what you are working on; below that it is a sheet.
 * Opened from the account menu ("Insights for this page") or Pip ("Ask Pip"); Escape or × closes it.
 */
function RailContent({pathname,tab,subject}:{pathname:string;tab:string|null;subject:string|null}) {
 const router=useRouter();
 const [open,setOpen]=useState(false),[projection,setProjection]=useState<Projection|null>(null),[error,setError]=useState(''),[selected,setSelected]=useState<Insight|null>(null),[mode,setMode]=useState<'cards'|'why'|'action'>('cards'),[busy,setBusy]=useState(false),[reason,setReason]=useState(''),[backlog,setBacklog]=useState(false);
 const panel=useRef<HTMLElement>(null);
 // Beside the page on a computer (not modal); a sheet with a dimmed page below that (modal: Android back closes it).
 const docked=useSyncExternalStore(onDocked,()=>window.matchMedia(DOCKED).matches,()=>true);
 const close=useCallback(()=>{setOpen(false);setSelected(null);setMode('cards');},[]);
 const load=useCallback(async(signal?:AbortSignal)=>{
  try{const q=new URLSearchParams({path:pathname,tab:tab??''});if(subject)q.set('subject',subject);const r=await fetch(`/api/v0/intelligence?${q}`,{cache:'no-store',signal});const d=await r.json();if(!r.ok)throw new Error(d.error??'Evidence unavailable');if(!signal?.aborted){setProjection(d);setError('');}}
  catch(e){if(!signal?.aborted){setProjection(null);setError(e instanceof Error?e.message:'Evidence unavailable');}}
 },[pathname,tab,subject]);
 // Pip's menu ("Ask Pip") and the account menu open the insights for this page.
 useEffect(()=>{const ask=()=>{setOpen(true);setMode('cards');};window.addEventListener('pulse:ask-pip',ask);window.addEventListener('pulse:open-insights',ask);return()=>{window.removeEventListener('pulse:ask-pip',ask);window.removeEventListener('pulse:open-insights',ask);};},[]);
 useEffect(()=>{const abort=new AbortController();queueMicrotask(()=>void load(abort.signal));const tick=async()=>{try{const r=await fetch('/api/v0/briefs/tick',{cache:'no-store',signal:abort.signal});if(r.ok){const data=await r.json() as {ready_ids:string[]};for(const id of data.ready_ids)notify({id:'brief:'+id,tone:'info',title:'Your role brief is ready',action:{label:'Open brief',run:()=>{router.push('/briefs');}},timeout:6000});}}catch{}};queueMicrotask(()=>void tick());const changed=()=>{void load(abort.signal);void tick();};window.addEventListener('pulse:data-changed',changed);
 // Insights are recomputed when the data changed (the shell's DataPulse says so), not on a timer; only the brief tick keeps its minute.
 const timer=setInterval(()=>{if(document.visibilityState==='visible')void tick();},60000);return()=>{abort.abort();clearInterval(timer);window.removeEventListener('pulse:data-changed',changed);};},[load,router]);
 // While open: the page makes room on a computer (the shell reads data-drawer), Escape closes, focus goes into the drawer and back.
 useEffect(()=>{
  if(!open)return;
  const root=document.documentElement,before=document.activeElement as HTMLElement|null;root.dataset.drawer='open';
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!document.querySelector('[aria-modal="true"]:not([data-insights])')){e.stopPropagation();close();}};
  document.addEventListener('keydown',key);requestAnimationFrame(()=>panel.current?.querySelector<HTMLElement>('[data-autofocus], button')?.focus());
  return()=>{delete root.dataset.drawer;document.removeEventListener('keydown',key);before?.focus?.();};
 },[open,close]);
 async function show(c:Insight,next:'why'|'action') {
  setError('');setBusy(true);
  try{const r=await fetch(`/api/v0/intelligence/receipts/${c.id}`,{cache:'no-store'});if(!r.ok)throw new Error('This evidence is no longer authorized. Refresh insights.');setSelected(await r.json());setMode(next);setReason('');}
  catch(e){setError(e instanceof Error?e.message:'Evidence unavailable');await load();}finally{setBusy(false);}
 }
 async function decide(action:string) {if(!selected)return;setBusy(true);setError('');try{await post(`intelligence/${selected.id}/decision`,{action,reason});await load();setMode('cards');setSelected(null);}catch(e){setError(e instanceof Error?e.message:'Could not save');}finally{setBusy(false);}}
 const cards=projection?[...projection.cards,...(backlog?projection.backlog:[])]:[];
 if(!open||typeof document==='undefined')return null;
 const back=()=>{setMode('cards');setSelected(null);setError('');};
 return createPortal(<div className={css.layer} data-insights="" onMouseDown={(e)=>{if(e.target===e.currentTarget)close();}}>
  <aside ref={panel} className={css.drawer} data-float-sheet="" role="dialog" aria-modal={docked?undefined:true} aria-label="Insights and actions" data-insights="">
   <header className={css.head}>
    {mode==='cards'?<span className={css.headIcon} aria-hidden="true"><Lightbulb size={16}/></span>:<button type="button" className={css.iconBtn} onClick={back} aria-label="Back to insights" data-autofocus=""><ArrowLeft size={16} aria-hidden="true"/></button>}
    <div className={css.headText}><h2>{mode==='why'?'Why Pulse shows this':mode==='action'?'Next step':'Insights'}</h2><p>{mode==='cards'?'For this page':selected?.headline}</p></div>
    {mode==='cards'?<button type="button" className={css.iconBtn} onClick={()=>void load()} aria-label="Refresh insights" title="Refresh"><RefreshCw size={15} aria-hidden="true"/></button>:null}
    <button type="button" className={css.iconBtn} onClick={close} aria-label="Close insights"><X size={16} aria-hidden="true"/></button>
   </header>
   <div className={css.body}>
    {error?<p className={css.notice} role="alert">{error}</p>:null}
    {mode==='cards'&&!projection&&!error?<p className={css.notice}>Checking authorized evidence…</p>:null}
    {mode==='cards'&&projection?<section className={css.section} aria-label="Next steps">
     <h3 className={css.label}>Next steps<span>{cards.length}</span></h3>
     {!cards.length?<div className={css.empty}><Info size={18} aria-hidden="true"/><b>No insight for this page yet</b><span>This page has no connected evidence for your account.</span><Link href="/me" className={styles.btn} onClick={close}>Open My desk</Link></div>:null}
     {cards.map(c=><article key={c.id} className={css.card} data-insight-card="">
      <h4>{c.headline}</h4><p>{c.meaning}</p>
      <div className={css.meta}><Badge tone={c.facts.some(f=>f.freshness==='stale')?'warning':'neutral'}>{c.confidence_label}</Badge><span title={c.coverage}>{c.coverage}</span></div>
      <div className={css.buttons}><button type="button" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} disabled={busy} onClick={()=>void show(c,'action')}>{c.next_action.label}<ArrowRight size={14} aria-hidden="true"/></button><button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} disabled={busy} onClick={()=>void show(c,'why')}>Why</button></div>
     </article>)}
     {projection.backlog.length?<button type="button" className={css.more} onClick={()=>setBacklog(!backlog)}>{backlog?'Hide':'Show'} related backlog · {projection.backlog.length}</button>:null}
    </section>:null}
    {mode==='why'&&selected?<>
     <section className={css.section}><h3 className={css.label}>Evidence</h3><p className={css.text}>{selected.revised?'Source revised since this receipt. Open the current source before acting.':`Receipt ${selected.lifecycle} · ${time(selected.as_of)}`}</p><div className={css.meta}><Badge>{selected.confidence_label}</Badge><span>{selected.coverage}</span></div></section>
     <section className={css.section}><h3 className={css.label}>Baseline and exclusions</h3><p className={css.text}>{selected.baseline}</p>{selected.exclusions.length?<ul className={css.bullets}>{selected.exclusions.map(x=><li key={x}>{x}</li>)}</ul>:null}</section>
     <section className={css.section}><h3 className={css.label}>Facts<span>{selected.facts.length}</span></h3>{selected.facts.map(f=><article key={f.id} className={css.card}><p className={css.text}>{f.statement}</p><dl className={css.facts}><dt>Occurred</dt><dd>{time(f.occurred_at)}</dd><dt>Observed</dt><dd>{time(f.observed_at)}</dd><dt>Freshness</dt><dd>{f.freshness}</dd><dt>Scope</dt><dd>{f.subject_ref}</dd><dt>Override version</dt><dd>{f.override_version}</dd></dl><Link className={`${styles.btn} ${styles.btnSmall}`} href={f.source_ref.href} onClick={close}>Open source receipt</Link></article>)}</section>
     <section className={css.section}><h3 className={css.label}>Other explanations</h3>{selected.hypotheses.length?<ul className={css.bullets}>{selected.hypotheses.map(x=><li key={x}>{x} <Badge>Hypothesis</Badge></li>)}</ul>:<p className={css.text}>No causal explanation is established.</p>}<Link className={`${styles.btn} ${styles.btnSmall}`} href={selected.correction_href} onClick={close}>Correct the source</Link></section>
    </>:null}
    {mode==='action'&&selected?<>
     <section className={css.section}><h3 className={css.label}>{selected.next_action.label}</h3><p className={css.text}>{selected.next_action.effect}</p><dl className={css.facts}><dt>Owner</dt><dd>{selected.next_action.owner??'Not assigned; confirm on the source'}</dd><dt>Authority</dt><dd>{selected.next_action.authority}</dd></dl>{selected.revised?<p role="status" className={css.text}>Evidence changed; review the current source.</p>:null}<Link className={`${styles.btn} ${styles.btnPrimary}`} href={selected.next_action.href} onClick={close}>Open exact action<ArrowRight size={14} aria-hidden="true"/></Link></section>
     <section className={css.section}><h3 className={css.label}>Affected records</h3><ul className={css.bullets}>{selected.facts.map(f=><li key={f.id}><Link href={f.source_ref.href} onClick={close}>{f.statement}</Link></li>)}</ul><p className={css.text}>Opening this preview does not change a record. Source edits use the existing review controls.</p></section>
     <section className={css.section}><h3 className={css.label}>Record your decision</h3><label className={css.field}>Reason<input value={reason} onChange={e=>setReason(e.target.value)} maxLength={500} placeholder="What should Pulse know?"/></label><div className={css.buttons}>{[['complete','Source action completed'],['dismiss','Dismiss'],['snooze','Snooze 1 day'],['useful','Useful'],['irrelevant','Irrelevant'],['false','Incorrect']].map(([action,label])=><button key={action} type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy||reason.trim().length<3} onClick={()=>void decide(action)}>{label}</button>)}</div></section>
    </>:null}
   </div>
   <footer className={css.foot}><Link href="/briefs" onClick={close}>Daily and weekly briefs<ArrowRight size={13} aria-hidden="true"/></Link></footer>
  </aside>
 </div>,document.body);
}

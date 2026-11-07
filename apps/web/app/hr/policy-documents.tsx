'use client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCheck, Download, FileText, Pencil, Printer, Send, Upload } from 'lucide-react';
import { notify } from '@pulse/ui-shell';
import { Modal, post } from '../records';
import { Action } from '../company/actions';
import { Badge, Empty, styles } from '../ui';
import {policyMarkdown} from "../lib/policy-format.mjs";
import { parseMarkdown } from '../lib/markdown.mjs';
import { KINDS } from './policy-kinds';
import { PolicyEditor, template, type EditorDoc } from './policy-editor';
import { PolicyReader } from './policy-reader';
import { docxBase64, PolicyWordEditor, type WordStatus } from './policy-word';
import reader from './policy-reader.module.css';
import css from './policies.module.css';

type Document={id:string;kind:string;title:string;body:string;version:number;revision:number;status:'draft'|'published';acknowledged:boolean;ackCount:number;created_at:string;updated_at:string|null;published_at:string|null;author:string|null;editor:string|null;publisher:string|null;docx_sha256?:string|null;docx_name?:string|null};
type Version={id:string;kind:string;title:string;version:number;status:string;created_at:string;published_at:string|null};
export type PolicyList={rows:Document[];canEdit:boolean;headcount:number;versions:Version[];acks:{document_id:string;name:string;at:string}[];word?:WordStatus|null};
const date=(v:string)=>new Date(v).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Kolkata'});
const CONFIRM=/(\(confirm\b[^)]*\))/i;
// R41: Word files are edited on wide screens; phones keep the reader (and the Markdown editor).
const WIDE='(min-width: 900px)';
const onWide=(change:()=>void)=>{const m=window.matchMedia(WIDE);m.addEventListener('change',change);return()=>m.removeEventListener('change',change);};

/** The confirmation sheet: what publishing does, and every "(confirm)" question still in the text. */
function PublishSheet({doc,headcount,onClose,onShow}:{doc:Document;headcount:number;onClose:(published:boolean)=>void;onShow:(id:string)=>void}){
 const confirm=parseMarkdown(policyMarkdown(doc.body)).confirm;const [agreed,setAgreed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function publish(){setBusy(true);setError('');try{await post('hr/policies/publish',{documentId:doc.id,revision:doc.revision});notify({id:'policy-publish',tone:'success',title:`Version ${doc.version} published`,message:'Everyone is asked to acknowledge it on My desk → Policies.',timeout:4000});onClose(true);}catch(e){setError(e instanceof Error?e.message:'Could not publish');setBusy(false);}}
 const sections=[...new Set(confirm.map(c=>c.section??''))];
 return <Modal title={`Publish version ${doc.version}?`} sub={doc.title} onClose={()=>onClose(false)} scroll foot={<div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={()=>onClose(false)}>Cancel</button><button type="button" data-autofocus="" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy||(!!confirm.length&&!agreed)} onClick={publish}><Send size={14} aria-hidden="true"/>{busy?'Publishing…':`Publish version ${doc.version}`}</button></div>}>
  <div className={css.sheet}>
   <p>Publishing shows this version to all {headcount} employees on <b>My desk → Policies</b> and asks each of them to acknowledge it; no email is sent. A published version cannot be changed; later edits become version {doc.version+1}.</p>
   {confirm.length?<>
    <h4>{confirm.length} {confirm.length===1?'item is':'items are'} still marked (confirm)</h4>
    <p className={styles.muted}>Settle each one in the text and remove its marker, or publish as written if HR and the founders have agreed them.</p>
    {sections.map(section=><section key={section} className={css.confirmGroup} aria-label={section||'Introduction'}>
     <h5>{section||'Introduction'}</h5>
     <ol>{confirm.filter(c=>(c.section??'')===section).map((c,i)=><li key={i}><p>{c.text.split(CONFIRM).map((part,k)=>CONFIRM.test(part)?<mark key={k} className={reader.confirm}>{part}</mark>:part)}</p>
      {c.sectionId?<button type="button" className={css.linkBtn} onClick={()=>onShow(c.sectionId!)} {...(c===confirm[0]?{'data-autofocus':''}:{})}>Show in the document</button>:null}</li>)}</ol>
    </section>)}
    <label className={css.agree}><input type="checkbox" checked={agreed} onChange={e=>setAgreed(e.target.checked)}/>HR and the founders have agreed {confirm.length===1?'this item':`these ${confirm.length} items`} as written</label>
   </>:<p className={css.clear}><CheckCheck size={16} aria-hidden="true"/>No “(confirm)” items are left in the text.</p>}
  </div>
 </Modal>;
}

/**
 * Company policies: the six documents in a list, the chosen one in the reader. HR (canEdit) also writes, edits and
 * publishes; employees only ever receive published versions and acknowledge the one they read. `aside` sits above the
 * list (HR desk: what needs attention); `selected` is the `doc` in the address.
 */
export function PolicyDocuments({initial,selected,aside}:{initial?:PolicyList|null;selected?:string;aside?:ReactNode}){
 const router=useRouter();
 const [data,setData]=useState<PolicyList|null>(initial??null),[error,setError]=useState(''),[chosen,setChosen]=useState<string|null>(KINDS.some(([k])=>k===selected)?selected!:null);
 const [editing,setEditing]=useState<EditorDoc|null>(null),[publishing,setPublishing]=useState<Document|null>(null);
 const [wordOpen,setWordOpen]=useState<string|null>(null),[uploading,setUploading]=useState(false),file=useRef<HTMLInputElement>(null);
 const wide=useSyncExternalStore(onWide,()=>window.matchMedia(WIDE).matches,()=>false);
 const reload=useCallback(()=>fetch('/api/v0/hr/policies',{cache:'no-store'}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error);setData(d);}).catch(e=>setError(e instanceof Error?e.message:'Policies are not available')),[]);
 useEffect(()=>{const load=()=>void reload();if(!initial)queueMicrotask(load);window.addEventListener('pulse:data-changed',load);return()=>window.removeEventListener('pulse:data-changed',load);},[initial,reload]);
 if(error&&!data)return <p role="alert">{error}</p>;
 if(!data)return <div className={css.split} aria-busy="true"><div className={`${styles.panel} ${css.list}`}/><div className={styles.panel}/></div>;
 // HR opens on what still needs work (a draft), employees on what they have not acknowledged yet.
 const kind=chosen??KINDS.find(([k])=>data.rows.some(d=>d.kind===k&&(data.canEdit?d.status==='draft':d.status==='published'&&!d.acknowledged)))?.[0]??KINDS.find(([k])=>data.rows.some(d=>d.kind===k))?.[0]??KINDS[0][0];
 const label=KINDS.find(([k])=>k===kind)![1];const doc=data.rows.find(d=>d.kind===kind);
 const older=data.versions.filter(v=>v.kind===kind&&v.id!==doc?.id);const live=doc?.status==='draft'?older.find(v=>v.status==='published'):undefined;
 const published=data.rows.filter(d=>d.status==='published').length;
 const choose=(k:string)=>{setChosen(k);const url=new URL(window.location.href);url.searchParams.set('doc',k);url.hash='';window.history.replaceState(window.history.state,'',url);};
 const edit=()=>setEditing({kind,kindLabel:label,title:doc?.title??`${label} policy`,body:doc?.body??template(`${label} policy`),version:doc?.version??0,revision:doc?.revision??1,published:doc?.status==='published',wordFile:doc?.docx_name??null});
 // R41: a Word file becomes the draft (its text is what the reader shows); only while Word editing is switched on.
 const word=data.canEdit?data.word??null:null;
 async function uploadWord(chosen:File){
  setUploading(true);
  try{await post('hr/policies/docx',{kind,title:doc?.title??`${label} policy`,version:doc?.version??0,revision:doc?.revision??1,name:chosen.name,data:await docxBase64(chosen,word?.maxBytes??0)});
   notify({id:'policy-word',tone:'success',title:'Word file saved as the draft',message:'Its text is what employees read once you publish.',timeout:4000});await reload();router.refresh();}
  catch(e){notify({id:'policy-word',tone:'error',title:'Word file not saved',message:e instanceof Error?e.message:'Could not save',timeout:6000});}
  finally{setUploading(false);if(file.current)file.current.value='';}
 }
 const upload=word?.enabled?<><input ref={file} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={e=>{const chosen=e.target.files?.[0];if(chosen)void uploadWord(chosen);}}/>
  <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={uploading} onClick={()=>file.current?.click()}><Upload size={14} aria-hidden="true"/>{uploading?'Uploading…':'Upload Word file'}</button></>:null;
 const show=(id:string)=>{setPublishing(null);requestAnimationFrame(()=>{const el=document.getElementById(id);el?.scrollIntoView({block:'start'});el?.focus({preventScroll:true});});};
 const who=doc?(doc.status==='published'?doc.publisher??doc.editor??doc.author:doc.editor??doc.author)??'HR':'';
 const when=doc?(doc.status==='published'?doc.published_at??doc.created_at:doc.updated_at??doc.created_at):'';
 const status=doc?(data.canEdit?<>
   {doc.status==='draft'?<Badge tone="warning">Draft — not published</Badge>:<Badge tone="success">Published</Badge>}
   <span className={reader.meta}><span>Version {doc.version}</span><span>{doc.status==='published'?'Published by ':'Edited by '}{who}, {date(when)}</span><span>Acknowledged {doc.ackCount} of {data.headcount}</span>{live?<span>Version {live.version} is what employees see</span>:null}{doc.docx_name?<span>Word file: {doc.docx_name}</span>:null}</span>
  </>:<>
   {doc.acknowledged?<Badge tone="success">You acknowledged this version</Badge>:<Badge tone="warning">Please read and acknowledge</Badge>}
   <span className={reader.meta}><span>Version {doc.version}</span><span>Published {date(doc.published_at??doc.created_at)}</span></span>
  </>):null;
 const actions=doc?<>
  <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={()=>window.print()} title="Print, or choose “Save as PDF” in the print dialog"><Printer size={14} aria-hidden="true"/>Print / PDF</button>
  {data.canEdit?<button type="button" className={styles.btn} onClick={edit}><Pencil size={14} aria-hidden="true"/>Edit</button>:null}
  {word?.enabled&&doc.docx_sha256&&wide?<button type="button" className={styles.btn} onClick={()=>setWordOpen(doc.id)}><Pencil size={14} aria-hidden="true"/>Edit in Word</button>:null}
  {upload}
  {word&&doc.docx_sha256?<a className={`${styles.btn} ${styles.btnGhost}`} href={`/api/v0/hr/policies/${doc.id}/docx`} download><Download size={14} aria-hidden="true"/>Word file</a>:null}
  {data.canEdit&&doc.status==='draft'?<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={()=>setPublishing(doc)}><Send size={14} aria-hidden="true"/>Publish…</button>:null}
 </>:null;
 const footer=doc?<>
  {doc.status==='published'?(data.canEdit?null:doc.acknowledged?<span className={css.done}><CheckCheck size={15} aria-hidden="true"/>You acknowledged version {doc.version}.</span>:<Action path="hr/policies/acknowledge" body={{documentId:doc.id}} label="I have read and acknowledge this policy"/>)
   :<span className={styles.muted}>Draft: only HR and leadership can read it. Employees see it once it is published.</span>}
  {data.canEdit&&(doc.ackCount||older.length)?<details className={css.history}><summary>Acknowledgements{older.length?' and earlier versions':''}</summary>
   {data.acks.filter(a=>a.document_id===doc.id).map(a=><p key={a.name+a.at}>{a.name} · {date(a.at)}</p>)}
   {older.map(v=><p key={v.id}>Version {v.version} · {v.status} · {date(v.published_at??v.created_at)} · {data.acks.filter(a=>a.document_id===v.id).length} acknowledgements</p>)}
  </details>:null}
 </>:null;
 return <div className={css.split} data-grow="">
  <div className={css.rail}>
   {aside}
   <nav className={`${styles.panel} ${css.list}`} aria-label="Policies">
    <p className={css.head}>{published?`${published} of ${KINDS.length} published`:'None published yet'}{data.canEdit?' · HR writes, people acknowledge':''}</p>
    {word?<p className={css.word} data-word={word.enabled?'on':'off'}>{word.label}{word.enabled&&!wide?' Edit Word files on a computer; here you can read them.':''}</p>:null}
    <ul>{KINDS.map(([k,t])=>{const d=data.rows.find(x=>x.kind===k);return <li key={k}><button type="button" className={css.item} aria-current={k===kind?'true':undefined} onClick={()=>choose(k)}>
     <FileText size={16} aria-hidden="true"/><span><b>{t}</b><small>{d?d.title:data.canEdit?'Not written yet':'Not published yet'}</small></span>
     {d?(d.status==='published'?(data.canEdit?<Badge tone="success">v{d.version}</Badge>:d.acknowledged?<Badge tone="success">Read</Badge>:<Badge tone="warning">To read</Badge>):<Badge tone="warning">Draft — not published</Badge>):null}
    </button></li>;})}</ul>
   </nav>
  </div>
  {doc?<PolicyReader key={doc.id} label={label} title={doc.title} body={doc.body} status={status} actions={actions} footer={footer}/>
   :<section className={styles.panel} aria-label={label}><Empty icon={FileText} first title={data.canEdit?`The ${label.toLowerCase()} policy is not written yet`:`HR has not published the ${label.toLowerCase()} policy yet`} text={data.canEdit?'Write it as a draft and read it through here; publish it when it is ready and everyone is asked to acknowledge that version.':'It appears here once HR publishes it.'}>{data.canEdit?<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={edit}><Pencil size={14} aria-hidden="true"/>Write the {label.toLowerCase()} policy</button>:null}{upload}</Empty></section>}
  {editing?<PolicyEditor doc={editing} onClose={saved=>{setEditing(null);if(saved){notify({id:'policy-draft',tone:'success',title:'Draft saved',message:'Employees keep seeing the published version until you publish.',timeout:3000});window.dispatchEvent(new Event('pulse:data-changed'));router.refresh();}}}/>:null}
  {wordOpen?<PolicyWordEditor documentId={wordOpen} kindLabel={label} onClose={opened=>{setWordOpen(null);if(!opened)return;
   notify({id:'policy-word',tone:'info',title:'Saving the Word file',message:'The editor sends it to Pulse a few seconds after it closes; the draft updates by itself.',timeout:6000});
   for(const wait of [6000,15000,30000])window.setTimeout(()=>void reload(),wait);}}/>:null}
  {publishing?<PublishSheet doc={publishing} headcount={data.headcount} onShow={show} onClose={done=>{setPublishing(null);if(done){void reload();router.refresh();}}}/>:null}
 </div>;
}

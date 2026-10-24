"use client";
import {useRef,useState} from 'react';
import { PrintBrand } from '../print-brand';
import {createPortal} from 'react-dom';
import {Modal,post} from '../records';
import {styles} from '../ui';
type Slip={name:string;month:string;gross:number;reimbursements:number;deductions:number;professionalTax:number;ptReview:boolean;ptVersion:number|null;net:number|null;currency:string;projection:boolean;canIssue:boolean;previewHash?:string;payslipVersion?:number;issuedAt?:string};
const MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];
const monthName=(m:string)=>`${MONTHS[Number(m.slice(5,7))-1]} ${m.slice(0,4)}`;
/** HR opens any month (a projection until it is issued). On their own desk a person (`own`) reads only payslips HR
 *  issued — with `issued` (months, newest first) they pick among those; Pulse never makes a payslip out of salary records
 *  for them (R43, enforced by the API and migration 0251). */
export function Payslip({personId,month,issued,own=issued!==undefined,label="View payslip"}:{personId:string;month:string;issued?:string[];own?:boolean;label?:string}) {
 const start=issued?(issued.includes(month)?month:issued[0]??month):month;
 const [open,setOpen]=useState(false),[selected,setSelected]=useState(start),[data,setData]=useState<Slip|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const request=useRef(0);
 async function read(value:string,projection=false){const token=++request.current;setBusy(true);setData(null);setError('');try{const r=await fetch(`/api/v0/hr/payslip/${personId}?month=${value}${own?'&issued=1':projection?'&projection=1':''}`,{cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error);if(token===request.current)setData(d);}catch(e){if(token===request.current)setError(e instanceof Error?e.message:'Could not read payslip');}finally{if(token===request.current)setBusy(false);}}
 async function issue(){if(!data||!window.confirm(`Issue this reviewed payslip for ${data.month}? It saves an immutable version the employee can read.`))return;setBusy(true);setError('');try{await post(`hr/payslip/${personId}`,{month:data.month,previewHash:data.previewHash,confirm:true});await read(data.month);}catch(e){setError(e instanceof Error?e.message:'Could not issue payslip');}finally{setBusy(false);}}
 const money=(n:number)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:data?.currency??'INR'}).format(n);
 const content=data?<article style={{padding:24}}><h3>{data.name} · {data.month}</h3><p>{data.projection?'Projected payslip from the restricted salary record.':`Issued payslip · version ${data.payslipVersion} · ${data.issuedAt?.slice(0,10)}`} Payroll payment has not been certified here.</p><dl>{[['Gross',data.gross],['Reimbursements',data.reimbursements],['Other deductions',data.deductions],['Professional Tax',data.professionalTax]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{money(Number(value))}</dd></div>)}<div><dt>{data.projection?'Net projection':'Net pay'}</dt><dd>{data.net===null?'Awaiting HR tax review':money(data.net)}</dd></div></dl><p>{data.ptReview?'HR must verify tax category and work state before the net projection can be completed.':data.ptVersion?`Professional Tax slab version ${data.ptVersion}`:'Professional Tax is off — awaiting HR confirmation.'}</p></article>:null;
 const none=!!issued&&!issued.length;
 return <><button className={styles.btn} onClick={()=>{setOpen(true);if(!none)void read(selected);}}>{label}</button>{open?<Modal title={data?.projection?"Projected payslip":"Payslip"} onClose={()=>{request.current++;setOpen(false);setData(null);}} foot={<div className={styles.modalFoot}>{data?.canIssue?(data.projection?<button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy||data.ptReview} onClick={issue}>Issue reviewed payslip</button>:<button className={styles.btn} disabled={busy} onClick={()=>void read(selected,true)}>Review updated projection</button>):null}<button className={styles.btn} onClick={()=>window.print()} disabled={!data}>Print / Save PDF</button></div>}>
  {none?<p role="status">No payslip has been issued to you yet. Payslips appear here once HR issues them; Pulse does not turn salary records into a payslip.</p>
   :issued?<label className={styles.field}>Salary month<select value={selected} onChange={e=>{setSelected(e.target.value);void read(e.target.value);}}>{issued.map(m=><option key={m} value={m}>{monthName(m)}</option>)}</select></label>
   :<label className={styles.field}>Salary month<input type="month" value={selected} onChange={e=>{setSelected(e.target.value);void read(e.target.value);}}/></label>}
  {none?null:<p role={error?'alert':'status'}>{error||(busy?(own?'Reading your payslip…':'Reading restricted salary…'):'')}</p>}{content}
 </Modal>:null}{open&&data?createPortal(<div className="pulse-print-root" aria-hidden="true"><PrintBrand/>{content}</div>,document.body):null}</>;
}

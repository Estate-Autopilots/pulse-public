import Link from 'next/link';
import { Download, FileText } from 'lucide-react';
import { api } from '../../lib/api';
import { dayName, inr } from '../../lib/finance-view.mjs';
import { Badge, Message, Page, PageHeader } from '../../ui';
import { FinanceNav } from '../nav';
import { FinTable, type FinCell, type FinCol } from '../table';
import type { LiveState } from '../types';
import { AccountantAccess, ApproveClose } from './actions';
import css from './desk.module.css';

type Row = {kind:string;key:string;body:Record<string,unknown>};
type Desk = {records:Row[];files:{key:string;name:string;mime:string}[];sends:{key:string;status:string}[];synthetic:boolean;accountant:boolean;canManage:boolean;canApprove:boolean;company:string;intakeMode:string;accountingSystem:string;setup:string[];people:{id:string;name:string}[]};
const value = (x:unknown):string => x === null || x === undefined ? 'Unknown' : typeof x === 'boolean' ? (x?'Yes':'No') : Array.isArray(x) ? x.map(value).join('; ') : typeof x === 'object' ? JSON.stringify(x) : String(x);
const fieldLabels:Record<string,string> = {vendor:'Party',gst:'GST total',clientGSTIN:'Client GSTIN',drive:'Filed in EA Finance',vendorGSTIN:'Vendor GSTIN',ourGSTINPresent:'Our GSTIN present',invoiceNo:'Invoice number',cgst:'CGST',sgst:'SGST',igst:'IGST',inr:'INR value',monthlyCost:'Monthly cost',nextRenewal:'Next renewal',priceChange:'Price change',whoWorked:'Who worked',moneyIn:'Money in',moneyOut:'Money out',openApprovals:'Open approvals'};
const fieldLabel = (key:string) => fieldLabels[key] ?? key[0].toUpperCase()+key.slice(1);
const views = ['purchase','sales','payroll','reimbursement','vendors','vendor','close','exception','brief','reminder'];
const labels:Record<string,string> = {purchase:'Purchase register',sales:'Sales invoices',payroll:'Payroll register',reimbursement:'Reimbursements',vendors:'Vendor list',vendor:'Subscriptions & spend',close:'Monthly close packs',exception:'Open exceptions',brief:'Founder 9 pm brief',reminder:'Founder reminders'};
const groups:[string,string[]][] = [['Registers',['purchase','sales','payroll','reimbursement']],['Vendors',['vendors','vendor']],['For the CA',['close','exception']],['Founders',['brief','reminder']]];
const columns:Record<string,string[]> = {purchase:['date','vendor','vendorGSTIN','ourGSTINPresent','invoiceNo','taxable','cgst','sgst','igst','gst','total','currency','inr','status','drive'],sales:['date','vendor','invoiceNo','taxable','total','currency','clientGSTIN','status','drive'],payroll:['month','name','kind','amount','currency','source','components','basis'],reimbursement:['date','name','vendor','total','currency','status'],vendors:['vendor','vendorGSTIN','owner'],vendor:['vendor','owner','monthlyCost','currency','nextRenewal','priceChange'],exception:['type','key','issues'],brief:['date','deliveries','whoWorked','moneyIn','moneyOut','openApprovals','risks'],reminder:['title']};
/** Which column titles a phone card and which gives its figure. */
const phone:Record<string,[string,string|null]> = {purchase:['vendor','total'],sales:['vendor','total'],payroll:['month','amount'],reimbursement:['name','total'],vendors:['vendor',null],vendor:['vendor','monthlyCost'],exception:['type',null],brief:['date',null],reminder:['title',null]};
const MONEY = new Set(['taxable','cgst','sgst','igst','gst','total','inr','amount','monthlyCost','priceChange','moneyIn','moneyOut']);
/** What an empty register is waiting for, and who supplies it. */
const waiting:Record<string,string> = {
 purchase:'No purchase bills yet. Vendor bills reach finance mail (billing@) and the live sync files them every six hours — Kazuk forwards any bill that went elsewhere.',
 sales:'No sales invoices yet. Zoho Invoice mails each invoice to finance mail — Kazuk.',
 payroll:'No payroll totals yet. Pulse payroll posts one total a month per account once a founder approves it; before that they come from the monthly cost sheet — HR.',
 reimbursement:'No reimbursement receipts are linked yet: a founder names the person on a purchase receipt.',
 vendors:'No vendors yet: the list is drawn from purchase bills once the first ones are filed — Kazuk.',
 vendor:'No subscriptions yet: recurring vendors appear after their second bill — Kazuk.',
 close:'No close pack yet: the first one is drafted on the 5th for the previous month, then a founder approves sending it to the CA.',
 exception:'No open exceptions: every filed bill has a GSTIN, an amount and a register line.',
 brief:'Founder briefs appear here once the notification worker sends them.',
 reminder:'Founder reminders appear here once the notification worker sends them.',
};
const drive = (x:unknown):FinCell => { if (!x) return null; if (typeof x === 'object' && x && 'id' in x) { const o = x as {id:string;path?:string;name?:string}; return {v:o.path ?? o.name ?? o.id, t:'Open PDF', href:`https://drive.google.com/file/d/${encodeURIComponent(o.id)}/view`}; } return value(x); };
const status = (x:unknown):FinCell => { const t = value(x), l = t.toLowerCase(); return {v:t, t:t[0]?.toUpperCase()+t.slice(1), chip:true, tone:/fail|missing|review|reject/.test(l)?'warning':/filed|match|paid|sent|approved|done/.test(l)?'success':'neutral'}; };
const cell = (k:string, body:Record<string,unknown>):FinCell => {
 const x = body[k];
 if (x === null || x === undefined || x === '') return null;
 if (MONEY.has(k)) { const n = Number(x), cur = String(body.currency ?? 'INR'); return Number.isFinite(n) ? {v:n, t:inr(n, k === 'inr' ? 'INR' : cur)} : value(x); }
 if (k === 'drive') return drive(x);
 if ((k === 'date' || k === 'nextRenewal') && /^\d{4}-\d{2}-\d{2}/.test(String(x))) return {v:String(x).slice(0,10), t:dayName(String(x))};
 if (k === 'status') return status(x);
 return value(x);
};

export default async function FinanceDeskPage({searchParams}:{searchParams:Promise<Record<string,string>>}) {
  const q = await searchParams;
  const result = await api<Desk>('finance/desk' + (q.pilot === 'synthetic' ? '?pilot=synthetic' : ''));
  const d = result.data;
  if (!d) return <Page calm><PageHeader title="Finance desk"/><Message text={result.error ?? 'Finance access unavailable. Set up two-step verification in Account / Security, then sign in again.'}/><Link href="/account">Account / Security</Link></Page>;
  // Founders see the Finance sections and the live strip; an Accountant sees the desk alone.
  const live = d.accountant ? null : (await api<LiveState>('finance/live')).data;
  const visibleViews = views.filter(v=>!d.accountant || !['brief','reminder'].includes(v));
  const selected = visibleViews.includes(q.view) ? q.view : 'purchase';
  const of = (v:string) => d.records.filter(r=>v === 'vendors' ? r.kind === 'vendor' : r.kind === v && (v !== 'vendor' || r.body.recurring !== false));
  const rows = of(selected);
  const fileUrl = (key:string) => `/api/v0/finance/desk/files/${encodeURIComponent(key)}${d.synthetic?'?pilot=synthetic':''}`;
  const href = (v:string) => `/finance/desk?${new URLSearchParams({view:v,...(d.synthetic?{pilot:'synthetic'}:{})})}`;
  const cols:FinCol[] = (columns[selected]??['key']).map(k=>({key:k,label:fieldLabel(k),align:MONEY.has(k)?'right':undefined,phone:k===phone[selected]?.[0]?'title':k===phone[selected]?.[1]?'value':k==='currency'?'hide':'line'}));
  return <Page calm><PageHeader title="Finance desk" context={[d.company,d.accountant?'Accountant · read only · every view audited':'Founder · private & audited']}/>
    {!d.accountant ? <FinanceNav tab="ca" live={live}/> : null}
    <div className={css.desk}>
      <p className={css.status}><Badge tone="warning">{d.synthetic?'Synthetic fixtures · no real mail or external sends':'Uncertified until the CA certifies the month'}</Badge><span>{d.synthetic?'Invented records for testing.':'Live register from finance mail and EA\'s sheets · payroll as monthly totals only'}</span><span className={css.links}><Link href="/finance/desk?pilot=synthetic">Fixture view</Link><Link href="/finance/desk">Live view</Link><Link href="/account">Account / Security</Link></span></p>
      <div className={css.layout}>
        <nav className={css.registers} aria-label="Finance registers">{groups.map(([name,list])=>{const own=list.filter(v=>visibleViews.includes(v));return own.length?<div key={name} className={css.group}><span>{name}</span>{own.map(v=><Link key={v} aria-current={selected===v?'page':undefined} href={href(v)}>{labels[v]}<small>{of(v).length}</small></Link>)}</div>:null;})}</nav>
        <section className={css.main} aria-labelledby="register-title">
          <h2 id="register-title" className={css.title}>{labels[selected]}</h2>
          {selected==='close' ? <ul className={css.queue}>{rows.map(r=>{const sent=d.sends.find(s=>s.key===r.key);return <li key={r.key} className={css.pack}>
            <div className={css.packHead}><b>{value(r.body.month)}</b>{sent?<Badge tone="success">Delivery: {sent.status}</Badge>:<Badge tone="warning">Not sent</Badge>}</div>
            <p>{value(r.body.coverage)}</p>
            <p className={css.muted}>To {value(r.body.to)} · {value(r.body.subject)} · open exceptions: {value(r.body.exceptions)}</p>
            <details><summary>Email to the CA</summary><p>{value(r.body.emailBody)}</p></details>
            <div className={css.packFoot}><a className={css.download} href={fileUrl(value(r.body.packKey))}><Download size={14} aria-hidden="true"/>Download close pack</a>{sent?null:d.canApprove?<ApproveClose closeKey={r.key} synthetic={d.synthetic}/>:<span className={css.muted}>Awaiting founder approval</span>}</div>
          </li>;})}{!rows.length?<li className={css.empty}>{d.synthetic?'No fixture entries in this register.':waiting.close}</li>:null}</ul>
          : <FinTable nowrap label={labels[selected]} csv={`ca-${selected}`} search={rows.length>8} scrollLabel="Register columns; scroll across for more" columns={cols}
              empty={d.synthetic?'No fixture entries in this register.':waiting[selected]}
              rows={rows.map(r=>{const file=d.files.find(f=>f.key===r.key);return {id:r.key,cells:Object.fromEntries(cols.map(c=>[c.key,cell(c.key,r.body)])),
                drawer:{title:value(r.body.vendor??r.body.name??r.body.type??r.body.month??r.key),sub:labels[selected],facts:Object.entries(r.body).filter(([,x])=>x!==null&&x!==undefined&&x!=='').map(([k,x])=>({label:fieldLabel(k),value:MONEY.has(k)&&Number.isFinite(Number(x))?inr(Number(x),k==='inr'?'INR':String(r.body.currency??'INR')):value(x)})),links:file?[{href:fileUrl(file.key),label:`Open ${file.name}`}]:undefined}};})}/>}
        </section>
        <aside className={css.side}>
          <section className={css.card}><h2>PDFs & exports</h2><p className={css.exports}><a href={`/api/v0/finance/desk/exports/tally${d.synthetic?'?pilot=synthetic':''}`}><Download size={14} aria-hidden="true"/>Tally register CSV</a><a href={`/api/v0/finance/desk/exports/zoho-books${d.synthetic?'?pilot=synthetic':''}`}><Download size={14} aria-hidden="true"/>Zoho Books register CSV</a></p>
            <ul className={css.files}>{d.files.map(f=><li key={f.key}><FileText size={14} aria-hidden="true"/><a href={fileUrl(f.key)}>{f.name}</a></li>)}</ul>{!d.files.length?<p className={css.muted}>No filed evidence yet: PDFs are filed in the EA Finance Shared Drive as bills and invoices arrive.</p>:null}</section>
          {d.canManage?<section className={css.card}><h2>Accountant access</h2><AccountantAccess people={d.people}/></section>:null}
          {!d.accountant?<section className={css.card}><h2>Owner setup</h2><p className={css.muted}>{d.accountingSystem}</p><ul className={css.setup}>{d.setup.map(s=><li key={s}>{s}</li>)}</ul><Link className={css.more} href="/finance?tab=close">Month close and certification →</Link></section>:null}
        </aside>
      </div>
    </div>
  </Page>;
}

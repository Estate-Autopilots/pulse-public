import { CalendarPlus } from 'lucide-react';
import {api} from '../../lib/api';
import {ModuleOff,offModuleResponse} from '../../module-off';
import {Page,Message} from '../../ui';
import {FlowQueue} from '../../hr/flow-actions';
import type {FlowData} from '../../hr/flow-types';
import {PrimaryLink,QuietLink,WorkHeader,WorkPage} from '../../components/work-kit';
/** Approvals: the requests and decisions waiting for the viewer, and their own requests. UX-WORK (owner, 5 Nov 2026): the
 *  page is called what the menu calls it, the counts are tiles, and one primary action asks for something (leave). */
export default async function Approvals({searchParams}:{searchParams:Promise<{request?:string}>}){
 const [query,r]=await Promise.all([searchParams,api<FlowData>('hr/flows')]);
 const rows=r.data?.rows??[],me=r.data?.me??null;
 const waiting=rows.filter(f=>f.status==='pending'&&f.canDecide).length,mine=rows.filter(f=>f.personId===me&&f.status==='pending').length,decided=rows.filter(f=>f.status!=='pending').length;
 return <Page><WorkPage>
  <WorkHeader back={{href:'/me',label:'My desk'}} eyebrow="My desk · requests and decisions" title="Approvals" context={waiting?'Decide the oldest first: each request shows its history and who else can see it.':'Leave, corrections and day-off work you ask for show here until they are decided.'}
   stats={r.data?[{label:'Waiting for you',value:waiting,tone:waiting?'warn':undefined},{label:'Yours, pending',value:mine},{label:'Decided',value:decided}]:undefined}
   actions={r.data?.staff?<QuietLink href="/hr">HR desk</QuietLink>:null}
   primary={<PrimaryLink href="/me?tab=leave" icon={CalendarPlus}>Ask for leave</PrimaryLink>}/>
  {r.data?<FlowQueue data={r.data} selected={query.request}/>:offModuleResponse(r)?<ModuleOff/>:<Message text={r.error??'Requests unavailable'}/>}
 </WorkPage></Page>;
}

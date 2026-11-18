import {api} from '../../lib/api';
import {Page} from '../../ui';
import {fixture} from './fixture';
import {empty,type WorkData} from './types';
import {WorkDesk} from './workspace';
/** My work: the credit for work that was accepted, each with its receipt, and one next step to grow. UX-WORK (owner,
 *  5 Nov 2026): one header in My day's language (WorkDesk draws it, so its primary action is done on this page). */
export default async function MyWork({searchParams}:{searchParams:Promise<Record<string,string>>}){const q=await searchParams;const demo=q.pilot==='synthetic';const r=demo?{data:fixture()}:await api<WorkData>('fair-work?'+new URLSearchParams(q));
 return <Page fit viewport>
  <WorkDesk initial={r.data??empty()} error={'error' in r?r.error:undefined} demo={demo}/>
 </Page>;}

import Link from 'next/link';
import {api,type ApiResult} from '../lib/api';
import {Page,PageHeader,styles} from '../ui';
import {AcquisitionDesk} from './workspace';
import {fixture} from './fixture';
import type {AcquisitionData} from './types';
export default async function Acquisition({searchParams}:{searchParams:Promise<Record<string,string>>}){
 const q=await searchParams;const [r,capabilities]:[ApiResult<AcquisitionData>,ApiResult<NonNullable<AcquisitionData['messaging']>>]=q.pilot==='synthetic'?[{data:fixture()},{data:{bindings:[],providerSends:false}}]:await Promise.all([api<AcquisitionData>('acquisition?'+new URLSearchParams(q)),api<NonNullable<AcquisitionData['messaging']>>('chats/provider-capabilities')]);if(r.data&&capabilities.data)r.data.messaging=capabilities.data;
 const empty:AcquisitionData={synthetic:false,leads:[],sources:[],reviews:[],spend:[],links:[],projects:[],people:[],permissions:{write:false,finance:false,admin:false},viewer:null,now:new Date().toISOString(),workspace:[]};
 return <Page fit viewport><PageHeader title="Acquisition" context={[r.data?.synthetic?'Synthetic rehearsal · no customer data':'Source → enquiry → verified outcome']} actions={<><Link href="/acquisition?pilot=synthetic" className={styles.btn}>Rehearse</Link><Link href="/finance" className={styles.btn}>Finance</Link></>}/><AcquisitionDesk initial={r.data??empty} q={q} error={r.error}/></Page>;
}

import Link from 'next/link';
import {api} from '../../lib/api';
import {ModuleOff,offModuleResponse} from '../../module-off';
import {Page,PageHeader,Message,styles} from '../../ui';
import {FlowQueue} from '../../hr/flow-actions';
import type {FlowData} from '../../hr/flow-types';
export default async function Approvals({searchParams}:{searchParams:Promise<{request?:string}>}){
 const [query,r]=await Promise.all([searchParams,api<FlowData>('hr/flows')]);
 return <Page><PageHeader title="Waiting for you" context={['Shared requests and decisions']} actions={<>{r.data?.staff?<Link href="/hr" className={styles.btn}>HR desk</Link>:null}<Link href="/me" className={styles.btn}>My desk</Link></>}/>{r.data?<FlowQueue data={r.data} selected={query.request}/>:offModuleResponse(r)?<ModuleOff/>:<Message text={r.error??'Requests unavailable'}/>}</Page>;
}

import Link from 'next/link';
import {api,getMe} from '../lib/api';
import {Page,PageHeader,Message,styles} from '../ui';
import {DeliveryDesk} from './workspace';
import {fixture} from './fixture';
import type {DeliveryData} from './types';
export default async function Delivery({searchParams}:{searchParams:Promise<Record<string,string>>}){
 const q=await searchParams;const r=q.pilot==='synthetic'?{data:fixture()}:await api<DeliveryData>(`delivery?${new URLSearchParams(q)}`);
 // VISUAL-QA (D77): Client access only for the people the database lets in (pulse.portal_admin: admin or leadership).
 const me=(await getMe()).data,clients=!!me&&(me.role==='admin'||me.role==='leadership'||!!me.lead);
 return <Page fit viewport><PageHeader title="Delivery" context={[r.data?.synthetic?'Synthetic project · rehearsal': 'Plan → produce → review → accept']} actions={<>{clients&&<Link className={styles.btn} href="/delivery/access">Client access</Link>}<Link className={styles.btn} href="/tasks">Source tracker</Link><Link className={styles.btn} href="/delivery?pilot=synthetic">Rehearse a project</Link></>}/>{r.data?<DeliveryDesk d={r.data} q={q}/>:<Message text={r.error??'Delivery setup is being connected. Open the synthetic project to review the delivery loop.'}/>}</Page>;
}

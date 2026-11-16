import {fixture} from '../delivery/fixture';
import {Page,PageHeader,styles} from '../ui';
import Link from 'next/link';
import {api} from '../lib/api';
import {portalApi} from './api';
import type {DeliveryData} from '../delivery/types';
import {ClientPortal} from './workspace';
export default async function Portal({searchParams}:{searchParams:Promise<Record<string,string>>}){
 const q=await searchParams;
 if(q.pilot!=='synthetic'){const r=await portalApi<DeliveryData>('?'+new URLSearchParams(q));return r.data?<ClientPortal d={r.data} q={q}/>:<Page fit viewport><PageHeader title="Client portal"/><p>{r.error}</p><Link className={styles.btn} href="/portal/login">Client sign-in</Link></Page>;}
 const authorized=await api('delivery/agent-contract');if(authorized.error)return <Page><p>{authorized.error}</p></Page>;
 return <Page fit viewport><PageHeader title="Client portal" context={['Synthetic collaboration rehearsal · no organizational client data']} actions={<Link className={styles.btn} href="/delivery?pilot=synthetic">Delivery workspace</Link>}/><ClientPortal d={{...fixture(),publication:{label:'Wholly synthetic opt-in project',lat:18.52,lng:73.85,precision:'Approximate city area'}}} q={q}/></Page>;
}

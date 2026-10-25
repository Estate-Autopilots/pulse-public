import Link from 'next/link';
import {api} from '../../lib/api';
import {Page,PageHeader,styles} from '../../ui';
import {fixture} from './fixture';
import {empty,type WorkData} from './types';
import {WorkDesk} from './workspace';
export default async function MyWork({searchParams}:{searchParams:Promise<Record<string,string>>}){const q=await searchParams;const r=q.pilot==='synthetic'?{data:fixture()}:await api<WorkData>('fair-work?'+new URLSearchParams(q));return <Page fit viewport><PageHeader title="My work" context={[r.data?.synthetic?'Synthetic workspace · no real notifications':'My desk · accepted work and growth']} actions={<><Link href="/me" className={styles.btn}>My desk</Link><Link href="/me/work?pilot=synthetic" className={styles.btn}>Try the demo</Link></>}/><WorkDesk initial={r.data??empty()} error={'error' in r?r.error:undefined}/></Page>;}

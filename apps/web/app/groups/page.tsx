import Link from 'next/link';
import { api } from '../lib/api';
import { Message,Page,PageHeader,styles } from '../ui';
import { Groups } from './workspace';
import type { GroupsData } from './types';
export default async function GroupsPage(){const r=await api<GroupsData>('groups');if(r.error)return <Message text={r.error}/>;return <Page fit><PageHeader title="Teams & Google groups" context={['Workspace directory · read-only']} actions={<Link className={styles.btn} href="/chats">Back to Chats</Link>}/>{r.data?<Groups data={r.data}/>:null}</Page>;}

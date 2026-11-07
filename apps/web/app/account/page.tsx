import {Page,PageHeader} from '../ui';
import {Security} from './security';
// EST-1398: the Google link flow returns here with ?google=<result>.
export default async function Account({searchParams}:{searchParams:Promise<{google?:string;tab?:string}>}){const {google,tab}=await searchParams;return <Page fit viewport><PageHeader title="Account / Security" context={['Your password, sessions, delivery email and Google']}/><Security google={google} tab={tab}/></Page>;}

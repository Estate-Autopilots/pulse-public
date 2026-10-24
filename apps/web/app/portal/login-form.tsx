'use client';
import {useRouter} from 'next/navigation';import {post} from '../records';import {styles} from '../ui';import {LoginForm} from '../login/form';
export function ClientLogin({change=false}:{change?:boolean}){return <LoginForm change={change} client own={change}/>;}
export function ClientSignOut(){const router=useRouter();return <button className={styles.btn} onClick={async()=>{await post('portal/auth/sign-out').catch(()=>undefined);router.push('/portal/login');router.refresh();}}>Sign out</button>;}

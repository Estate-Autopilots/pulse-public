'use client';
import {useEffect,useState} from 'react';
import {Modal} from '../records';
import {AccountTools} from './tools';
import {styles} from '../ui';
export function AuthReview(){const [data,setData]=useState<{people:{id:string;name:string;status:string}[];canManage:boolean}|null>(null),[open,setOpen]=useState(false);useEffect(()=>{void fetch('/api/v0/auth-review').then(async r=>{if(r.ok)setData(await r.json());});},[]);if(!data?.people.length)return null;return <><button className={styles.btn} onClick={()=>setOpen(true)}>{data.people.length} invitations need attention · Resend link</button>{open?<Modal title="Invitations needing attention" sub="Invited or expired links · next action: Resend link" onClose={()=>setOpen(false)}>{data.people.map(p=><div className={styles.inline} key={p.id}><span>{p.name} · {p.status}</span>{data.canManage?<AccountTools id={p.id} hasLogin={false} active={false}/>:<a href={`/people/${p.id}`}>Ask HR to resend link</a>}</div>)}</Modal>:null}</>;}

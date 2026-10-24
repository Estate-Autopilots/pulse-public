import Link from 'next/link';
import { styles } from '../ui';
export type Row = Record<string, unknown>;
export const text = (v: unknown) => v===null||v===undefined||v===''?'Unknown':typeof v==='object'?JSON.stringify(v):String(v);
export const s = (v: unknown) => v===null||v===undefined?'':String(v);
export const time = (v: unknown) => v?new Date(s(v)).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'}):'Unknown';
export function Navigation({base,page,total,query={}}:{base:string;page:number;total?:number;query?:Record<string,string>}) {
 const url=(p:number)=>`${base}?${new URLSearchParams({...query,page:String(p)})}`;
 return <div className={styles.actions} aria-label="Source pages"><Link aria-disabled={!page} className={styles.btn} href={url(Math.max(0,page-1))}>Previous</Link><span>Page {page+1}{total!==undefined?` · ${total.toLocaleString('en-IN')} records`:''}</span>{total===undefined||total>(page+1)*50?<Link className={styles.btn} href={url(page+1)}>Next</Link>:null}</div>;
}

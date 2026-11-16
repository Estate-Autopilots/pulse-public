// VISUAL-QA (D124): Role briefs show times, days, freshness and states in words, not raw ISO stamps
// ("Made 2026-11-13T11:39:24.722Z") or the API's internal state names ("Frozen evidence vintage").
import {dayTime,longDay} from '../lib/format';

export const stamp=(v:string|null|undefined)=>!v?'Not recorded':Number.isFinite(Date.parse(v))?dayTime(v):v;
export const workDay=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v)?longDay(v):v;
export const freshness=(v:string)=>v==='current'?'Up to date':v==='stale'?'Out of date':v==='unknown'?'Not known':v;
export const briefState=(v:string)=>v==='Frozen evidence vintage'?'As first sent':/withheld|revoked/i.test(v)?'Hidden: your access changed':v;

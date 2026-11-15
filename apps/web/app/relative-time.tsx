'use client';
import {useSyncExternalStore} from 'react';
import {ago,dayTime} from './lib/format';
const subscribe=(changed:()=>void)=>{const timer=setInterval(changed,10000);return()=>clearInterval(timer);};
const snapshot=()=>Math.floor(Date.now()/10000)*10000;
const serverSnapshot=()=>null;
// First client render matches the exact server date. Relative text starts after hydration.
export function RelativeTime({value}:{value:string}){
 const now=useSyncExternalStore(subscribe,snapshot,serverSnapshot);
 return <time dateTime={value} title={dayTime(value)}>{now===null?dayTime(value):ago(value,now)}</time>;
}

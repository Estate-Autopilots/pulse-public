"use client";
import {useEffect} from 'react';
import {shell} from './lib/native-shell';
import {sharedJson} from './lib/shared-get.mjs';
type Update={id:string;title:string;href:string;kind?:string;eventType?:string;readAt:string|null;pingAllowed?:boolean};
/** CALLS-V2: an incoming call rings on its own screen while this page hears calls live; the island's copy of it stayed
 *  after the call was answered ("Kedab · incoming call" over the call in progress). */
const ringsHere=()=>(window as unknown as {__pulseCalls?:{live?:boolean}}).__pulseCalls?.live===true;
/** Notifications have one home, the bell's panel (UX-NOTIFY). A new one is also announced once by Pip's island in the
 *  top bar (computers and phones), unless it belongs to the conversation already on screen. Quiet hours and Do not
 *  disturb are applied by the server (pingAllowed). */
const onScreen=(href:string)=>{try{const u=new URL(href,location.origin);return u.pathname===location.pathname&&!!u.searchParams.get('channel')&&u.searchParams.get('channel')===new URLSearchParams(location.search).get('channel');}catch{return false;}};
import {browserPingStatus} from './lib/browser-ping-state.mjs';
const IDLE_AFTER=3*60_000,IDLE_EVERY=10_000;
export function BrowserPings(){
 useEffect(()=>{
  let stopped=false,busy=false,cursor:string|null=null,page:string|null=null;const seen=new Set<string>();
  const present=(row:Update)=>{if(seen.has(row.id))return;seen.add(row.id);if(seen.size>1000)seen.delete(seen.values().next().value!);
   const href=row.href?.startsWith('/')&&!row.href.startsWith('//')?row.href:'/notifications';
   if(document.visibilityState!=='visible'||onScreen(href)||(row.eventType==='chat.call'&&ringsHere()))return;
   window.dispatchEvent(new CustomEvent('pulse:arrival',{detail:{id:row.id,title:row.title,href,kind:row.kind}}));};
  // POLISH-2 (QA-E2E P1-13): every open page asked every 2.5 s, all day. A page nobody has touched for three minutes
  // asks every 10 s instead; the next touch, key or visit asks at once and returns to 2.5 s.
  let touched=Date.now(),polled=0;
  const tick=async(force=false)=>{
   if(busy||document.visibilityState!=='visible')return;
   if(!force&&Date.now()-touched>IDLE_AFTER&&Date.now()-polled<IDLE_EVERY)return;
   busy=true;polled=Date.now();
   try{
    const r=await fetch(`/api/v0/companion/updates${cursor?`?since=${encodeURIComponent(cursor)}`:''}${page?`&page=${encodeURIComponent(page)}`:''}`,{cache:'no-store'});
    if(!r.ok)return;const state=await r.json();if(stopped)return;
    window.dispatchEvent(new CustomEvent('pulse:communications',{detail:state}));
    for(const row of state.rows as Update[])if(row.pingAllowed)present(row);
    cursor=state.cursor;page=state.page;
   }catch{/* reconnect at the same cursor */}finally{busy=false;}
  };
  const describe=(text:string)=>window.dispatchEvent(new CustomEvent('pulse:ping-status',{detail:text}));
  const enable=async()=>{
   try{
    if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))return describe('This browser does not support pings with the page closed.');
    const r=await fetch('/api/v0/companion/notification-settings',{cache:'no-store'});if(!r.ok)return;
    const {webPushKey}=await r.json();if(!webPushKey)return describe('Pulse notifies you here while it is open. Notifications with Pulse closed are not available yet.');
    if(await Notification.requestPermission()!=='granted')return describe('Notifications are blocked in this browser. Allow them in site settings.');
    const registration=await navigator.serviceWorker.register('/pulse-push.js',{scope:'/'});
    await navigator.serviceWorker.ready;
    const binary=atob(webPushKey.replace(/-/g,'+').replace(/_/g,'/'));const key=Uint8Array.from(binary,c=>c.charCodeAt(0));
    const subscription=await registration.pushManager.getSubscription()??await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
    const enrolled=await fetch('/api/v0/companion/web-push',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(subscription.toJSON())});
    describe(enrolled.ok?'Browser pings enabled, including when the page is closed.':'Browser pings could not be enabled. Try again.');
   }catch{describe('Browser pings could not be enabled. Check site notification permissions.');}
  };
  // The Pulse phone app notifies through Android/iOS itself; the browser's push and permission prompts stay out of it.
  if(!shell()){
  // Existing explicit browser permission follows the newly signed-in Pulse account.
  if('serviceWorker' in navigator&&'Notification' in window&&Notification.permission==='granted'){
    void navigator.serviceWorker.getRegistration('/pulse-push.js').then(async registration=>{
      if(!registration?.active?.scriptURL.endsWith('/pulse-push.js'))return;
      const subscription=await registration.pushManager.getSubscription();if(!subscription||stopped)return;
      const response=await fetch('/api/v0/companion/web-push',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(subscription.toJSON())});
      if(response.ok&&!stopped)describe('Browser pings enabled, including when the page is closed.');
    }).catch(()=>{});
  }
  // PERF: one read of the settings per page load, shared with the notification status (notify-status.tsx).
  void sharedJson<{webPushKey?:string|null}>('/api/v0/companion/notification-settings').then(d=>{
    if(!d||stopped)return;const webPushKey=d.webPushKey;
    const status=browserPingStatus({supported:'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window,
      webPushKey,permission:'Notification' in window?Notification.permission:undefined});
    if(status)describe(status);
  }).catch(()=>{});
  }
  const requested=()=>void enable();
  const message=(event:MessageEvent)=>{if(event.data?.type==='pulse-ping')present(event.data.row);};
  const visibility=()=>{touched=Date.now();void tick(true);};
  navigator.serviceWorker?.addEventListener('message',message);
  const now=()=>void tick(true);
  const touch=()=>{const idle=Date.now()-touched>IDLE_AFTER;touched=Date.now();if(idle)void tick(true);};
  const TOUCH=['pointerdown','pointermove','keydown','wheel','focus'] as const;
  for(const t of TOUCH)window.addEventListener(t,touch,{passive:true});
  window.addEventListener('pulse:enable-browser-pings',requested);document.addEventListener('visibilitychange',visibility);window.addEventListener('pulse:poll-now',now);
  void tick(true);const timer=window.setInterval(()=>void tick(),2500);
  return()=>{stopped=true;clearInterval(timer);for(const t of TOUCH)window.removeEventListener(t,touch);window.removeEventListener('pulse:poll-now',now);window.removeEventListener('pulse:enable-browser-pings',requested);document.removeEventListener('visibilitychange',visibility);navigator.serviceWorker?.removeEventListener('message',message);};
 },[]);
 return null;
}

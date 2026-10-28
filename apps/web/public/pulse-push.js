/* One worker for the existing Pulse inbox. No cached employee pages or message bodies. */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
// CALLS-V2: a call's notification goes when the ring is over: a missed call that arrives replaces the rings shown
// before it, and a ring older than 50 s (Pulse stops ringing at 45) is closed whenever the worker wakes.
const closeRings=async(all)=>{try{for(const n of await self.registration.getNotifications()){if(String(n.tag).startsWith('call-')&&(all||Date.now()-(n.timestamp||0)>50000))n.close();}}catch{}};
self.addEventListener('push',event=>{
 event.waitUntil((async()=>{
  await closeRings(false);
  let data;try{data=event.data.json();}catch{return;}
  // CALLS-NATIVE: the ring is over (answered on another device, declined, missed, the caller hung up): stop it here too.
  if(/^[0-9a-f-]{36}$/.test(data.stop??'')){for(const n of await self.registration.getNotifications({tag:'call-'+data.stop}))n.close();return;}
  // CALLS-NATIVE: "Test my ringing" (Settings → Devices): rings like a call, for 30 seconds.
  if(/^[0-9a-f-]{36}$/.test(data.ringTest??'')){
   const r=await fetch('/api/v0/companion/updates',{cache:'no-store'});if(!r.ok)return;if((await r.json()).person?.id!==data.personId)return;
   await self.registration.showNotification('Pulse test call',{body:'Your ringing works. Tap to open Pulse.',tag:'call-'+data.ringTest,renotify:true,requireInteraction:true,vibrate:[600,300,600,300,600],
    data:{ringTest:data.ringTest,personId:data.personId},icon:'/icons/icon-192.png',badge:'/icons/badge-96.png'});
   setTimeout(()=>void self.registration.getNotifications({tag:'call-'+data.ringTest}).then(l=>l.forEach(n=>n.close())),30000);
   return;
  }
  if(!/^[0-9a-f-]{36}$/.test(data.id??''))return;
  // Resolve with the current browser account, not the account that once owned this endpoint.
  const r=await fetch('/api/v0/companion/updates',{cache:'no-store'});
  if(!r.ok)return;const state=await r.json();
  if(state.person?.id!==data.personId)return;
  const inbox=await fetch('/api/v0/companion/inbox?id='+encodeURIComponent(data.id),{cache:'no-store'});if(!inbox.ok)return;
  const row=(await inbox.json()).rows.find(n=>n.id===data.id);
  if(!row||(row.readAt&&!row.messageId)||state.settings?.dnd||state.settings?.types?.[row.kind]===false)return;
  if(state.settings?.quiet){const p=state.settings;const at=new Intl.DateTimeFormat('en-GB',{timeZone:p.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());if(p.start===p.end||(p.start<p.end?at>=p.start&&at<p.end:at>=p.start||at<p.end))return;}
  const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  const open=clients.find(c=>c.visibilityState==='visible');
  // A test the person just asked for (Settings → Notifications) shows as a real notification even with Pulse in front.
  const test=row.eventType==='update.test';
  if(open&&!test){open.postMessage({type:'pulse-ping',row});return;}
  // CHAT-VOICE: an incoming call rings until answered, declined or over (its tag is the call's); a missed call and a
  // voice message say what they are. The caller's name is on a call, as on any phone.
  const callId=(row.href.match(/[?&]call=([0-9a-f-]{36})/)||[])[1];
  if(row.eventType==='chat.call'&&callId){
   await self.registration.showNotification(row.title,{body:'Tap to answer in Pulse',tag:'call-'+callId,renotify:true,requireInteraction:true,vibrate:[600,300,600,300,600],
    data:{id:data.id,personId:data.personId,callId},actions:[{action:'answer',title:'Answer'},{action:'decline',title:'Decline'}],icon:'/icons/icon-192.png',badge:'/icons/badge-96.png'});
   return;
  }
  if(row.eventType==='chat.missed_call')await closeRings(true);
  if(row.eventType==='chat.missed_call'||row.eventType==='chat.voice'){
   await self.registration.showNotification(row.title,{tag:data.id,data:{id:data.id,personId:data.personId},icon:'/icons/icon-192.png',badge:'/icons/badge-96.png'});
   return;
  }
  const update=row.eventType==='update.posted';
  await self.registration.showNotification(update?row.title:'Pulse',{...(update?{}:{body:test?row.title:'A new work update is ready'}),tag:data.id,
    data:{id:data.id,personId:data.personId},icon:'/icons/icon-192.png',badge:'/icons/badge-96.png'});
 })());
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 event.waitUntil((async()=>{
  const {id,personId,callId,ringTest}=event.notification.data??{};
  if(ringTest){const url=new URL('/settings?tab=devices&ringtest='+ringTest,self.location.origin).href;const w=await self.clients.matchAll({type:'window',includeUncontrolled:true});if(w.length){await w[0].navigate(url);await w[0].focus();}else await self.clients.openWindow(url);return;}
  // CHAT-VOICE: Decline from the notification itself; Answer opens the call and answers it.
  if(callId&&event.action==='decline'){await fetch('/api/v0/calls/'+callId+'/decline',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).catch(()=>{});return;}
  const r=await fetch('/api/v0/companion/updates',{cache:'no-store'});if(!r.ok)return self.clients.openWindow('/login');
  if((await r.json()).person?.id!==personId)return self.clients.openWindow('/account');
  const inbox=await fetch('/api/v0/companion/inbox?id='+encodeURIComponent(id),{cache:'no-store'});if(!inbox.ok)return;
  const row=(await inbox.json()).rows.find(n=>n.id===id);if(!row)return;
  const url=new URL(row.href,self.location.origin);if(url.origin!==self.location.origin)return;
  if(callId)url.searchParams.set('answer','1');
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  if(windows.length){await windows[0].navigate(url.href);await windows[0].focus();}
  else await self.clients.openWindow(url.href);
 })());
});

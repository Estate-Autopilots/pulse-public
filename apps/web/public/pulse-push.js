/* One worker for the existing Pulse inbox. No cached employee pages or message bodies. */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
 event.waitUntil((async()=>{
  let data;try{data=event.data.json();}catch{return;}
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
  const {id,personId,callId}=event.notification.data??{};
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

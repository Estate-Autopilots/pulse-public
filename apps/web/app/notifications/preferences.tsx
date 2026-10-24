'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {post} from '../records';
import {styles} from '../ui';
import css from './notifications.module.css';
import {MuteKinds} from './mute';

export type NotificationSettings={dnd:boolean;quiet:boolean;start:string;end:string;timezone:string;channels:Record<string,boolean>;nightShift:boolean;reminders:{done:boolean};snoozedUntil:string|null};
const channels=[['local','While Pulse is open'],['web','Browser push'],['native','Phone push'],['telegram','Verified personal Telegram'],['email','Existing HR email copies']] as const;
export function NotificationPreferences({initial}:{initial:NotificationSettings}){
 const [settings,setSettings]=useState(initial),[busy,setBusy]=useState(false),[message,setMessage]=useState('');const router=useRouter();
 // The notification panel's settings link lands here with the preferences open.
 const box=useRef<HTMLDetailsElement>(null);useEffect(()=>{if(location.hash==='#ping-settings'&&box.current)box.current.open=true;},[]);
 async function save(event:FormEvent){event.preventDefault();setBusy(true);setMessage('');try{await post('companion/notification-settings',settings);setMessage('Notification preferences saved.');router.refresh();}catch(error){setMessage(error instanceof Error?error.message:'Could not save preferences');}finally{setBusy(false);}}
 return <details ref={box} id="ping-settings" className={`${styles.panel} ${css.preferences}`}><summary>Notification preferences</summary>
  <form onSubmit={save} className={css.preferencesForm}>
   <fieldset><legend>Your channels</legend>{channels.map(([key,label])=><label key={key}><input type="checkbox" checked={settings.channels[key]!==false} onChange={event=>setSettings({...settings,channels:{...settings.channels,[key]:event.target.checked}})}/>{label}</label>)}</fieldset>
   <p>Channels need their own permissions and connection. Email copies keep the existing HR sending gate.</p>
   <label><input type="checkbox" checked={settings.dnd} onChange={event=>setSettings({...settings,dnd:event.target.checked})}/>Do not disturb</label>
   <label><input type="checkbox" checked={settings.quiet} onChange={event=>setSettings({...settings,quiet:event.target.checked})}/>Quiet hours</label>
   <div className={css.hours}><label>Start<input type="time" value={settings.start} onChange={event=>setSettings({...settings,start:event.target.value})}/></label><label>End<input type="time" value={settings.end} onChange={event=>setSettings({...settings,end:event.target.value})}/></label><label>Time zone<input value={settings.timezone} required maxLength={80} onChange={event=>setSettings({...settings,timezone:event.target.value})}/></label></div>
   <label><input type="checkbox" checked={settings.nightShift} onChange={event=>setSettings({...settings,nightShift:event.target.checked})}/>Allow pings during my active HR-approved night shift</label>
   <label><input type="checkbox" checked={settings.reminders.done} onChange={event=>setSettings({...settings,reminders:{done:event.target.checked}})}/>“Done for the day?” reminder when HR activates approved timing</label>
   <label>Pause pings<select value={settings.snoozedUntil?'paused':'off'} onChange={event=>setSettings({...settings,snoozedUntil:event.target.value==='off'?null:new Date(Date.now()+3600000).toISOString()})}><option value="off">No pause</option><option value="paused">Pause for one hour</option></select></label>
   <p>Check-in reminders follow your shift once HR turns them on, at most once a day. Pulse checks you out when you leave and asks only when it cannot tell.</p>
   <div><button className={styles.btn} disabled={busy}>{busy?'Saving…':'Save preferences'}</button></div>
   {message?<p role="status">{message}</p>:null}
  </form>
  <MuteKinds/>
 </details>;
}

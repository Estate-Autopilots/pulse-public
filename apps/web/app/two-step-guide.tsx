'use client';
// TWO-STEP-GUIDE (owner, 30 Oct 2026: "a compulsory setup, most smooth, in a floating window, for all who need it, me
// included ... what needs doing must already be prompted"): whoever their organisation asks for two-step (admin, HR,
// leadership, the owner too) gets this window over the page they opened. TWO-STEP-FACTORS: they choose a passkey
// (recommended: the device's fingerprint, face or screen lock), an authenticator app (a QR code; the key only behind
// "Can't scan?") or e-mailed codes; then their password once; then backup codes to download or copy; done, on the same
// page. "Later" only waits: the window opens again on the next page. Account / Security uses the same steps inline.
import {useEffect,useRef,useState,useSyncExternalStore,type FormEvent} from 'react';
import {usePathname,useRouter} from 'next/navigation';
import {post} from './records';
import {styles} from './ui';
import {Qr} from './connections/qr';
import {PasswordField} from './login/password-field';
import {backupText,groupKey,otpDigits} from './lib/two-step.mjs';
import {addPasskey,passkeyMessage,passkeysSupported} from './lib/passkeys';
import css from './two-step-guide.module.css';

type Step='choose'|'start'|'scan'|'codes'|'done';
type Method='passkey'|'authenticator'|'email';
type Factors={authenticator?:boolean;emailCodes?:boolean;delivery?:boolean;mailReady?:boolean;passkeys?:{id:string;name:string;createdAt:string;lastUsedAt:string|null}[]};
const MISMATCH='Enter a fresh authenticator code';
const dotOf=(s:Step)=>s==='choose'||s==='start'?0:s==='scan'?1:2;
async function readFactors():Promise<Factors|null>{try{const r=await fetch('/api/v0/auth/factors',{cache:'no-store'});return r.ok?await r.json() as Factors:null;}catch{return null;}}
const noSubscription=()=>()=>{};
const anyFactor=(f:Factors|null)=>!!f&&(!!f.authenticator||!!f.emailCodes||(f.passkeys?.length??0)>0);

/** The steps: choose a way, password once, the way itself, backup codes. `prefix` is the account API ('auth', or
 *  'portal/auth' for client accounts, which keep the authenticator only). */
export function TwoStepSetup({org,prefix='auth',inline=false,onDone,onLater}:{org?:string;prefix?:string;inline?:boolean;onDone:()=>void;onLater?:()=>void}){
 const box=useRef<HTMLDivElement>(null),staff=prefix==='auth';
 const [step,setStep]=useState<Step>(staff?'choose':'start'),[picked,setMethod]=useState<Method>(staff?'passkey':'authenticator'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [factors,setFactors]=useState<Factors|null>(null),[password,setPassword]=useState(''),supported=useSyncExternalStore(noSubscription,passkeysSupported,()=>true);
 const method:Method=picked==='passkey'&&!supported?'authenticator':picked;
 const [key,setKey]=useState(''),[uri,setUri]=useState(''),[showKey,setShowKey]=useState(false),[code,setCode]=useState(''),[codes,setCodes]=useState<string[]>([]),[saved,setSaved]=useState(false),[copied,setCopied]=useState(''),[notice,setNotice]=useState('');
 useEffect(()=>{if(staff)void readFactors().then(setFactors);},[staff]);
 useEffect(()=>{if(!inline)box.current?.querySelector<HTMLElement>('input,button')?.focus();},[step,inline]);
 const mailOk=!!factors?.mailReady&&!!factors?.delivery;
 const finished=(c?:string[])=>{setPassword('');if(c?.length){setCodes(c);setStep('codes');}else setStep('done');};
 async function start(e:FormEvent){e.preventDefault();setBusy(true);setError('');
  try{
   if(method==='passkey')finished((await addPasskey(password)).recoveryCodes);
   else if(method==='email')finished((await post<{recoveryCodes?:string[]}>(prefix+'/account',{action:'email-factor-on',current:password})).recoveryCodes);
   else{const r=await post<{setupKey?:string;uri?:string}>(prefix+'/account',{action:'totp-start',current:password});setKey(r.setupKey??'');setUri(r.uri??'');setStep('scan');}
  }catch(x){setError(method==='passkey'?passkeyMessage(x,'The passkey wasn’t saved. Try again, or choose another way.'):(x as Error).message);}finally{setBusy(false);}}
 // A key waits up to 24 hours, so a second try reuses the phone entry; "Start over" always makes a new one.
 async function restart(){setBusy(true);setError('');
  try{const r=await post<{setupKey?:string;uri?:string}>(prefix+'/account',{action:'totp-start',current:password,fresh:true});setKey(r.setupKey??'');setUri(r.uri??'');setCode('');setShowKey(false);setNotice('New key made. Delete the older Pulse entry in your app, then scan this code.');}
  catch(x){setError((x as Error).message);}finally{setBusy(false);}}
 async function enable(e:FormEvent){e.preventDefault();const digits=otpDigits(code);if(!digits){setError('Type the 6 digits your authenticator app shows now.');return;}
  setBusy(true);setError('');
  try{finished((await post<{recoveryCodes?:string[]}>(prefix+'/account',{action:'totp-enable',current:password,code:digits})).recoveryCodes);}
  catch(x){const m=(x as Error).message;setError(m===MISMATCH?'That code didn’t match. Use the Pulse entry you just added (delete older Pulse entries in the app), type the code it shows now, and check the phone’s clock is set to automatic.':m);setCode('');}
  finally{setBusy(false);}}
 async function copy(text:string,what:string){try{await navigator.clipboard.writeText(text);setCopied(what);}catch{setCopied('');}}
 function download(){const url=URL.createObjectURL(new Blob([backupText(codes,org??'Pulse')],{type:'text/plain'})),a=document.createElement('a');a.href=url;a.download='pulse-backup-codes.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setSaved(true);}
 const titles:Record<Step,string>={choose:anyFactor(factors)?'Add another way to sign in':'Turn on two-step verification',start:method==='passkey'?'Add a passkey':method==='email'?'Get codes by email':'Use an authenticator app',
  scan:'Scan with your authenticator app',codes:'Save your backup codes',done:'Two-step is on'};
 const ways:{m:Method;title:string;text:string;off?:string}[]=[
  {m:'passkey',title:'Use a passkey',text:'Your fingerprint, face or screen lock. Saved in Windows Hello, Google Password Manager or iCloud Keychain, or on your phone with a QR code.',off:supported?undefined:'This browser can’t save passkeys. Try Chrome, Edge or Safari.'},
  {m:'authenticator',title:'Use an authenticator app',text:'A 6-digit code from Google Authenticator or Microsoft Authenticator.'},
  {m:'email',title:'Email me a code',text:'A code sent to your delivery email each time you sign in.',off:!factors?undefined:!factors.mailReady?'Your organisation’s email isn’t set up in Pulse yet.':!factors.delivery?'Add a delivery email in Account / Security first.':factors.emailCodes?'Already on.':undefined}];
 return <div ref={box} className={css.setup}>
  <ol className={css.dots} aria-label={`Step ${dotOf(step)+1} of 3`}>{[0,1,2].map(i=><li key={i} data-done={i<dotOf(step)||undefined} data-now={i===dotOf(step)||undefined}/>)}</ol>
  <h2 id="two-step-title" className={css.title}>{titles[step]}</h2>
  {step==='choose'?<div className={css.form}>
   <p>{org&&!inline?`${org} asks admins, HR and leadership to confirm it’s them with a second step when they sign in.`:'Confirm it’s you with a second step when you sign in.'} Choose the easiest for you; it takes about 2 minutes{inline?'':', and you stay on this page'}.</p>
   <div className={css.ways} role="radiogroup" aria-label="Ways to confirm it’s you">{ways.map((w,i)=><button key={w.m} type="button" role="radio" aria-checked={method===w.m} disabled={!!w.off} className={css.way} data-on={method===w.m||undefined} onClick={()=>setMethod(w.m)}>
    <span className={css.wayTitle}>{w.title}{i===0?<span className={css.chip}>Recommended</span>:null}</span><span className={css.wayText}>{w.off??w.text}</span></button>)}</div>
   <div className={css.actions}><button type="button" className={styles.btnPrimary} disabled={ways.find(w=>w.m===method)?.off!==undefined} onClick={()=>{setError('');setStep('start');}}>Continue</button>{onLater?<button type="button" className={css.quiet} onClick={onLater}>Later</button>:null}</div>
  </div>:null}
  {step==='start'?<form className={css.form} onSubmit={start}>
   <p>{method==='passkey'?'Enter your Pulse password, then your device asks for your fingerprint, face or screen lock. To use your phone instead, choose “Use a phone or tablet” in that window and scan its QR code.'
    :method==='email'?'Enter your Pulse password. From then on, each sign-in sends a 6-digit code to your delivery email.'
    :`${staff?'':'Sign in with a code from your phone as well as your password. '}Enter your Pulse password, then scan a QR code with your authenticator app.`}</p>
   <PasswordField label="Your Pulse password" name="current" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/>
   <div className={css.actions}><button className={styles.btnPrimary} disabled={busy||!password}>{method==='passkey'?'Add passkey':method==='email'?'Turn on email codes':'Continue'}</button>
    {staff?<button type="button" className={css.quiet} onClick={()=>{setError('');setStep('choose');}}>Back</button>:onLater?<button type="button" className={css.quiet} onClick={onLater}>Later</button>:null}</div>
  </form>:null}
  {step==='scan'?<form className={css.form} onSubmit={enable}>
   <p>In <b>Google Authenticator</b> or <b>Microsoft Authenticator</b>, tap <b>+</b> and scan this code. Tried before? Delete the older Pulse entries first.</p>
   <div className={css.scan}>{uri?<Qr text={uri} label="QR code for your authenticator app" size={184}/>:null}
    <div className={css.alt}><a className={css.quiet} href={uri}>On this phone? Open in authenticator</a>
     <button type="button" className={css.quiet} aria-expanded={showKey} onClick={()=>setShowKey(v=>!v)}>Can’t scan?</button>
     {showKey?<><span className={css.hint}>Choose “Enter a setup key”, time-based:</span><code className={css.secret}>{groupKey(key)}</code><button type="button" className={css.quiet} onClick={()=>void copy(key,'key')}>{copied==='key'?'Key copied':'Copy key'}</button></>:null}
     <button type="button" className={css.quiet} disabled={busy} onClick={()=>void restart()}>Start over with a new key</button></div></div>
   {notice?<p role="status" className={css.hint}>{notice}</p>:null}
   <label className={css.code}><span>Then type the 6-digit code it shows</span><input name="code" value={code} onChange={e=>setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={9} placeholder="123 456" required/></label>
   <div className={css.actions}><button className={styles.btnPrimary} disabled={busy||!otpDigits(code)}>Turn on two-step</button>{onLater?<button type="button" className={css.quiet} onClick={onLater}>Later</button>:null}</div>
  </form>:null}
  {step==='codes'?<div className={css.form}>
   <p>{method==='passkey'?'Your passkey is saved.':method==='email'?'Email codes are on.':'Two-step is on.'} If you ever lose your phone or can’t get the code, each backup code signs you in once. They are shown only now.</p>
   <ul className={css.codes}>{codes.map(c=><li key={c}>{c}</li>)}</ul>
   <div className={css.actions}><button type="button" className={styles.btn} onClick={download}>Download (.txt)</button><button type="button" className={styles.btn} onClick={()=>{void copy(codes.join('\n'),'codes');setSaved(true);}}>{copied==='codes'?'Copied':'Copy'}</button></div>
   <label className={css.check}><input type="checkbox" checked={saved} onChange={e=>setSaved(e.target.checked)}/> I’ve saved my backup codes</label>
   <div className={css.actions}><button type="button" className={styles.btnPrimary} disabled={!saved} onClick={onDone}>Done</button></div>
  </div>:null}
  {step==='done'?<div className={css.form}>
   <p>{method==='passkey'?'Your passkey is saved. Next time you sign in, Pulse asks for it after your password.':method==='email'?'Email codes are on. Next time you sign in, Pulse e-mails you a code after your password.':'Two-step is on.'} Your backup codes from before still work.</p>
   <div className={css.actions}><button type="button" className={styles.btnPrimary} onClick={onDone}>Done</button></div>
  </div>:null}
  {error?<p role="alert" className={css.error}>{error}</p>:null}
 </div>;
}

/** Account / Security: the ways this person has, with remove and turn off (the password once). */
export function TwoStepFactors({onChange}:{onChange:()=>void}){
 const [factors,setFactors]=useState<Factors|null>(null),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 useEffect(()=>{void readFactors().then(setFactors);},[]);
 if(!factors||(!factors.emailCodes&&!(factors.passkeys?.length)))return null;
 async function act(b:Record<string,unknown>){setBusy(true);setMessage('');
  try{await post('auth/account',{...b,current:password});setPassword('');setFactors(await readFactors());onChange();}catch(x){setMessage((x as Error).message);}finally{setBusy(false);}}
 return <div className={css.form}>
  <ul className={css.factorList}>{factors.passkeys?.map(p=><li key={p.id}><span><b>{p.name}</b><small>Passkey · added {new Date(p.createdAt).toLocaleDateString()}{p.lastUsedAt?` · last used ${new Date(p.lastUsedAt).toLocaleDateString()}`:''}</small></span>
   <button type="button" className={css.quiet} disabled={busy||!password} onClick={()=>void act({action:'passkey-remove',id:p.id})}>Remove</button></li>)}
   {factors.emailCodes?<li><span><b>Email codes</b><small>Sent to your delivery email</small></span><button type="button" className={css.quiet} disabled={busy||!password} onClick={()=>void act({action:'email-factor-off'})}>Turn off</button></li>:null}</ul>
  <PasswordField label="Your Pulse password (to remove or turn off)" name="factor-password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/>
  {message?<p role="alert" className={css.error}>{message}</p>:null}
 </div>;
}

/** The floating window for whoever must set up two-step (/api/v0/me twoStepSetup), over every page but Account. */
export function TwoStepGuide({org}:{org:string}){
 const path=usePathname(),router=useRouter(),[waitOn,setWaitOn]=useState<string|null>(null);
 const hidden=waitOn===path||path.startsWith('/account');
 return <div className={css.backdrop} hidden={hidden}><div className={css.window} role="dialog" aria-modal="true" aria-labelledby="two-step-title">
  <TwoStepSetup org={org} onLater={()=>setWaitOn(path)} onDone={()=>{setWaitOn(path);router.refresh();}}/>
 </div></div>;
}

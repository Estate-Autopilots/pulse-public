import { chromium } from '../tests/e2e/node_modules/@playwright/test/index.mjs';
import fs from 'node:fs';
import { pipIsland } from './release-pip-island.mjs';
import { overflowOf } from './release-overflow.mjs';
import { screensPanel } from './release-screens-panel.mjs';
const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const {public:origin,port,sessions,out,environment}=input;
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const receipts=[];let errors=[];
// PROMOTE-4B: what the old Effort/Impact accept compiles to (TaskNoticeActions' dropdowns and body, its "Accepted · n
// points", the renderer of the old 1–5 "rating" card fields); the scripts the bell and /notifications load must have none.
const OLD_ACCEPT={effortLabel:/["']aria-label["']\s*:\s*["']Effort["']/g,impactLabel:/["']aria-label["']\s*:\s*["']Impact["']/g,effortOption:/\[\s*["']Effort ["']\s*,/g,
 impactOption:/\[\s*["']Impact ["']\s*,/g,body:/\{\s*effort\s*:\s*[\w$.]+\s*,\s*impact\s*:\s*[\w$.]+\s*\}/g,points:/Accepted (?:·|\\u00b7|\\xb7) \$\{[^}]{1,20}\} points/g,
 ratingField:/["']rating["']\s*===\s*[\w$]+\.type|\.type\s*===\s*["']rating["']/g};
const reviewScripts=new Set();
async function context(width,theme,role,touch=false){
 const ctx=await browser.newContext({viewport:{width,height:width<500?844:980},colorScheme:theme,...(touch?{hasTouch:true,isMobile:true}:{})});
 await ctx.route(origin+'/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/api/v0/chats/events'){await route.abort();return;}
  // A request still in flight when its context closes (a Next prefetch of a linked page) rejects with "Request context
  // disposed"; unhandled, that crashed the whole browser step (RELEASE-2, staging, 11 Oct 2026). It is aborted instead.
  // Server answers, errors included, still come back as responses and are checked by the screens below.
  try{
   const response=await route.fetch({url:`http://127.0.0.1:${port}${url.pathname}${url.search}`,headers:{...route.request().headers(),host:new URL(origin).host},maxRedirects:0,maxRetries:['GET','HEAD'].includes(route.request().method())?2:0,timeout:50000});
   await route.fulfill({response});
  }catch{await route.abort().catch(()=>{});}
 });
 if(role)await ctx.addCookies([{name:'pulse_session',value:sessions[role],domain:new URL(origin).hostname,path:'/',httpOnly:true,secure:true,sameSite:'Lax'}]);
 // RELEASE-3: the browser's one notification question (notify-status.tsx) counts as answered here, so a banner arriving
 // after load never moves a page under a click; the release proof covers the banner itself.
 await ctx.addInitScript(t=>{localStorage.setItem('pulse.theme',t);localStorage.setItem('pulse.notify.browser.asked','1');window.__pulseCspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.__pulseCspViolations.push({directive:e.violatedDirective,uri:e.blockedURI}));},theme);
 return ctx;
}
async function closeContext(ctx){await ctx.unrouteAll({behavior:'ignoreErrors'});await ctx.close();}
try{
 // EST-1796: real catalogue, synthetic leadership; navigation only, private server screenshots.
 if(environment==='staging')for(const width of [1440,390])for(const theme of ['light','dark']){
  const ctx=await context(width,theme,'leadership');
  try{
   const page=await ctx.newPage();const pageErrors=[];let writes=0;
   page.on('pageerror',()=>pageErrors.push(true));
   page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/v0/erp/')&&!['GET','HEAD'].includes(r.method()))writes++;});
   for(const [path,name,title]of [['/erp','overview','Billing'],['/erp/catalog','catalog','Catalogue'],['/erp/documents','documents','Documents'],['/erp/templates','templates','Templates'],['/erp/settings','settings','Settings']]){
    const response=await page.goto(origin+path,{waitUntil:'load'});
    if(response?.status()!==200||new URL(page.url()).pathname!==path)throw Error('Billing '+name+' HTTP/navigation failure');
    await page.locator('#main-content').getByRole('heading',{name:title,exact:true}).first().waitFor();
    await page.waitForTimeout(700);
    const unavailable=await page.locator('#main-content').evaluate((node,settings)=>{
     // These settings annotations describe disabled capabilities, not a failed data request.
     let text=node.innerText;
     if(settings)for(const help of ['Unavailable pack fields are listed below.','Unavailable fields cannot be switched on yet.','Unavailable in the composer and catalogue'])text=text.replaceAll(help,'');
     return /unavailable|could not load/i.test(text);
    },name==='settings');
    if(unavailable||pageErrors.length||writes||(await page.evaluate(()=>window.__pulseCspViolations.length))||await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2))throw Error('Billing '+name+' availability/browser/CSP/overflow/read-only check failed');
    let catalogue;
    if(name==='catalog'){
     catalogue=await page.evaluate(async()=>{
      const r=await fetch('/api/v0/erp/items',{cache:'no-store'});if(!r.ok)return null;
      const data=await r.json();if(!Array.isArray(data.items))return null;
      const packages=data.items.filter(i=>i.kind==='package'&&i.status!=='archived');
      return {packages:packages.length,renderedPackages:packages.filter(i=>document.querySelector(`[aria-controls="pkg-${i.id}"]`)).length};
     });
     if(!catalogue?.packages||catalogue.renderedPackages!==catalogue.packages)throw Error('Billing catalogue has no rendered real packages');
    }
    const screenshot=`${environment}-billing-${name}-${width}-${theme}.png`;
    await page.screenshot({path:`${out}/${screenshot}`,fullPage:true});fs.chmodSync(`${out}/${screenshot}`,0o600);
    receipts.push({screen:'billing-'+name,role:'leadership',width,theme,httpStatus:200,readOnly:true,...catalogue,screenshot,passed:true});
   }
  }finally{await closeContext(ctx);}
 }
 for(const width of [1440,390])for(const theme of ['light','dark']){
  const ctx=await context(width,theme,null);const page=await ctx.newPage();let pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  const r=await page.goto(origin+'/login',{waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:'Sign in to Pulse',exact:true}).waitFor();
  if(await page.getByRole('button',{name:/Google/}).count())throw Error('Google sign-in must be hidden in public mode');
  const headers=r.headers();for(const key of ['content-security-policy','strict-transport-security','x-frame-options','referrer-policy'])if(!headers[key])throw Error('Missing '+key);
  // CHAT-SHELL (9883eb5f): Pulse frames its own pages in the chat's side panel, so same-origin framing is allowed; nothing wider.
  const ancestors=headers['content-security-policy'].split(';').map(part=>part.trim()).find(part=>part.startsWith('frame-ancestors'));
  if(!["frame-ancestors 'none'","frame-ancestors 'self'"].includes(ancestors)||headers['content-security-policy'].includes("script-src 'self' 'unsafe-inline'"))throw Error('Unsafe CSP');
  if(!['DENY','SAMEORIGIN'].includes(headers['x-frame-options'].trim().toUpperCase()))throw Error('Unsafe X-Frame-Options');
  // The visible fields: while React streams the page, a copy waits in a hidden container for a moment (RELEASE-3, staging).
  await page.locator('input[name=username]:visible').fill(input.username);await page.locator('input[type=password]:visible').fill(input.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.waitForURL(origin+'/dashboard');
  await page.getByRole('heading',{name:/Your|Dashboard|Good|Today|My|Week/}).first().waitFor({timeout:15000}).catch(()=>{});
  const me=await page.evaluate(async()=>{const r=await fetch('/api/v0/me');return {status:r.status,data:await r.json()};});
  if(me.status!==200||me.data.role!=='person')throw Error('Mobile/desktop password form did not establish the staff session');
  // v0.3.66: an overflow names what sticks out (layout facts only, release-overflow.mjs) and keeps its screenshot.
  const overflow=await overflowOf(page);
  if(overflow){fs.writeFileSync(`${out}/${environment}-login-overflow-${width}-${theme}.json`,JSON.stringify(overflow,null,1));await page.screenshot({path:`${out}/${environment}-login-overflow-${width}-${theme}.png`,fullPage:true});
   throw Error('Login overflow: '+overflow.wide.slice(0,4).map(w=>`${w.tag}.${w.cls.split(' ')[0]}@${w.right}`).join(', '));}
  if(pageErrors.length)throw Error('Login browser error');
  await page.screenshot({path:`${out}/${environment}-staff-${width}-${theme}.png`,fullPage:true});
  receipts.push({screen:'login',width,theme,passed:true});await closeContext(ctx);
  const staff=await context(width,theme,'admin');const view=await staff.newPage();const resourceErrors=[];view.on('console',m=>{if(m.type()==='error')resourceErrors.push(m.text().slice(0,250));});view.on('requestfailed',r=>resourceErrors.push(new URL(r.url()).host+' '+r.failure()?.errorText));pageErrors=[];view.on('pageerror',error=>pageErrors.push(error.message));
  // RELEASE-4: Work (TASKS-4A's views, TASKS-4B's review queue), read only; the validation admin has no tasks of its own.
  // /money is the legacy alias of /finance: under the root loading.tsx its page-level redirect runs after the shell
  // streamed, so the browser moves on after load and a check met a destroyed page (EST-2664). Visit /finance itself.
  for(const [path,name]of [['/dashboard','dashboard'],['/people','people'],['/tasks','work'],['/tasks?view=reviews','work-reviews'],['/chats','chats'],['/finance','money'],['/map','map'],['/settings?tab=sign-in','sign-in-settings'],['/dashboard?tab=research','research-dashboard'],['/leadership?tab=growth','research-growth'],['/leadership?tab=outcomes','research-outcomes'],['/leadership?tab=pipeline','research-pipeline'],['/clients?tab=renewals','research-renewals'],['/settings?tab=data-health','research-data-health'],['/finance?tab=ad-spend','research-money-denial']]){
   try{
   const response=await view.goto(origin+path,{waitUntil:'load'});await view.waitForTimeout(name==='map'?2000:700);
   if(name==='map'){await view.getByText('Opening the map…',{exact:true}).waitFor({state:'hidden',timeout:30000});await view.waitForTimeout(2000);if((await view.locator('[aria-label="Pulse Map workspace"]').getByRole('alert').allTextContents()).some(t=>t.trim()))throw Error('Map did not finish loading: '+(await view.locator('[aria-label="Pulse Map workspace"]').getByRole('alert').allTextContents()).join(' ')+' '+JSON.stringify(await view.evaluate(()=>window.__pulseCspViolations))+' '+resourceErrors.slice(-5).join('; '));}
   if((await view.evaluate(()=>window.__pulseCspViolations)).length)throw Error(name+' CSP violation');
   if(response.status()!==200)throw Error(name+' HTTP '+response.status());
   if(await view.getByText(/temporarily unavailable|could not load|data service is unavailable/i).count())throw Error(name+' unavailable');
   if(pageErrors.length){errors.push(...pageErrors);throw Error(name+' browser error: '+pageErrors[0].slice(0,100));}
   if(await view.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2))throw Error(name+' overflow '+width);
   if(name==='money'||name==='research-money-denial'){
    // Metadata-only test admin has no amount grant. No restricted numbers leave the browser.
    if(await view.getByText(/[₹$€][\s\d]/).count())throw Error('Money screenshot contains amounts');
   }
   if(name==='chats')await view.addStyleTag({content:'[id^=message-] [class*=body], [id^=message-] [class*=attachments], [class*=sideFoot] [role=status], [class*=sideFoot] [class*=dot] { visibility:hidden!important; }'});
   if(name==='people')await view.evaluate(ids=>{for(const id of Object.values(ids)){const link=document.querySelector(`a[href="/people/${id}"]`);link?.closest('tr')?.remove();}},input.people);
   if(['dashboard','people','work','chats','money','map'].includes(name))await view.screenshot({path:`${out}/${environment}-${name}-${width}-${theme}.png`,fullPage:true});
   receipts.push({screen:name,width,theme,passed:true});
   }catch(error){throw new Error(`${name}: ${error instanceof Error?error.message:String(error)}`,{cause:error});}
  }
  if(environment==='staging'&&input.review){
   // PROMOTE-4B: finished work waits for the synthetic admin. The bell's card and "All notifications" (/notifications)
   // both offer the one quality rating, never Effort/Impact; the last pass accepts it from /notifications.
   const last=width===390&&theme==='dark';
   const loaded=r=>{const u=new URL(r.url());if(/^\/_next\/static\/.+\.js$/.test(u.pathname))reviewScripts.add(u.pathname);};view.on('response',loaded);
   await view.goto(origin+'/tasks',{waitUntil:'load'});
   await view.getByRole('button',{name:/^Notifications/}).first().click();
   const panel=view.locator('#pulse-notices');await panel.waitFor();
   const card=panel.locator('[data-card]').filter({hasText:input.review.title}).first();
   await card.getByRole('radiogroup',{name:'How was the work?'}).waitFor({timeout:20000});
   if(await card.locator('select').count()||/\b(Effort|Impact)\b/.test(await card.innerText()))throw Error('review: the bell offers Effort/Impact');
   await panel.screenshot({path:`${out}/${environment}-review-bell-${width}-${theme}.png`});
   await panel.getByRole('link',{name:'All notifications'}).click();
   await view.waitForURL(origin+'/notifications');
   const row=view.locator('#main-content li').filter({hasText:'Ready to accept: '+input.review.title}).first();
   const rating=row.getByRole('radiogroup',{name:'How was the work?'});await rating.waitFor({timeout:20000});
   for(const level of ['Great','Good','Needs work'])if(!await rating.getByRole('radio',{name:level}).count())throw Error('review: /notifications rating lacks '+level);
   if(await row.locator('select').count()||/\b(Effort|Impact)\b/.test(await view.locator('#main-content').innerText()))throw Error('review: /notifications offers Effort/Impact');
   if(await view.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2))throw Error('review: /notifications overflow '+width);
   if(pageErrors.length){errors.push(...pageErrors);throw Error('review browser error: '+pageErrors[0].slice(0,100));}
   await row.screenshot({path:`${out}/${environment}-review-notifications-${width}-${theme}.png`});
   let sent=null;
   if(last){
    await rating.getByRole('radio',{name:'Good'}).click();
    const posted=view.waitForResponse(r=>r.url().endsWith(`/api/v0/tasks/${input.review.taskId}/accept`)&&r.request().method()==='POST',{timeout:30000});
    await row.getByRole('button',{name:'Accept',exact:true}).click();
    const response=await posted;sent=JSON.parse(response.request().postData()||'{}');
    if(response.status()!==200||sent.quality!=='good'||'effort' in sent||'impact' in sent)throw Error('review: accept did not send the rating');
    await row.getByText('Accepted',{exact:true}).waitFor();
   }
   view.off('response',loaded);
   receipts.push({screen:'review-rating',width,theme,syntheticOnly:true,bell:true,notificationsPage:true,effortImpact:false,accepted:last,sent:sent?Object.keys(sent).sort():null,passed:true});
   if(last){
    // Every script those pages loaded at any width or theme, read from this build and scanned; the list (with hashes) is
    // the receipt the post-release check compares with production's files.
    const crypto=await import('node:crypto');const files=[];const hits=[];
    for(const path of [...reviewScripts].sort()){
     const r=await staff.request.get(`http://127.0.0.1:${port}${path}`,{headers:{host:new URL(origin).host}});const body=await r.body();
     if(r.status()!==200)throw Error('review: script '+path+' HTTP '+r.status());
     files.push({path,sha256:crypto.createHash('sha256').update(body).digest('hex')});
     const text=body.toString('utf8');for(const [marker,rx] of Object.entries(OLD_ACCEPT)){const n=(text.match(rx)||[]).length;if(n)hits.push({path,marker,n});}
    }
    fs.writeFileSync(`${out}/${environment}-review-scripts.json`,JSON.stringify({files,hits},null,1));
    if(!files.length||hits.length)throw Error('review: the old accept is in the scripts of the bell and /notifications: '+JSON.stringify(hits).slice(0,300));
    receipts.push({screen:'review-bundle',scripts:files.length,oldAccept:0,passed:true});
   }
  }
  if(environment==='staging'){
   await view.goto(origin+'/people/'+input.people.person,{waitUntil:'load'});
   await view.getByRole('button',{name:'Account access',exact:true}).first().click();
   const drawer=view.getByRole('dialog',{name:'Account access',exact:true});
   await drawer.getByLabel('Work email',{exact:true}).waitFor();
   await drawer.getByLabel('Work email',{exact:true}).fill('invalid');
   await drawer.getByRole('button',{name:'Save work email'}).click();
   await drawer.getByRole('alert').filter({hasText:'Enter a valid email address.'}).waitFor();
   await drawer.getByLabel('Work email',{exact:true}).fill(`r17-work-${width}-${theme}-${input.people.person}@example.test`);
   await drawer.getByRole('button',{name:'Save work email'}).click();
   await drawer.getByRole('status').filter({hasText:'Work identity saved. No invitation sent.'}).waitFor();
   await drawer.getByLabel('Delivery address',{exact:true}).fill(`r17-delivery-${width}-${theme}-${input.people.person}@example.test`);
   await drawer.getByRole('button',{name:'Save delivery email'}).click();
   await drawer.getByRole('status').filter({hasText:'Address saved, unverified.'}).waitFor();
   await drawer.getByRole('button',{name:'Send confirmation link',exact:true}).click();
   await drawer.getByRole('alert').filter({hasText:'confirmation email could not be delivered'}).waitFor();
   const fit=await drawer.evaluate(d=>{const scroll=d.querySelector('[data-drawer-body], [class*="drawerScroll"]');let clipped=0;for(const el of d.querySelectorAll('button,input')){el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect(),s=scroll.getBoundingClientRect();if(r.left<0||r.right>innerWidth+1||scroll.contains(el)&&(r.top<s.top-1||r.bottom>s.bottom+1))clipped++;}scroll.scrollTop=0;return {clipped,overflow:document.documentElement.scrollWidth>innerWidth+2};});
   if(fit.clipped||fit.overflow)throw Error('Account drawer clipped controls');
   await drawer.screenshot({path:`${out}/${environment}-account-access-${width}-${theme}.png`});
   await view.keyboard.press('Escape');
   if(await drawer.count())throw Error('Account drawer did not close');
   receipts.push({screen:'account-access',width,theme,syntheticOnly:true,emailsSent:0,invalidAddress:true,inlineSave:true,mailGateError:true,...fit,passed:true});
  }
  if(environment==='staging'){
   const setup=await context(width,theme,'person');const guide=await setup.newPage();const setupErrors=[];guide.on('pageerror',e=>setupErrors.push(e.message));
   await guide.goto(origin+'/settings?tab=devices&section=Connection%20%26%20setup',{waitUntil:'load'});
   const checklist=guide.getByRole('article',{name:'Connection and setup checklist'});await checklist.waitFor();
   const copy=await checklist.innerText();
   if(!copy.includes('Force quit')||!copy.includes('three hours')||!copy.includes('seven-day metadata')||!copy.includes('Permission denial'))throw Error('Mobile setup limits missing');
   await checklist.getByRole('link',{name:'Open My desk · manual check-in',exact:true}).waitFor();
   if(await guide.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2))throw Error('Mobile setup overflow');
   if(setupErrors.length)throw Error('Mobile setup browser error');
   await checklist.screenshot({path:`${out}/${environment}-mobile-setup-${width}-${theme}.png`});
   receipts.push({screen:'mobile-connection-setup',width,theme,syntheticOnly:true,permissionRequests:0,attendanceWrites:0,passed:true});await closeContext(setup);
  }
  if(environment==='staging'){
   const self=await context(width,theme,'person');const notices=await self.newPage();const noticeErrors=[];notices.on('pageerror',e=>noticeErrors.push(e.message));
   await notices.goto(origin+'/notifications',{waitUntil:'load'});
   await notices.locator('#main-content summary').filter({hasText:/^Notification preferences$/}).click();
   await notices.getByRole('checkbox',{name:'Do not disturb',exact:true}).waitFor();
   await notices.getByRole('checkbox',{name:'Allow pings during my active HR-approved night shift',exact:true}).waitFor();
   // By role, which skips the hidden copy React briefly keeps while it streams the page (a label match found both at 390 px; RELEASE-4).
   await notices.getByRole('textbox',{name:'Time zone',exact:true}).waitFor();
   await notices.getByRole('button',{name:'Save preferences',exact:true}).waitFor();
   if(await notices.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2))throw Error('Notification preferences overflow');
   if(noticeErrors.length)throw Error('Notification preferences browser error');
   await notices.screenshot({path:`${out}/${environment}-notification-preferences-${width}-${theme}.png`});
   receipts.push({screen:'notification-preferences',width,theme,syntheticOnly:true,preferenceWrites:0,emailsSent:0,passed:true});await closeContext(self);
  }
  if(environment==='staging'){
   const self=await context(width,theme,'person');const attendance=await self.newPage();const attendanceErrors=[];attendance.on('pageerror',e=>attendanceErrors.push(e.message));
   await attendance.goto(origin+'/me?tab=attendance&section=Your%20month',{waitUntil:'load'});
   const gate=await attendance.evaluate(async()=>{const r=await fetch('/api/v0/hr/self');const d=await r.json();return {status:r.status,enabled:d.attendanceEnabled};});
   if(gate.status!==200)throw Error('Attendance policy unavailable');
   if(gate.enabled!==true){
    const main=attendance.locator('#main-content');
    await main.getByText('Attendance is off for your organisation',{exact:true}).waitFor();
    await main.getByText('Pulse is not recording check-ins. Leave and the other HR tools work as usual.',{exact:true}).waitFor();
    if(await main.locator('[data-attendance-statistics], [data-attendance-reconciliation]').count())throw Error('Disabled attendance exposes statistics or reconciliation controls');
    if(await main.getByRole('button',{name:/^(Check in|Check out|Break|Take a break|Request a correction)$/}).count())throw Error('Disabled attendance exposes punch or correction actions');
    if(await attendance.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2))throw Error('Attendance off notice overflow');
    await attendance.screenshot({path:`${out}/${environment}-attendance-off-${width}-${theme}.png`});
    await attendance.goto(origin+'/me?tab=leave',{waitUntil:'load'});
    await main.getByRole('heading',{name:/^Leave balances/}).waitFor();
    receipts.push({screen:'attendance-off',width,theme,syntheticOnly:true,attendanceEnabled:false,noAttendanceActions:true,leaveAvailable:true,passed:true});
   }else{
   const stats=attendance.locator('[data-attendance-statistics]').first();await stats.waitFor();
    // The counting details are one tap away ("How this is counted"); open them before reading the labels.
    await stats.locator('details').evaluateAll(all=>all.forEach(d=>{d.open=true;}));const content=await stats.innerText();
   if(!content.includes('0 eligible days / 0 recorded')||!content.includes('Coverage unknown')||!content.includes('flagged sessions')||!content.includes('Provisional filter'))throw Error('Attendance sample/threshold labels missing');
   if(await attendance.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2))throw Error('Attendance statistics overflow');
   await stats.screenshot({path:`${out}/${environment}-attendance-statistics-${width}-${theme}.png`});
   await attendance.goto(origin+'/me?tab=attendance&section=Needs%20checking%20%26%20baseline',{waitUntil:'load'});
   const reconciliation=attendance.locator('#main-content [data-attendance-reconciliation]:visible').first();await reconciliation.waitFor();const reconciliationText=await reconciliation.innerText();
   if(!reconciliationText.includes('Automatic closure is off')||!reconciliationText.includes('Current 28-day baseline')||!reconciliationText.includes('Historical monthly reports')||!reconciliationText.includes('Minimum 10 days'))throw Error('Reconciliation policy/baseline gates missing');
   await reconciliation.screenshot({path:`${out}/${environment}-attendance-reconciliation-${width}-${theme}.png`});
   receipts.push({screen:'attendance-reconciliation',width,theme,syntheticOnly:true,automaticClosureEnabled:false,historicalMonthlySeparate:true,minimumTenDays:true,passed:true});
   await attendance.goto(origin+'/me?tab=attendance&section=Your%20month',{waitUntil:'load'});
   await attendance.getByRole('button',{name:'Request a correction',exact:true}).first().click();await attendance.getByRole('dialog',{name:'Request an attendance correction'}).waitFor();
   if(attendanceErrors.length)throw Error('Attendance browser errors');
   receipts.push({screen:'attendance-statistics',width,theme,syntheticOnly:true,emptyIsUnknown:true,provisional:true,correctionDialog:true,originalPunchesUnmodified:true,passed:true});
   }
   if(attendanceErrors.length)throw Error('Attendance browser errors');
   await closeContext(self);
  }
  await closeContext(staff);
 }
 // RELEASE-2: Pip's island 50 times in a row, signed in as the synthetic admin (tools/release-pip-island.mjs).
 if(environment==='staging')for(const width of [1440,390])receipts.push(await pipIsland({newContext:touch=>context(width,'light','admin',touch),closeContext,origin,width,out,environment}));
 // EST-1983: Settings → Modules → Screens and menu and the /hidden notice, read only (tools/release-screens-panel.mjs).
 if(environment==='staging')for(const width of [1440,390])for(const theme of ['light','dark'])receipts.push(await screensPanel({newContext:role=>context(width,theme,role),closeContext,origin,width,theme,out,environment}));
 if(environment==='staging'){
  // RELEASE-2: read-only readiness the release report quotes (booleans only, never a key): browser push is advertised
  // (this server's public and private push keys match) and the document keyring is present (ID files can be accepted).
  const ctx=await context(1440,'light','person');const page=await ctx.newPage();await page.goto(origin+'/me',{waitUntil:'load'});
  const ready=await page.evaluate(async()=>{const a=await fetch('/api/v0/companion/notification-settings'),b=await fetch('/api/v0/onboarding');return {webPush:a.ok?!!(await a.json()).webPushKey:null,filesReady:b.ok?(await b.json()).filesReady===true:null};});
  receipts.push({screen:'readiness',syntheticOnly:true,...ready,passed:true});await closeContext(ctx);
 }
 if(environment==='staging'){
  const week='2026-W40';const ctx=await context(1440,'light','admin');const page=await ctx.newPage();
  const response=await page.goto(`${origin}/people?tab=tracking&view=accounts&week=${week}`,{waitUntil:'domcontentloaded'});
  if(response?.status()!==200)throw Error('Editors account table HTTP '+response?.status());
  const table=page.getByRole('table',{name:'Uploader accounts and weekly targets'});await table.waitFor();
  const {verifiedAccountPath,...team}=await page.evaluate(async week=>{
   const fail=()=>{throw Error('Editors team table did not match its weekly API')};
   const response=await fetch('/api/v0/editors?week='+encodeURIComponent(week),{cache:'no-store'});
   if(!response.ok)fail();const list=await response.json();
   if(list.period?.week!==week||!Array.isArray(list.accounts))fail();
   const table=document.querySelector('table[aria-label="Uploader accounts and weekly targets"]');if(!table)fail();
   const rows=[...table.tBodies[0].rows];
   const number=text=>{const cleaned=String(text).trim().replaceAll(',','');return /^\d+$/.test(cleaned)?Number(cleaned):null;};
   const format=value=>new Intl.NumberFormat('en-IN').format(value);
   let rowsCompared=0,rowsMatched=0,typesCompared=0,typesMatched=0,deliveredTotal=0,targetTotal=0,targetRows=0,gapTotal=0,gapRows=0,verifiedAccountPath=null;
   for(const account of list.accounts){
    const row=rows.find(candidate=>candidate.cells[0]?.textContent.trim()===account.account);if(!row)fail();
    const cells=[...row.cells].map(cell=>cell.textContent.trim());rowsCompared++;
    if(number(cells[2])!==account.thisWeek||number(cells[4])!==account.thisWeek)fail();
    rowsMatched++;deliveredTotal+=account.thisWeek;
    if(account.identityVerified===true&&account.sharedLogin===false&&account.holder_person_id){
     if(!verifiedAccountPath)verifiedAccountPath='/people/accounts/'+encodeURIComponent(account.account);
     const detailResponse=await fetch('/api/v1/editors/'+encodeURIComponent(account.holder_person_id)+'/week?week='+encodeURIComponent(week),{cache:'no-store'});
     if(!detailResponse.ok)fail();const detail=await detailResponse.json();if(detail.week!==week||!detail.types)fail();
     const values=Object.values(detail.types);let typedTotal=0,configured=0,target=0;
     for(const value of values){typedTotal+=value.delivered.drafts+value.delivered.finals;if(value.target!==null){configured++;target+=value.target;}}
     if(typedTotal!==account.thisWeek)fail();
     const targetSummary=configured===0?'Not set / week':configured<values.length?`${format(target)} configured · ${values.length-configured} not set / week`:`${format(target)} / week`;
     if(!cells[3].startsWith(targetSummary))fail();
     const gap=configured===values.length?Math.max(0,target-account.thisWeek):null;
     if((gap===null?cells[5]!=='—':number(cells[5])!==gap))fail();
     if(configured===values.length){targetTotal+=target;targetRows++;gapTotal+=gap;gapRows++;}
     typesCompared+=values.length;typesMatched+=values.length;
    }else{const expected=account.sharedLogin?'Shared login · no personal target':'No personal target';if(!cells[3].startsWith(expected)||cells[5]!=='—')fail();}
   }
   return {rowsCompared,rowsMatched,typesCompared,typesMatched,deliveredTotal,verifiedAccountPath,
    targetTotal,targetsConfiguredRows:targetRows,gapTotal,gapsAvailableRows:gapRows};
  },week);
  if(team.rowsCompared!==team.rowsMatched||team.typesCompared!==team.typesMatched)throw Error('Editors team table aggregate comparison failed');
  if(!verifiedAccountPath){
   if(team.typesCompared!==0)throw Error('Editors identity qualification does not match the API');
   receipts.push({screen:'editors-week',week,...team,profileTypesCompared:0,profileTypesMatched:0,profileComparison:'not_applicable_no_verified_account',passed:true});await closeContext(ctx);
  }else{
  let profilePath=null;
  for(const row of await table.locator('tbody tr').all()){
   const href=await row.locator('td:first-child a').getAttribute('href');
   if(href?.startsWith(verifiedAccountPath)){profilePath=href;break;}
  }
  if(!profilePath)throw Error('Editors API-verified account profile link unavailable');
  const screenshotPath=`${out}/${environment}-editors-week-aggregate.png`;
  await table.evaluate((node,summary)=>{
   const caption=document.createElement('caption');
   caption.textContent=`Aggregate QA for ${summary.week}: ${summary.rowsMatched} account rows and ${summary.typesMatched} type rows matched`;
   node.prepend(caption);node.tBodies[0].replaceChildren();
  },{...team,week});
  await table.screenshot({path:screenshotPath});
  const profileResponse=await page.goto(origin+profilePath,{waitUntil:'domcontentloaded'});
  if(profileResponse?.status()!==200)throw Error('Editors verified account profile HTTP '+profileResponse?.status());
  await page.waitForURL(/\/people\/accounts\//);
  const profile=await page.evaluate(async week=>{
   const fail=()=>{throw Error('Editors weekly target table did not match its API')};
   const table=document.querySelector('table[aria-label$="target, delivered, and gap by creative type"]');if(!table)fail();
   const account=decodeURIComponent(location.pathname.split('/').at(-1));
   const listResponse=await fetch('/api/v0/editors?week='+encodeURIComponent(week),{cache:'no-store'});if(!listResponse.ok)fail();
   const list=await listResponse.json();const row=list.accounts.find(value=>value.account===account&&value.identityVerified===true&&!value.sharedLogin&&value.holder_person_id);if(!row)fail();
   const detailResponse=await fetch('/api/v1/editors/'+encodeURIComponent(row.holder_person_id)+'/week?week='+encodeURIComponent(week),{cache:'no-store'});if(!detailResponse.ok)fail();
   const detail=await detailResponse.json();if(detail.week!==week||!detail.types)fail();
   const labels={model_video:'Model video',vov:'VOV',founder_video:'Founder video',testimonial:'Testimonial',walkthrough:'Walkthrough',other:'Other'};
   const format=value=>new Intl.NumberFormat('en-IN').format(value);let typesCompared=0,typesMatched=0;
   for(const [kind,value] of Object.entries(detail.types)){
    const targetRow=[...table.tBodies[0].rows].find(candidate=>candidate.cells[0]?.textContent.trim()===labels[kind]);if(!targetRow)fail();
    const cells=[...targetRow.cells].map(cell=>cell.textContent.trim());
    const targetText=value.target===null?'Not set':`${format(value.target)} / week`;if(!cells[1].startsWith(targetText))fail();
    const delivered=value.delivered.drafts+value.delivered.finals;
    if(!cells[2].startsWith(`${format(delivered)} · ${format(value.delivered.drafts)} drafts / ${format(value.delivered.finals)} finals`))fail();
    if(value.gap===null?cells[3]!=='—':Number(cells[3].replaceAll(',',''))!==value.gap)fail();
    typesCompared++;typesMatched++;
   }
   return {typesCompared,typesMatched};
  },week);
  if(profile.typesCompared===0||profile.typesCompared!==profile.typesMatched)throw Error('Editors profile type comparison failed');
  receipts.push({screen:'editors-week',week,...team,profileTypesCompared:profile.typesCompared,profileTypesMatched:profile.typesMatched,screenshot:'staging-editors-week-aggregate.png',passed:true});
  await closeContext(ctx);
  }
 }
 for(const path of ['/debug','/__debug','/_next/static/test.js.map']){
  const ctx=await context(390,'light',null);const response=await ctx.request.get(`http://127.0.0.1:${port}${path}`);if(response.status()!==404)throw Error('Debug/source map reachable');await closeContext(ctx);
 }
 fs.writeFileSync(`${out}/${environment}-browser.json`,JSON.stringify({passed:true,checks:receipts.length,receipts,errors},null,2));
 console.log(JSON.stringify({passed:true,checks:receipts.length}));
}finally{await browser.close();}

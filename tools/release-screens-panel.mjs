import fs from 'node:fs';
// EST-1983 (EST-1420 acceptance): Settings → Modules → Screens and menu and the /hidden notice on staging, signed in as
// the smoke's synthetic admin and member (never a real person's session). Read only against the organisation's real
// choice: roles are picked on the page, no switch is pressed, and any write to the choice endpoint is refused before it
// leaves the browser. Receipts keep statuses and counts (no response body, name or ID); screenshots show the panel and
// the notice only, private (0600).
const ENDPOINT='/api/v0/settings/screens';
// The always-shown screens (services/api/src/screens.ts, `fixed`) by address, with their rail labels (packages/ui-shell);
// every role's rail has the first three, the HR desk only where the role has it.
const FIXED={'/chats':'Chats','/dashboard':'Dashboard','/hr':'HR desk','/me':'My desk'},EVERY=['Chats','Dashboard','My desk'];
const ROLES=['person','manager','pgs','finance','hr','leadership','admin'];
export async function screensPanel({newContext,closeContext,origin,width,theme,out,environment}){
 const opened=[],errors=[],writes=[];
 const open=async role=>{const ctx=await newContext(role);opened.push(ctx);const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.route(url=>url.pathname===ENDPOINT,route=>{if(route.request().method()==='GET')return route.fallback().catch(()=>{});writes.push(route.request().method());return route.abort().catch(()=>{});});
  return page;};
 const clean=async(page,what)=>{
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2))throw Error(`screens: ${what} overflow ${width}`);
  if((await page.evaluate(()=>window.__pulseCspViolations)).length)throw Error(`screens: ${what} CSP violation`);
  if(errors.length)throw Error(`screens: ${what} browser error: ${errors[0].slice(0,100)}`);
  if(writes.length)throw Error('screens: the read-only pass tried to save the choice');};
 const shot=async(locator,name)=>{const path=`${out}/${environment}-${name}-${width}-${theme}.png`;await locator.screenshot({path});fs.chmodSync(path,0o600);return path.split('/').at(-1);};
 const notice=page=>page.locator('#main-content').getByText('Hidden by your admin',{exact:true}).locator('xpath=ancestor::section[1]');
 try{
  const page=await open('admin');
  const response=await page.goto(origin+'/settings?tab=organisation&section=Modules',{waitUntil:'load'});
  if(response?.status()!==200)throw Error('screens: Settings HTTP '+response?.status());
  const panel=page.getByRole('heading',{name:/^Screens and menu/}).locator('xpath=ancestor::section[1]');
  const group=panel.getByRole('radiogroup',{name:'Role',exact:true});await group.waitFor({timeout:30000});
  const fresh=panel.getByRole('switch',{name:/^New screens start hidden: (on|off)$/});await fresh.waitFor();
  const api=await page.evaluate(async endpoint=>{
   const s=await fetch(endpoint,{cache:'no-store'}),m=await fetch('/api/v0/me',{cache:'no-store'});
   const d=s.ok?await s.json():null,me=m.ok?await m.json():null;
   return {settings:s.status,canEdit:d?.canEdit===true,screens:d?.screens?.length??0,fixed:(d?.screens??[]).filter(x=>x.fixed).map(x=>x.href).sort(),newScreensHidden:d?.newScreensHidden===true,me:m.status,admin:me?.role==='admin'};
  },ENDPOINT);
  if(api.settings!==200||!api.canEdit||api.me!==200||!api.admin)throw Error(`screens: settings/screens HTTP ${api.settings} (canEdit ${api.canEdit}), /me HTTP ${api.me} (admin ${api.admin})`);
  if(api.fixed.join()!==Object.keys(FIXED).join())throw Error('screens: the live registry protects '+api.fixed.join());
  if(await fresh.isChecked()!==api.newScreensHidden||await fresh.isDisabled())throw Error('screens: New screens start hidden does not match the saved choice');
  const roles={};
  for(const role of ROLES){
   await group.locator(`[data-value="${role}"]`).click();await group.locator(`[data-value="${role}"][aria-checked="true"]`).waitFor();
   const rows=[];
   for(const control of await panel.getByRole('switch',{name:/ for .+: (shown|hidden)$/}).all()){
    const [,label,state]=(await control.getAttribute('aria-label')).match(/^(.+) for .+: (shown|hidden)$/);
    const item=control.locator('xpath=ancestor::li[1]');
    rows.push({label,state,disabled:await control.isDisabled(),visible:await control.isVisible(),always:await item.getByText('Always shown',{exact:true}).count()>0,text:(await control.locator('xpath=..').innerText()).trim()});
   }
   const fixed=rows.filter(r=>Object.values(FIXED).includes(r.label)),free=rows.filter(r=>!Object.values(FIXED).includes(r.label));
   if(!rows.length||rows.some(r=>!r.visible||r.text!==(r.state==='shown'?'Shown':'Hidden')))throw Error(`screens: ${role} has no visible Shown/Hidden controls`);
   if(fixed.some(r=>!r.disabled||r.state!=='shown'||!r.always)||EVERY.some(label=>!fixed.some(r=>r.label===label)))throw Error(`screens: a protected screen is switchable or missing for ${role}`);
   if(free.some(r=>r.disabled||r.always))throw Error(`screens: a switchable screen is locked for ${role}`);
   if(role==='admin'&&(fixed.length!==Object.keys(FIXED).length||!free.length))throw Error('screens: the admin rail lacks a protected or switchable screen');
   roles[role]={screens:rows.length,protected:fixed.map(r=>r.label).sort(),switchable:free.length};
  }
  await clean(page,'Screens and menu');
  const panelShot=await shot(panel,'screens-panel');
  if((await page.goto(origin+'/hidden',{waitUntil:'load'}))?.status()!==200)throw Error('screens: /hidden failed for the admin');
  await notice(page).waitFor();await clean(page,'admin notice');
  const adminShot=await shot(notice(page),'hidden-notice-admin');
  await notice(page).getByRole('link',{name:'Open Settings → Modules',exact:true}).click();
  await page.waitForURL(u=>u.pathname==='/settings'&&u.searchParams.get('section')==='Modules');await group.waitFor({timeout:30000});
  const member=await open('person');
  if((await member.goto(origin+'/hidden',{waitUntil:'load'}))?.status()!==200)throw Error('screens: /hidden failed for the member');
  await notice(member).waitFor();await clean(member,'member notice');
  const memberShot=await shot(notice(member),'hidden-notice-member');
  await notice(member).getByRole('link',{name:'Go to Dashboard',exact:true}).click();
  await member.waitForURL(u=>u.pathname==='/dashboard');await member.locator('#main-content').waitFor();
  if(await member.locator('#main-content').getByText('Hidden by your admin',{exact:true}).count())throw Error('screens: Dashboard shows the hidden notice');
  await clean(member,'member Dashboard');await clean(page,'Settings after the notice');
  return {screen:'screen-hiding',width,theme,syntheticSessions:true,readOnly:true,settingsStatus:api.settings,canEdit:api.canEdit,meStatus:api.me,
   registryScreens:api.screens,protectedScreens:api.fixed,newScreensSwitch:true,roles,writes:0,hiddenNotice:true,settingsLink:true,dashboardLink:true,
   overflow:false,cspViolations:0,pageErrors:0,screenshots:[panelShot,adminShot,memberShot],passed:true};
 }finally{for(const ctx of opened){for(const page of ctx.pages())await page.unrouteAll({behavior:'ignoreErrors'});await closeContext(ctx);}}
}

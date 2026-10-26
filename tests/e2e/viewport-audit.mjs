// Read-only live UI audit. node viewport-audit.mjs [--theme=dark] [--sizes=1920x860,...] [--collapsed] [--discover] [--shots] [--out=dir]
// Round 6 adds: text under 12 px, lists showing fewer than 6 items, components under their minimum size
// (KPI tile 96, chart 176 plot/220 panel, row 40, side panel 320, tap target 32), truncated text without a tooltip, any scrollbar.
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
const args=process.argv.slice(2), flag=n=>args.find(x=>x.startsWith(`--${n}=`))?.split('=')[1];
const theme=flag('theme')??'light', sizes=(flag('sizes')??'1920x860,1536x730,1366x650,1280x650,2560x1300,390x760').split(',').map(x=>x.split('x').map(Number));
const collapsed=args.includes('--collapsed'), discover=args.includes('--discover'), shots=args.includes('--shots');
const email=flag('email')??'admin@estateautopilots.com';
const explicit=args.filter(x=>!x.startsWith('--'));
const out=flag('out')??'/home/eadev/ea-research/round-6/audit'; await mkdir(out,{recursive:true});
let browser=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});const records=[];const initial=[
'/dashboard','/tasks','/tasks?view=week','/chats','/projects','/projects?view=cards','/projects?view=list','/clients','/contacts','/map','/people','/people?view=list','/people?tab=tracking','/people?tab=tracking&view=accounts','/me','/hr','/hr-history','/shifts','/leadership','/money','/review-data','/audit','/activity','/groups','/notifications','/opshub','/settings','/settings?tab=team&view=lines'];
const reference=await browser.newContext({extraHTTPHeaders:{'Cf-Access-Authenticated-User-Email':'admin@estateautopilots.com'}});
for(const [endpoint,key,prefix] of [['clients','clients','/clients/'],['contacts','contacts','/contacts/'],['people','people','/people/']]){const data=await(await reference.request.get(`http://127.0.0.1:3200/api/v0/${endpoint}`)).json();const list=data[key]??[];for(const item of list.slice(0,prefix==='/people/'?2:1))initial.push(prefix+item.id);}
const projects=await(await reference.request.get('http://127.0.0.1:3200/api/v0/projects')).json();if(projects.projects?.[0]) initial.push('/projects/'+projects.projects[0].projectId);
const firstProject=projects.projects?.[0]?.projectId;if(firstProject){initial.push('/stewardship/project/'+firstProject);const detail=await(await reference.request.get('http://127.0.0.1:3200/api/v0/projects/'+firstProject)).json();const file=(detail.deliveries??detail.project?.deliveries??[])[0];const fileId=file?.fileId??file?.id;if(fileId)initial.push('/deliveries/'+encodeURIComponent(fileId));}
const accounts=await(await reference.request.get('http://127.0.0.1:3200/api/v0/editors')).json();if(accounts.accounts?.[0])initial.push('/people/accounts/'+encodeURIComponent(accounts.accounts[0].account));await reference.close();
let paths=explicit.length?explicit:initial;
if(!discover&&!explicit.length){try{paths=JSON.parse(await readFile(`${out}/paths.json`,'utf8'));}catch{}}
for(const [width,height] of sizes){
let ctx,page,errors=[];
const open=async()=>{if(!browser.isConnected())browser=await chromium.launch();const options={viewport:{width,height},colorScheme:theme,extraHTTPHeaders:{'Cf-Access-Authenticated-User-Email':email}};try{ctx=await browser.newContext(options);}catch{await browser.close().catch(()=>{});browser=await chromium.launch();ctx=await browser.newContext(options);}await ctx.route('**/*',route=>{const headers={...route.request().headers()};if(!route.request().url().startsWith('http://127.0.0.1:3200'))delete headers['cf-access-authenticated-user-email'];return route.continue({headers});});await ctx.addInitScript(([t,c])=>{localStorage.setItem('pulse.theme',t);if(c)localStorage.setItem('pulse.sidebar.collapsed','true');},[theme,collapsed]);page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/hydrat|cannot be a descendant|Unhandled|Uncaught/i.test(m.text()))errors.push(m.text().slice(0,300));});};await open();
const canonical = path => { const url = new URL(path,"http://localhost"); url.searchParams.sort(); return url.pathname + url.search; };
// Secondary panes are already mounted. Reuse their page and update Next's native-history integration,
// so the matrix checks each pane without repeatedly fetching the same tenant records. Sharing/reload
// and the actual arrow/button navigation are exercised separately in app-feel.spec.ts.
const primary = path => { const url=new URL(path,'http://localhost');url.searchParams.delete('section');url.searchParams.delete('detail');url.searchParams.sort();return url.pathname+url.search; };
const queue=paths.map(canonical).sort((a,b)=>primary(a).localeCompare(primary(b))),seen=new Set(),retries=new Map();let loaded='';
while(queue.length){const path=queue.shift();if(seen.has(path))continue;seen.add(path);errors=[];
try{const key=primary(path);if(key!==loaded||args.includes('--reload')){const response=await page.goto('http://127.0.0.1:3200'+path,{waitUntil:/^\/(chats|inbox|communication)/.test(path)?'load':'networkidle',timeout:45000});loaded=key;if(response.status()>=400)errors.push('HTTP '+response.status());}else{await page.evaluate(path=>history.replaceState(null,'',path),path);}
await page.waitForFunction(()=>document.querySelector('main h2,main h3,main [class*="__message"]')&&!document.querySelector('main [aria-busy="true"]'),{},{timeout:45000});
await page.waitForFunction(()=>[...document.querySelectorAll('[data-section-param]')].filter(el=>el.getClientRects().length&&!el.closest('[hidden]')).every(el=>{const panes=[...el.querySelectorAll(':scope > [data-section]')];const requested=new URLSearchParams(location.search).get(el.dataset.sectionParam);if(!requested)return true;const selected=panes.find(x=>x.dataset.section===requested)??panes[0];return !selected?.hidden;}));
await page.waitForTimeout(600);await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});await page.waitForTimeout(150);
const result=await page.evaluate(()=>{
const desktop=innerWidth>=1280;const findings=[];const visible=el=>el.getClientRects().length&&!el.closest('[hidden],[data-page-hidden]');const name=el=>`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0].replace(/^.*__/, '')}`;
if(document.scrollingElement.scrollWidth>innerWidth+1)findings.push('Document wider than viewport');if(desktop&&document.scrollingElement.scrollHeight>innerHeight+1)findings.push('Document scrolls');
for(const el of document.querySelectorAll('main, main *, [aria-modal="true"] *')){if(!visible(el)||!el.clientHeight)continue;const c=getComputedStyle(el),dy=el.scrollHeight-el.clientHeight,dx=el.scrollWidth-el.clientWidth;if(desktop&&/auto|scroll/.test(c.overflowY)&&dy>1)findings.push(`scroll-y ${name(el)} +${dy}`);if(desktop&&/auto|scroll/.test(c.overflowX)&&dx>1)findings.push(`scroll-x ${name(el)} +${dx}`);if(desktop&&/hidden|clip/.test(c.overflowY)&&dy>3&&el.clientHeight>36&&c.whiteSpace!=='nowrap'&&!c.webkitLineClamp?.match(/\d/))findings.push(`clip-y ${name(el)} +${dy}`);if(desktop&&/hidden|clip/.test(c.overflowX)&&dx>3&&el.clientHeight>36&&c.textOverflow!=='ellipsis')findings.push(`clip-x ${name(el)} +${dx}`);}
for(const el of document.querySelectorAll('main section, main [data-pager], main form')){if(!visible(el))continue;const r=el.getBoundingClientRect();if(desktop&&r.height&&(r.bottom>innerHeight+1||r.right>innerWidth+1))findings.push(`outside ${name(el)} ${Math.round(r.bottom)},${Math.round(r.right)}`);}
if(desktop)for(const el of document.querySelectorAll('main [data-pager]')){if(!visible(el))continue;const v=el.querySelector(':scope > [data-pager-view]');if(v&&v.clientHeight<20&&el.textContent.trim())findings.push(`empty pager viewport ${name(el)}`);}

// Round 6 rules.
const tag=el=>{const c=[...el.classList].map(x=>x.replace(/^.*__/,'')).join('.');return el.tagName.toLowerCase()+(c?'.'+c:'');};
const cls=(el,n)=>[...el.classList].some(x=>x.replace(/^.*__/,'')===n);
const scope=[...document.querySelectorAll('main, [aria-modal="true"], [role="dialog"]')];
const all=new Set(scope.flatMap(r=>[r,...r.querySelectorAll('*')]));
for(const el of all){if(!visible(el))continue;const c=getComputedStyle(el);if(c.visibility==='hidden'||+c.opacity===0)continue;
 const own=[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim());
 if(own&&parseFloat(c.fontSize)<11.95&&!el.closest('.maplibregl-ctrl-attrib'))findings.push(`text<12 ${tag(el)} ${c.fontSize}`);
 const r=el.getBoundingClientRect();if(!r.width||!r.height)continue;
 const tip=el.title||el.closest('[title]')||el.getAttribute('aria-label')||el.closest('[data-tooltip]');
 if(c.textOverflow==='ellipsis'&&el.scrollWidth>el.clientWidth+1&&!tip)findings.push(`truncated ${tag(el)} "${el.textContent.trim().slice(0,28)}"`);
 if(c.webkitLineClamp&&c.webkitLineClamp!=='none'&&el.scrollHeight>el.clientHeight+2&&!tip)findings.push(`clamped ${tag(el)} "${el.textContent.trim().slice(0,28)}"`);
 if(desktop&&/auto|scroll/.test(c.overflowY+c.overflowX)&&(el.offsetWidth-el.clientWidth>2||el.offsetHeight-el.clientHeight>2)&&!['HTML','BODY'].includes(el.tagName)&&c.scrollbarWidth!=='none')findings.push(`scrollbar ${tag(el)}`);
 if(cls(el,'tile')&&r.height<95.5)findings.push(`tile<96 ${Math.round(r.height)}`);
 if(cls(el,'plot')&&r.height<175.5)findings.push(`chart<220 plot ${Math.round(r.height)}`);
 if(el.matches('[data-min-width]')&&r.width<+el.dataset.minWidth-0.5)findings.push(`narrow ${tag(el)} ${Math.round(r.width)}<${el.dataset.minWidth}`);
 if(el.matches('button, [role="tab"], select, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), summary, a[class*="__btn"], a[class*="__segment"], a[class*="__tab"], a[class*="__panelAction"]')&&!el.closest('[data-tap-ok]')&&!cls(el,'dot')&&!el.matches('[class*="__dot"]')&&r.height<31.5&&c.position!=='absolute')findings.push(`tap<32 ${tag(el)} ${Math.round(r.height)}`);
}
for(const el of document.querySelectorAll('main [data-pager][data-cramped]'))if(visible(el))findings.push(`list shows ${el.dataset.shown} of ${el.dataset.total}`);
if(desktop)for(const el of document.querySelectorAll('main [data-pager-view] [data-items] > *, main [data-pager-view] ul:not([class*="Legend"]):not([class*="chips"]):not([class*="tabs"]) > li, main [data-pager-view] tbody > tr'))if(visible(el)&&el.getBoundingClientRect().height<39.5&&el.textContent.trim()&&!el.closest('[data-tap-ok]'))findings.push(`row<40 ${tag(el.parentElement)} ${Math.round(el.getBoundingClientRect().height)}`);
const next=[...document.querySelectorAll('main nav[aria-label="Sections"] a, main nav[aria-label="Views"] a')].filter(visible).map(x=>x.getAttribute('href')).filter(x=>x?.split('?')[0]===location.pathname);
for(const ws of document.querySelectorAll('[data-section-param]')){if(!visible(ws))continue;for(const pane of ws.querySelectorAll(':scope > [data-section]')){const q=new URLSearchParams(location.search);q.set(ws.dataset.sectionParam,pane.dataset.section);next.push(location.pathname+'?'+q.toString());}}
return {findings:[...new Map(findings.map(f=>[f.replace(/\d+(\.\d+)?/g,'#'),f])).values()],next,headings:[...document.querySelectorAll('main h2,main h3,main [class*="__emptyTitle"]')].filter(visible).map(x=>x.textContent)};
});const findings=[...result.findings,...errors];records.push({width,height,theme,collapsed,path,findings,headings:result.headings});if(findings.length)console.log('FAIL',width,height,path,findings.join('; '));
if(discover&&sizes[0][0]===width)for(const raw of result.next){ const next=canonical(raw); if(!seen.has(next)&&!queue.includes(next))queue.push(next); }
if(seen.size%50===0)console.log(`${width}x${height}: ${seen.size} checked, ${queue.length} pending`);
if(shots&&initial.map(canonical).includes(path))await page.screenshot({path:`${out}/${theme}-${width}-${path.replace(/[^a-z0-9]/gi,'_')}.png`});
// Release long-lived dev-page allocations during large matrices.
if(seen.size%40===0&&queue.length){await ctx.close();await open();loaded='';}
}catch(e){if((!browser.isConnected()||page.isClosed())&&(retries.get(path)??0)<2){retries.set(path,(retries.get(path)??0)+1);seen.delete(path);queue.unshift(path);await ctx.close().catch(()=>{});await open();loaded='';console.log('Browser restarted; retrying',path);continue;}records.push({width,height,theme,path,findings:[e.message]});console.log('ERROR',path,e.message.slice(0,150));}
}
console.log(`${width}x${height} ${theme}: ${seen.size} views checked`);if(discover&&sizes[0][0]===width){paths=[...seen];if(!explicit.length)await writeFile(`${out}/paths.json`,JSON.stringify(paths,null,2));}await ctx.close();}
await browser.close();await writeFile(`${out}/audit-${theme}${collapsed?'-collapsed':''}${email.startsWith('admin@')?'':'-'+email.split('@')[0]}${explicit.length?'-extra':''}.json`,JSON.stringify(records,null,2));console.log(`${records.length} views; ${records.filter(x=>x.findings.length).length} with findings`);

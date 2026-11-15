// The existing viewport checks, with one navigation per server-rendered view and responsive resize per size.
// Every pane is measured after fonts, finite animation completion and two ResizeObserver frames.
import {chromium} from '@playwright/test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const args=process.argv.slice(2),flag=k=>args.find(x=>x.startsWith(`--${k}=`))?.slice(k.length+3);
const out=flag('out')??'/home/eadev/ea-research/round-8/audit',theme=flag('theme')??'light';
const sizes=(flag('sizes')??'1920x860,1536x730,1366x650,1280x650,2560x1300,390x760').split(',').map(s=>s.split('x').map(Number));
const initial=flag('paths')?JSON.parse(await readFile(flag('paths'),'utf8')):[];
const extra=args.filter(x=>!x.startsWith('--'));if(!initial.length&&!extra.length)throw new Error('Supply --paths=path-list.json or explicit routes');await mkdir(out,{recursive:true});
const source=await readFile(new URL('./viewport-audit.mjs',import.meta.url),'utf8');
const begin=source.indexOf('const result=await page.evaluate(')+'const result=await page.evaluate('.length;
const end=source.indexOf(');const findings=',begin);
const measure=Function('return ('+source.slice(begin,end)+')')();
const canonical=p=>{const u=new URL(p,'http://localhost');u.searchParams.sort();return u.pathname+u.search;};
const primary=p=>{const u=new URL(p,'http://localhost');for(const k of ['section','detail','researchView','adView'])u.searchParams.delete(k);u.searchParams.sort();return u.pathname+u.search;};
const allowed=new Set([...initial,...extra].map(primary));
let queue=[...new Set([...initial,...extra].map(canonical))],seen=new Set(),loaded='',records=[],errors=[];
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const ctx=await browser.newContext({viewport:{width:sizes[0][0],height:sizes[0][1]},colorScheme:theme,extraHTTPHeaders:{'Cf-Access-Authenticated-User-Email':'admin@estateautopilots.com'}});
await ctx.route('**/*',r=>{const h={...r.request().headers()};if(!r.request().url().startsWith('http://127.0.0.1:3200'))delete h['cf-access-authenticated-user-email'];return r.continue({headers:h});});
await ctx.addInitScript(t=>localStorage.setItem('pulse.theme',t),theme);const page=await ctx.newPage();
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/hydrat|Unhandled|Uncaught/i.test(m.text()))errors.push(m.text().slice(0,300));});
while(queue.length){queue.sort((a,b)=>primary(a).localeCompare(primary(b)));const path=queue.shift();if(seen.has(path))continue;seen.add(path);errors=[];
 try{
  const key=primary(path);if(key!==loaded){await page.setViewportSize({width:sizes[0][0],height:sizes[0][1]});const response=await page.goto('http://127.0.0.1:3200'+path,{waitUntil:/^\/chats/.test(path)?'load':'networkidle',timeout:60000});if(response.status()>=400)errors.push('HTTP '+response.status());loaded=key;await page.waitForFunction(()=>document.querySelector('main')?.innerText.length>10&&!document.querySelector('main [aria-busy=true]'),{},{timeout:45000});await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});}
  else await page.evaluate(p=>history.replaceState(null,'',p),path);
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-section-param]')].filter(el=>el.getClientRects().length&&!el.closest('[hidden]')).every(el=>{const panes=[...el.querySelectorAll(':scope > [data-section]')];const requested=new URLSearchParams(location.search).get(el.dataset.sectionParam);if(!requested)return true;const selected=panes.find(x=>x.dataset.section===requested)??panes[0];return !selected?.hidden;}));
  for(const [width,height] of sizes){await page.setViewportSize({width,height});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.waitForTimeout(800);await page.waitForFunction(()=>[...document.querySelectorAll('[data-pager]')].filter(p=>p.getClientRects().length&&!p.closest('[hidden]')).every(p=>!p.querySelector('[data-items] > *,tbody tr,ul > li')||Number(p.dataset.total)>0||[...p.querySelectorAll('[data-items] > *,tbody tr,ul > li')].every(x=>x.closest('[data-pager]')!==p)),{},{timeout:30000});const r=await page.evaluate(measure);const actual=await page.evaluate(()=>document.documentElement.dataset.theme);const findings=[...r.findings,...errors,...(actual!==theme?['Theme mismatch']:[])];records.push({width,height,theme,path,findings,headings:r.headings});if(findings.length)console.log('FAIL',width,height,path,findings.join('; '));if(width===sizes[0][0]&&!args.includes('--fixed'))for(const p of r.next){const next=canonical(p);if((!args.includes("--new-only")||allowed.has(primary(next)))&&!seen.has(next)&&!queue.includes(next))queue.push(next);}}
 }catch(e){for(const [width,height] of sizes)records.push({width,height,theme,path,findings:[e.message]});console.log('ERROR',path,e.message.slice(0,150));loaded='';}
 if(seen.size%25===0){await writeFile(`${out}/audit-${theme}.json`,JSON.stringify(records,null,2));console.log(`${seen.size} views, ${queue.length} remaining`);}
}
await browser.close();await writeFile(`${out}/audit-${theme}.json`,JSON.stringify(records,null,2));await writeFile(`${out}/paths-${theme}.json`,JSON.stringify([...seen],null,2));console.log(`${records.length} checks; ${records.filter(x=>x.findings.length).length} with findings`);

// Read-only verification of the live workbench. Artifacts stay outside the repository.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
const out=process.env.PULSE_VISUAL_OUT;
if(!out)throw new Error('Set PULSE_VISUAL_OUT to a private artifact directory');
await mkdir(out,{recursive:true});
const browser=await chromium.launch(),receipts=[];
const pages=[
 ...['overview','spend','subscriptions','payroll','revenue','budget','ledger'].map(tab=>({path:'/money?tab='+tab,ready:({overview:'A clearer view',spend:'Where spending',subscriptions:'Tools, seats',payroll:'Salary cost trend',revenue:'Revenue & client',budget:'Pulse proposes',ledger:'Review duplicates'})[tab]})),
 {path:'/chats?source=team',ready:'Team chats'}, {path:'/chats?source=email',ready:'Email'},
 {path:'/chats?source=telegram',ready:'CHANNEL SETUP'}, {path:'/chats?source=whatsapp',ready:'CHANNEL SETUP'},
 {path:'/audit',ready:'Changes'}, {path:'/audit?view=reads',ready:'Reads'},
 {path:'/review-data',ready:'pending'}, {path:'/hr?tab=policies',ready:'Company policies'},
 {path:'/hr?tab=payroll',ready:'Salary'}, {path:'/me?tab=policies',ready:'Company policies'},
 {path:'/me?tab=performance',ready:'Signal coverage'}, {path:'/leadership?tab=performance',ready:'People & pods'},
 {path:'/my-week',ready:'Tasks · My week',redirect:'/tasks?view=week'},
 {path:'/inbox',ready:'Email',redirect:'/chats?source=email'},
 {path:'/communication',ready:'Chats',redirect:'/chats'}
];
const shots={'/money?tab=overview':'money-overview','/chats?source=team':'chats','/hr?tab=policies':'policies','/review-data':'review','/audit':'audit','/leadership?tab=performance':'performance'};
try{
 for(const [width,height,theme] of [[1440,900,'light'],[1366,650,'light'],[1920,860,'dark'],[390,760,'light'],[390,760,'dark']]){
  const context=await browser.newContext({viewport:{width,height},colorScheme:theme,extraHTTPHeaders:{'cf-access-authenticated-user-email':process.env.PULSE_VISUAL_EMAIL??'user-668d21b6@estateautopilots.com'}});
  await context.addInitScript(t=>localStorage.setItem('pulse.theme',t),theme);
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const selection=width===1440?pages:pages.filter(p=>!p.redirect&&p.path!=='/chats?source=email');
  for(const item of selection){
   const response=await page.goto((process.env.PULSE_VISUAL_BASE??'http://127.0.0.1:3200')+item.path,{waitUntil:'domcontentloaded',timeout:90000});
   assert.equal(response.status(),200,item.path);
   await page.waitForFunction(text=>document.querySelector('main')?.textContent?.toLowerCase().includes(text.toLowerCase()),item.ready,{timeout:30000});
   await page.waitForFunction(t=>document.documentElement.dataset.theme===t,theme);
   await page.waitForTimeout(250);
   if(item.redirect)assert.ok(new URL(page.url()).pathname+new URL(page.url()).search===item.redirect,item.path+' redirect');
   const layout=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,railText:[...document.querySelectorAll('nav[aria-label="Main sections"] a')].map(a=>a.textContent.trim()).filter(Boolean),main:!!document.querySelector('main h2')}));
   assert.ok(!layout.overflow,`${width} ${theme} ${item.path}: horizontal page overflow`);assert.deepEqual(layout.railText,[],'Icon-only rail');assert.ok(layout.main,item.path+' heading');assert.deepEqual(errors,[],item.path+' browser errors');
   if(shots[item.path]&&((width===1440)||(width===390&&theme==='dark')))await page.screenshot({path:`${out}/${shots[item.path]}-${width}-${theme}.png`,mask:item.path.includes('/chats')?[page.locator('article[id^="message-"]')]:[]});
   receipts.push({path:item.path,width,height,theme,status:response.status(),...layout});console.log(`${width} ${theme} ${item.path} OK`);
  }
  await context.close();
 }
 await writeFile(out+'/visual-receipts.json',JSON.stringify(receipts,null,2));
}finally{await browser.close();}

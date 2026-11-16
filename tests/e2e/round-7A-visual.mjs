import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
const out=process.env.PULSE_SHOTS_DIR??'/home/eadev/ea-research/round-7A';await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});const results=[];
for(const [width,height] of [[1920,860],[1536,730],[1366,650],[1280,650],[2560,1300],[390,760]])for(const theme of ['light','dark']){
 const context=await browser.newContext({viewport:{width,height}});const page=await context.newPage();await page.addInitScript(theme=>{localStorage.setItem('pulse:theme',theme);if(document.documentElement)document.documentElement.dataset.theme=theme;},theme);
 await page.route('http://127.0.0.1:3200/**',route=>route.continue({headers:{...route.request().headers(),'cf-access-authenticated-user-email':'admin@estateautopilots.com'}}));
 for(const path of ['/chats','/groups','/settings?tab=sign-in','/login']){
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:3200'+path);await page.locator('main').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('main')?.innerText.length>10);await page.waitForTimeout(300);
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  if(path==='/chats')await page.getByRole('navigation',{name:'Conversations',includeHidden:true}).waitFor({state:'attached'});
  const fit=await page.evaluate(()=>{const main=document.querySelector('main');const all=[...main.querySelectorAll('*')].filter(e=>e.getClientRects().length);return {horizontal:document.documentElement.scrollWidth>innerWidth+1,mainOverflow:main.scrollHeight>main.clientHeight+2,cramped:all.filter(e=>e.hasAttribute('data-cramped')).length,workspace:main.querySelector('[class*=chats][data-grow]')?.getBoundingClientRect().toJSON(),tiny:all.filter(e=>e.children.length===0&&e.textContent.trim()&&!e.closest('[class*=avatar]')&&parseFloat(getComputedStyle(e).fontSize)<12).length};});
  assert.equal(fit.horizontal,false,`${path} ${width} horizontal overflow`);assert.equal(errors.length,0,errors.join(';'));
  if(width>=1180&&path==='/chats')assert.equal(fit.mainOverflow,false,'Chats desktop outer scroll');
  const name=path.split('?')[0].slice(1);await page.screenshot({path:`${out}/${name}-${width}x${height}-${theme}.png`});results.push({path,width,height,theme,...fit});
 }
 await context.close();
}
await browser.close();await writeFile(`${out}/visual-checks.json`,JSON.stringify(results,null,2));console.log(`${results.length} visual checks completed`);

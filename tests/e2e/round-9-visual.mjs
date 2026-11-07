import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
const out='/home/eadev/ea-research/round-9/visual';await mkdir(out,{recursive:true});
const browser=await chromium.launch(),results=[];
for(const theme of ['light','dark'])for(const [width,height] of [[1920,860],[1536,730],[1366,650],[390,760]]){
 const ctx=await browser.newContext({viewport:{width,height},colorScheme:theme,extraHTTPHeaders:{'Cf-Access-Authenticated-User-Email':'admin@estateautopilots.com'}});
 await ctx.addInitScript(t=>localStorage.setItem('pulse.theme',t),theme);
 const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:3200/dashboard');
 await page.getByRole('button',{name:'Open insights and actions'}).click();
 await page.getByRole('button',{name:'Why',exact:true}).first().waitFor();
 await page.waitForTimeout(300);
 const geometry=await page.evaluate(()=>({horizontal:document.documentElement.scrollWidth>innerWidth+1,vertical:document.documentElement.scrollHeight>innerHeight+1,dialog:[...document.querySelectorAll('[aria-modal="true"]')].map(e=>({w:e.clientWidth,h:e.clientHeight,sw:e.scrollWidth,sh:e.scrollHeight}))}));
 assert.equal(geometry.horizontal,false);if(width>1000)assert.equal(geometry.vertical,false);
 await page.screenshot({path:`${out}/${theme}-${width}-rail.png`});
 await page.getByRole('button',{name:'Why',exact:true}).first().click();
 await page.getByRole('heading',{name:'Why Pulse shows this'}).waitFor();
 await page.keyboard.press('Escape');
 assert.equal(await page.getByRole('button',{name:'Open insights and actions'}).evaluate(el=>el===document.activeElement),true);
 assert.deepEqual(errors,[]);results.push({theme,width,height,geometry,focusReturned:true,errors});await ctx.close();
}
await browser.close();await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));console.log(`${results.length} rail viewport/theme/focus checks passed`);

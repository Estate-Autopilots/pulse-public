import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../../../tests/e2e/package.json',import.meta.url));
const {chromium}=require('@playwright/test');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=process.env.PULSE_EXTENSION_SCREENSHOT_DIR??'/home/eadev/ea-research/round-14/chrome-visual';
await mkdir(out,{recursive:true});
const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;const file=resolve(root,'.'+(path==='/'?'/context.html':path));assert.ok(file.startsWith(root+'/'));res.setHeader('content-type',({'.js':'application/javascript','.css':'text/css','.html':'text/html'})[extname(file)]??'text/plain');res.end(await readFile(file));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch(),results=[];
try{for(const theme of ['light','dark'])for(const [width,height] of [[1920,860],[1536,730],[1366,650],[390,760]]){
 const context=await browser.newContext({viewport:{width,height},colorScheme:theme});
 await context.addInitScript(()=>{const area=()=>{const values={};return {get:async keys=>{if(!keys)return {...values};if(typeof keys==='string')return {[keys]:values[keys]};return Object.fromEntries(keys.map(key=>[key,values[key]]));},set:async data=>Object.assign(values,data),remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])delete values[key];},clear:async()=>{for(const key of Object.keys(values))delete values[key];}};};window.chrome={storage:{local:area(),session:area()},runtime:{sendMessage:async()=>({ok:true})}};});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);
 await page.evaluate(async()=>{const {save}=await import('/storage.js');await save({session:'synthetic-session',paused:true,personId:'synthetic-person',deviceId:'synthetic-device',trackingEpoch:'synthetic',seen:[{personId:'synthetic-person',deviceId:'synthetic-device',id:crypto.randomUUID(),at:new Date().toISOString(),projectId:crypto.randomUUID(),data:{domain:'drive.google.com',resource:'synthetic-file',seconds:60}}]});});
 await page.getByRole('button',{name:'Controls',exact:true}).click();await page.getByRole('button',{name:'Sync now',exact:true}).click();await page.getByText('Paused · 0 waiting to sync',{exact:true}).waitFor();
 for(const view of ['Account','Controls','Evidence']){await page.getByRole('button',{name:view,exact:true}).click();const layout=await page.evaluate(()=>({horizontal:document.documentElement.scrollWidth>innerWidth,vertical:document.documentElement.scrollHeight>innerHeight,controls:[...document.querySelectorAll('button,input,select')].filter(e=>e.getClientRects().length).map(e=>({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom})),pane:[...document.querySelectorAll('[data-pane]')].filter(e=>!e.hidden).map(e=>e.scrollHeight-e.clientHeight)}));assert.equal(layout.horizontal,false);assert.equal(layout.vertical,false);assert.ok(layout.controls.every(c=>c.top>=0&&c.bottom<=590));assert.ok(layout.pane.every(d=>d<=2));assert.deepEqual(errors,[]);results.push({theme,width,height,view,...layout,chrome:'mocked'});await page.screenshot({path:`${out}/${theme}-${width}-${view}.png`});}
 await context.close();
}}finally{await browser.close();await new Promise(r=>server.close(r));await writeFile(out+'/results.json',JSON.stringify(results,null,2));}

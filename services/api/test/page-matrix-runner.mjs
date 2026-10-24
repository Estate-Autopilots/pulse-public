import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {readFile,writeFile,readdir,stat,mkdir} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {chromium} from '../../../tests/e2e/node_modules/@playwright/test/index.mjs';
import {DESIGNER_DETAIL_ROLES} from '../../../apps/web/app/lib/designers-view.mjs';
import {openWithRetry} from './page-goto.mjs';
const root=resolve('../..');
const RESTRICTED=/unavailable|access|admin|restricted|Leadership/i;
async function pageFiles(dir){const list=[];for(const entry of await readdir(dir,{withFileTypes:true})){const path=resolve(dir,entry.name);if(entry.isDirectory())list.push(...await pageFiles(path));else if(entry.name==='page.tsx')list.push(path);}return list;}
const port=async()=>{const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;};
export async function runPages(tokens,report,api){
 // Hosted cells split the matrix (PULSE_PAGE_MATRIX_SHARD=i/n): each takes every n-th check; the chat proof runs in 1/n.
 const [shardIndex,shardCount]=(process.env.PULSE_PAGE_MATRIX_SHARD||'1/1').split('/').map(Number);let unit=0;const mine=()=>unit++%shardCount===shardIndex-1;
 const webPort=await port(),base=`http://127.0.0.1:${webPort}`;
 const webDir=resolve(root,'apps/web');let dist='.next';
 try{const build=await stat(resolve(webDir,'.next/BUILD_ID')),head=Number(execFileSync('git',['log','-1','--format=%ct'],{cwd:root,encoding:'utf8'}).trim())*1000;if(build.mtimeMs<=head)throw new Error('stale web build');}
 catch{dist='.next-matrix';const build=spawn(resolve(webDir,'node_modules/.bin/next'),['build'],{cwd:webDir,env:{...process.env,PULSE_API_URL:api,PULSE_PUBLIC_URL:base,PULSE_PUBLIC_LOGIN_ENABLED:'1',NEXT_DIST_DIR:dist},stdio:'inherit'});const [code]=await once(build,'exit');assert.equal(code,0,'temporary web production build');}
 const web=spawn(resolve(webDir,'node_modules/.bin/next'),['start','-p',String(webPort),'-H','127.0.0.1'],{cwd:webDir,env:{...process.env,PULSE_API_URL:api,PULSE_PUBLIC_URL:base,PULSE_PUBLIC_LOGIN_ENABLED:'1',NEXT_DIST_DIR:dist},stdio:'ignore'});
 let browser;const checks=[],retries=[];
 try{
  let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(base+'/healthz');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(ready,'temporary web started');
  browser=await chromium.launch({headless:true});
  const pages=(await pageFiles(resolve(root,'apps/web/app'))).map(path=>'/'+relative(resolve(root,'apps/web/app'),path).replace(/\/page.tsx$/,'').replace('[file]','missing-file').replace('[account]','unlinked%40example.test').replace('[entity]','project'));
  pages.push('/dashboard?tab=research','/leadership?tab=growth','/leadership?tab=outcomes','/leadership?tab=pipeline','/money?tab=ad-spend','/clients?tab=renewals','/projects/[id]?tab=leads','/projects/[id]?tab=creatives','/projects/[id]?tab=calls','/settings?tab=data-health');
  for(const [role,token] of Object.entries(tokens)){
   const context=await browser.newContext({viewport:{width:1440,height:900}});await context.addCookies([{name:'pulse_session',value:token,url:base,httpOnly:true,sameSite:'Lax'}]);
   for(const pattern of pages){if(!mine())continue;
    const path=pattern.replace('[person]',JSON.parse(process.env.TEST_ROLES)[role]).replace('[id]',pattern.startsWith('/people/')?JSON.parse(process.env.TEST_ROLES)[role]:pattern.startsWith('/projects/')||pattern.startsWith('/stewardship/')?process.env.TEST_PROJECT:'00000000-0000-4000-8000-000000000001');
    const errors=[];const attachPageError=page=>page.on('pageerror',e=>errors.push(e.message));context.on('page',attachPageError);let page;
    try{
    page=await openWithRetry(context,base+path,{waitUntil:'domcontentloaded'},retries);const r=page.navigationResponse;assert.ok(r&&r.status()<500,`${role} ${pattern}: HTTP ${r?.status()}`);
    await page.locator('main').waitFor({state:'visible'});await page.waitForFunction(()=>{const main=document.querySelector('main');return main&&main.innerText.length>10&&!main.querySelector('[role="status"][aria-busy="true"]');});if(pattern==='/designers/[person]'){const expected=DESIGNER_DETAIL_ROLES.has(role)?'Your design deliveries':'Daily detail is private';await page.locator('main').getByText(expected).waitFor();}const restricted=pattern==='/money'&&role!=='leadership'||pattern==='/leadership'&&!['leadership','admin'].includes(role)||pattern==='/audit'&&!['leadership','admin'].includes(role)||pattern==='/shifts'&&!['hr','leadership','admin'].includes(role)||pattern==='/opshub'&&role!=='admin';if(restricted)await page.locator('main').getByText(RESTRICTED).first().waitFor({timeout:15_000}).catch(()=>{});const text=await page.locator('main').innerText();assert.ok(text.length>10,`${role} ${pattern} rendered`);
    if(pattern==='/designers'){
     const id=JSON.parse(process.env.TEST_ROLES)[role],href=`/designers/${encodeURIComponent(id)}?week=`,links=await page.locator('table[aria-label="Weekly design deliveries by person and type"] tbody a, section[aria-label="Weekly design deliveries by person and type"] a').evaluateAll(anchors=>anchors.map(link=>link.getAttribute('href')??''));assert.ok(links.every(link=>DESIGNER_DETAIL_ROLES.has(role)&&link.startsWith(href)),`${role} sees no unopenable designer-detail link: ${links.join(', ')}`);assert.equal(links.some(link=>link.startsWith(href)),DESIGNER_DETAIL_ROLES.has(role),`${role} self-detail link permission`);
    }
    if(restricted)assert.match(text,RESTRICTED,`${role} ${pattern} permission state`);
    if(pattern==='/designers/[person]'){
     if(role==='person'){
      assert.equal(path,`/designers/${JSON.parse(process.env.TEST_ROLES)[role]}`,`${role} opens their own designer detail`);
      assert.match(text,/Your design deliveries/,`${role} sees their own designer detail`);
      const otherPerson=JSON.parse(process.env.TEST_ROLES).manager;
      const other=await openWithRetry(context,base+'/designers/'+encodeURIComponent(otherPerson),{waitUntil:'domcontentloaded'},retries);
      try{assert.ok(other.navigationResponse&&other.navigationResponse.status()<500,`${role} other designer detail: HTTP ${other.navigationResponse?.status()}`);
      await other.locator('main').getByText('Daily detail is private').waitFor();const otherText=await other.locator('main').innerText();
      assert.match(otherText,/Daily detail is private/,`${role} cannot open another person’s designer detail`);
      checks.push({role,path:'/designers/[other-person]',access:'private'});}finally{await other.close();}
     }else{
      assert.match(text,/Daily detail is private/,`${role} designer detail permission state`);
     }
    }
    if(pattern==='/chats')await page.getByRole('navigation',{name:'Conversations',includeHidden:true}).waitFor({state:'attached'});
    if(pattern==='/settings'&&['hr','admin'].includes(role)){await page.getByRole('button',{name:'Who can sign in',exact:true}).click();await page.getByRole('button',{name:'Preview team invitations'}).waitFor();}
    assert.equal(errors.length,0,`${role} ${pattern}: ${errors.join('; ')}`);checks.push({role,path:pattern});
    // A failure names the role and page it stopped on, with what the page showed (the bare locator timeout did not).
    }catch(e){const shown=await page?.evaluate(()=>`${document.title} | ${(document.body?.innerText??'').replace(/\s+/g,' ').slice(0,300)}`).catch(()=>'(page closed)');throw new Error(`${role} ${path}: ${String(e.message).split('\n')[0]} | page showed: ${shown}`,{cause:e});
    }finally{context.off('page',attachPageError);await page?.close();}
   }
   // Every Settings and HR tab is role checked, including private payroll.
   for(const path of ['/settings?tab=team','/settings?tab=roles','/settings?tab=connected','/settings?tab=organisation','/hr?tab=attendance','/hr?tab=leave','/hr?tab=requests','/hr?tab=payroll','/hr?tab=policies']){if(!mine())continue;
    const errors=[];const attachPageError=page=>page.on('pageerror',e=>errors.push(e.message));context.on('page',attachPageError);let page;
    try{page=await openWithRetry(context,base+path,{waitUntil:'domcontentloaded'},retries);assert.ok(page.navigationResponse?.status()<500,role+' '+path);checks.push({role,path});assert.equal(errors.length,0,`${role} ${path}: ${errors.join('; ')}`);}finally{context.off('page',attachPageError);await page?.close();}
   }
   await context.close();
  }
  const pagesReport=JSON.parse(await readFile(report,'utf8'));pagesReport.pageRoutes=pages.length;pagesReport.pageChecks=checks.length;pagesReport.pageReceipts=checks;pagesReport.pageGotoRetries=retries.length;await writeFile(report,JSON.stringify(pagesReport));
  // Opt-in release audit: all routes at both phone sizes and themes, with disposable matrix sessions only.
  if(process.env.PULSE_PHONE_MATRIX_DIR){
   const directory=resolve(process.env.PULSE_PHONE_MATRIX_DIR),receipts=[];await mkdir(directory,{recursive:true});
   const patterns=[...pages,'/settings?tab=team','/settings?tab=roles','/settings?tab=connected','/settings?tab=organisation','/hr?tab=attendance','/hr?tab=leave','/hr?tab=requests','/hr?tab=payroll','/hr?tab=policies'];
   for(const [width,height] of [[360,780],[390,844]])for(const theme of ['light','dark']){
    const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2,isMobile:true,hasTouch:true,colorScheme:theme,userAgent:'Mozilla/5.0 (Linux; Android 13; M1906G7G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'});
    await context.addInitScript(value=>localStorage.setItem('pulse.theme',value),theme);
    await context.addCookies([{name:'pulse_session',value:tokens.admin,url:base,httpOnly:true,sameSite:'Lax'}]);
    try{for(const pattern of patterns){if(!mine())continue;
     const path=pattern.replace('[person]',JSON.parse(process.env.TEST_ROLES).admin).replace('[id]',pattern.startsWith('/people/')?JSON.parse(process.env.TEST_ROLES).admin:pattern.startsWith('/projects/')||pattern.startsWith('/stewardship/')?process.env.TEST_PROJECT:'00000000-0000-4000-8000-000000000001');
     const errors=[];let page;
     try{
      page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
      const response=await page.goto(base+path,{waitUntil:'domcontentloaded'});assert.ok(response&&response.status()<500,`phone ${width} ${theme} ${pattern}: HTTP ${response?.status()}`);
      await page.locator('main').waitFor({state:'visible'});await page.waitForFunction(()=>{const main=document.querySelector('main');return main&&main.innerText.length>10&&!main.querySelector('[role="status"][aria-busy="true"]');});
      await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(200);
      const sideways=await page.evaluate(()=>document.scrollingElement.scrollWidth-innerWidth);
      const filename=`${pattern.replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'')||'root'}-${width}-${theme}.png`;
      await page.screenshot({path:resolve(directory,filename),fullPage:true});
      receipts.push({path:pattern,width,height,theme,sideways,errors,screenshot:filename});
      await writeFile(resolve(directory,'receipts.json'),JSON.stringify(receipts,null,2));
      assert.ok(sideways<=1,`phone ${width} ${theme} ${pattern}: ${sideways}px horizontal page overflow`);
      assert.equal(errors.length,0,`phone ${width} ${theme} ${pattern}: ${errors.join('; ')}`);
     }finally{await page?.close();}
    }}finally{await context.close();}
   }
   const json=JSON.parse(await readFile(report,'utf8'));json.phonePageChecks=receipts.length;await writeFile(report,JSON.stringify(json));
  }
  if(shardIndex===1){
  // Two actual browser sessions: composer, SSE, threads, reactions, search and file sharing.
  const people=JSON.parse(process.env.TEST_ROLES);
  const dmResponse=await fetch(api+'/api/v0/chats/direct',{method:'POST',headers:{'content-type':'application/json','x-pulse-session':tokens.person},body:JSON.stringify({personId:people.manager})});
  assert.equal(dmResponse.status,200);const dm=(await dmResponse.json()).id;
  const contexts=await Promise.all(['person','manager'].map(async role=>{const c=await browser.newContext({viewport:{width:1366,height:768}});await c.addCookies([{name:'pulse_session',value:tokens[role],url:base,httpOnly:true,sameSite:'Lax'}]);return c;}));
  const [sender,receiver]=await Promise.all(contexts.map(c=>openWithRetry(c,base+'/chats?channel='+dm,undefined,retries)));
  const chatErrors=[],chatWrites=[];
  for(const page of [sender,receiver]){page.on('pageerror',e=>chatErrors.push(e.message));page.on('request',r=>{if(r.method()==='POST')chatWrites.push(new URL(r.url()).pathname);});}
  // CHATS-2 (WhatsApp-style): the composer is "Message <name>", a reply quotes the message (no threads), the list's
  // "Search chats and people" searches messages, and files download from /api/v0/chats/files/<id>. Same eight checks.
  const composer=p=>p.getByRole('textbox',{name:/^Message /});
  await Promise.all([sender,receiver].map(p=>composer(p).waitFor()));
  const streamErrors=[];receiver.on('response',async r=>{if(r.url().includes('/api/v0/chats/events')&&!r.ok())streamErrors.push(String(r.status())+' '+await r.text());});
  try{await Promise.all([sender,receiver].map(page=>page.getByRole('status').filter({hasText:/^Live$/}).waitFor()));}catch(e){throw new Error('Realtime connection: '+streamErrors.join('; ')+' UI: '+await receiver.locator('main').innerText()+String(e));}
  await composer(sender).fill('Browser proof @synthetic.manager');
  const sendAndWait=async(page,button)=>{try{return (await Promise.all([page.waitForResponse(r=>r.url().endsWith('/messages')&&r.request().method()==='POST'),button.click()]))[0];}catch(e){throw new Error('Chat send diagnostics: '+JSON.stringify({errors:chatErrors,writes:chatWrites,text:await page.locator('main').innerText()})+' '+String(e));}};
  const send=p=>p.getByRole('button',{name:'Send',exact:true});
  const sent=await sendAndWait(sender,send(sender));
  assert.equal(sent.status(),200,'browser chat send: '+await sent.text());
  const log=p=>p.getByRole('log',{name:'Messages',exact:true});
  const bubble=(p,t)=>log(p).locator('article').filter({has:p.locator('p',{hasText:t})}).last();
  const waitText=async(p,t,timeout=10000)=>{await bubble(p,t).waitFor({timeout});};
  const hover=async(p,t)=>{const m=bubble(p,t);await m.scrollIntoViewIfNeeded();await m.hover();return m;};
  await waitText(receiver,'Browser proof @synthetic.manager'); // Under fallback's 15 seconds: realtime.
  await (await hover(receiver,'Browser proof')).getByRole('button',{name:'React',exact:true}).click();await receiver.getByRole('button',{name:'React 👍',exact:true}).click();
  await log(sender).getByRole('button',{name:'👍 1',exact:true}).waitFor({timeout:10000});
  await (await hover(receiver,'Browser proof')).getByRole('button',{name:'Reply',exact:true}).click();await composer(receiver).fill('Browser quote reply');
  const replied=await sendAndWait(receiver,send(receiver));assert.equal(replied.status(),200,'browser quote reply: '+await replied.text());
  await bubble(sender,'Browser quote reply').filter({hasText:'Browser proof @synthetic.manager'}).waitFor({timeout:10000});
  await sender.locator('input[type=file]').setInputFiles({name:'browser-proof.txt',mimeType:'text/plain',buffer:Buffer.from('Browser file proof')});
  await sender.getByRole('button',{name:'Remove browser-proof.txt'}).waitFor();
  const fileSent=await sendAndWait(sender,send(sender));
  assert.equal(fileSent.status(),200,'browser attachment send: '+await fileSent.text());
  const fileLink=receiver.locator('a[href^="/api/v0/chats/files/"]',{hasText:'browser-proof.txt'}).first();await fileLink.waitFor({timeout:10000});
  const fileUrl=await fileLink.getAttribute('href');const download=await contexts[1].request.get(base+fileUrl);assert.equal(download.status(),200);assert.equal(await download.text(),'Browser file proof');
  await sender.getByRole('textbox',{name:'Search chats and people'}).fill('Browser proof');await sender.getByRole('button',{name:/Search messages for/}).click();await sender.getByRole('region',{name:'Messages'}).getByText('Browser proof @synthetic.manager').first().waitFor();
  // The attendance companion must leave the real phone composer button accessible too.
  await sender.getByRole('button',{name:'Clear search',exact:true}).click();
  await Promise.all([sender,receiver].map(page=>page.setViewportSize({width:390,height:844})));
  await composer(sender).fill('Phone browser proof');
  const [phoneSent]=await Promise.all([sender.waitForResponse(r=>r.url().endsWith('/messages')&&r.request().method()==='POST'),send(sender).click()]);
  assert.equal(phoneSent.status(),200,'phone browser chat send: '+await phoneSent.text());await waitText(receiver,'Phone browser proof');
  await Promise.all(contexts.map(c=>c.close()));
  }
  const json=JSON.parse(await readFile(report,'utf8'));json.chatBrowserChecks=shardIndex===1?8:0;json.pageShard=`${shardIndex}/${shardCount}`;json.pageRoutes=pages.length;json.pageChecks=checks.length;json.pageReceipts=checks;json.pageGotoRetries=retries.length;await writeFile(report,JSON.stringify(json));
 }finally{await browser?.close();web.kill('SIGTERM');await once(web,'exit');}
}

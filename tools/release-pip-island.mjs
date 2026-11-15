// RELEASE-2 (owner, 11 Oct 2026): Pip's island answers every time on the release build, signed in as the synthetic
// admin. A mouse resting on Pip shows today's summary and a click opens Pip's menu, 50 times in a row at 1440 (every
// other click comes straight from the page, the click a redrawn face once swallowed); a tap opens it 50 times at 390,
// with no hover-only summary. Each look checks what is on top at several points, not only what is in the DOM.
export async function pipIsland({newContext,closeContext,origin,width,out,environment}){
 const touch=width<500,ctx=await newContext(touch),page=await ctx.newPage(),pipErrors=[];page.on('pageerror',e=>pipErrors.push(e.message));
 await page.goto(origin+'/dashboard',{waitUntil:'load'});
 await page.waitForFunction(()=>{const b=document.querySelector('[data-island] [data-pip]');return !!b&&Object.keys(b).some(k=>k.startsWith('__reactProps'));},null,{timeout:30000});
 await page.waitForTimeout(500);
 const look=()=>page.evaluate(()=>{
  const all=document.querySelectorAll('[data-island]'),island=all[0],pip=island?.querySelector('[data-pip]');
  const covered=box=>{if(!box)return 'missing';const before=box.style.pointerEvents;box.style.pointerEvents='auto';const r=box.getBoundingClientRect();
   const hit=[[r.left+r.width/2,r.top+10],[r.left+10,r.top+r.height/2],[r.right-10,r.bottom-10]].map(([x,y])=>document.elementFromPoint(x,y)).find(h=>!h||!box.contains(h));
   box.style.pointerEvents=before;return r.right>innerWidth+1||r.bottom>innerHeight+1?'outside the window':hit===undefined?null:'covered';};
  const r=pip?.getBoundingClientRect(),top=r?document.elementFromPoint(r.left+r.width/2,r.top+r.height/2):null;
  return {islands:all.length,open:!!island?.hasAttribute('data-open'),pip:r&&r.width?{x:r.left+r.width/2,y:r.top+r.height/2}:null,pipOnTop:!!(top&&pip?.contains(top)),tip:covered(island?.querySelector('[role=tooltip]')),menu:covered(island?.querySelector('[role=menu]'))};});
 const until=async(ok,ms=2000)=>{const end=Date.now()+ms;let l=await look();while(!ok(l)&&Date.now()<end){await page.waitForTimeout(30);l=await look();}return l;};
 const press=(x,y)=>touch?page.touchscreen.tap(x,y):page.mouse.click(x,y);
 // "Away" is a spot that does nothing when pressed: the visible page heading. A fixed point can land on a control (on the
 // Focus home y 420 is a glance card, whose sheet then covers Pip); the old point stays as the fallback.
 const away=await page.evaluate(w=>{const h=[...document.querySelectorAll('main h1, h1')].find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight;});if(!h)return {x:Math.round(w/2),y:420};const r=h.getBoundingClientRect();return {x:Math.round(r.left+Math.min(40,r.width/2)),y:Math.round(r.top+Math.min(20,r.height/2))};},width);let hovered=0,opened=0;
 for(let i=0;i<50;i++){
  // Something real may arrive meanwhile (the island opens with it); it is dismissed the way a person would.
  if((await look()).open)await page.locator('[data-island] button[aria-label="Dismiss"]').click({timeout:5000}).catch(()=>{});
  let l=await until(x=>!x.open&&x.pip&&x.pipOnTop&&x.menu==='missing');
  if(l.islands!==1||!l.pip||!l.pipOnTop)throw Error(`Pip island ${width} #${i}: ${l.islands} island(s), Pip ${l.pip?'covered':'missing'}`);
  if(!touch){
   await page.mouse.move(away.x,away.y);l=await until(x=>x.tip==='missing');if(l.tip!=='missing')throw Error(`Pip island ${width} #${i}: the summary stayed after the pointer left`);
   if(i%2===0){await page.mouse.move(l.pip.x,l.pip.y,{steps:3});l=await until(x=>x.tip===null);if(l.tip!==null)throw Error(`Pip island ${width} #${i}: hover summary ${l.tip==='missing'?'never showed':l.tip}`);hovered++;}
  }
  await press(l.pip.x,l.pip.y);l=await until(x=>x.menu===null);
  if(l.menu!==null)throw Error(`Pip island ${width} #${i}: ${touch?'a tap':'a click'} ${l.menu==='missing'?'opened no menu':'opened a menu that is '+l.menu}`);
  if(touch&&l.tip!=='missing')throw Error(`Pip island ${width} #${i}: hover-only summary on touch`);
  opened++;
  if(i===0)await page.screenshot({path:`${out}/${environment}-pip-menu-${width}.png`});
  const how=['pip','escape','outside'][i%3];
  if(how==='pip')await press(l.pip.x,l.pip.y);else if(how==='escape')await page.keyboard.press('Escape');else await press(away.x,away.y);
  l=await until(x=>x.menu==='missing');if(l.menu!=='missing')throw Error(`Pip island ${width} #${i}: the menu did not close (${how})`);
 }
 if(pipErrors.length)throw Error('Pip island browser error: '+pipErrors[0].slice(0,100));
 await closeContext(ctx);
 return {screen:'pip-island',width,theme:'light',syntheticOnly:true,rounds:50,hovered,opened,input:touch?'touch':'mouse',passed:true};
}

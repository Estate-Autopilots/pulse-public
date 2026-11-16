import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { demoPayload } from '../../packages/companion/src/demo.js';

const channel='11111111-1111-4111-8111-111111111111';
const person='22222222-2222-4222-8222-222222222222';
const href=`/chats?channel=${channel}`;
const screenDir=process.env.R15B_WEB_SCREEN_DIR??'test-results/r15b-web';

// UX-NOTIFY (owner, 10 Oct 2026): no corner toasts and no corner companion. The bell opens the notification panel
// (full screen on a phone) and Pip's island in the top bar announces each arrival once, with its main action.
for(const theme of ['light','dark'] as const) for(const width of [1440,390]) {
  test(`web notifications: island arrival, panel and inline reply ${width} ${theme}`,async({page})=>{
    test.skip(Boolean(process.env.PULSE_REAL_SMOKE),'Synthetic Companion fixture uses the isolated test server');
    await page.setViewportSize({width,height:900});
    await page.setExtraHTTPHeaders({'Cf-Access-Authenticated-User-Email':'staff@example.test'});
    await page.addInitScript(t=>{localStorage.setItem('pulse.theme',t);},theme);
    let unread=2;
    const at=()=>new Date().toISOString();
    let rows=[{id:channel,title:'A new message is ready',href,kind:'chat',readAt:null as string|null,at:at(),pingAllowed:true}];
    const settings={dnd:false,quiet:false,start:'21:00',end:'08:00',timezone:'UTC',types:{}};
    const card=(id:string,title:string,body:string)=>({id,ids:[id],kind:'chat',eventType:'chat.message',title,body,href,at:at(),readAt:null,active:true,state:'open',group:'update',
      unread:1,channelId:channel,from:{id:person,name:'Synthetic colleague',photoAt:null},subject:{type:'chat',id:channel,title:'Leadership'},open:{label:'Open chat',href},
      actions:[{key:'reply',label:'Reply',tone:'primary',method:'POST',path:`/api/v0/chats/${channel}/messages`,body:{clientId:'new'},fields:[{key:'body',label:'Reply to Synthetic',type:'text'}],done:'Sent'}]});
    let cards=[card(channel,'Synthetic colleague wrote in Leadership','Can we review the plan?')];
    const sent:{body:string;clientId:string}[]=[];const read:string[][]=[];
    await page.route('**/api/v0/**',async route=>{
      const req=route.request(),path=new URL(req.url()).pathname.replace('/api/v0/','');
      let data:unknown;
      if(path==='companion')data=demoPayload('in',Date.now());
      else if(path==='companion/updates')data={person:{id:person,name:'Synthetic teammate'},settings,suppression:null,rows,counts:{chats:unread,inbox:unread?1:0,total:unread},cursor:at(),hasMore:false,page:null};
      else if(path==='companion/notification-settings')data={settings,webPushKey:null};
      else if(path==='notices')data={rows:cards,counts:{unread:cards.filter(c=>!c.readAt).length,action:0,mention:0,update:cards.length},dnd:false,today:{due:2,overdue:0}};
      else if(path==='notices/read'){read.push(req.postDataJSON().ids);cards=cards.map(c=>({...c,readAt:at()}));data={ok:true};}
      else if(path===`chats/${channel}/messages`&&req.method()==='POST'){sent.push(req.postDataJSON());data={id:crypto.randomUUID()};}
      else {await route.continue();return;}
      await route.fulfill({json:data});
    });
    const errors:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('/me');
    const bar=page.locator('header').first();
    const bell=page.getByRole('button',{name:'Notifications, 2 unread'});
    await expect(bell).toBeVisible();
    // The old corner companion and corner toasts are gone everywhere.
    await expect(page.getByRole('button',{name:/Open the Pulse companion/})).toHaveCount(0);
    await expect(page.locator('[class*="corner"]')).toHaveCount(0);
    // The arrival is announced once, with its main action (Reply), never "Open My desk". Pip floats free by default
    // (owner, 20 Oct 2026): its bubble opens beside it, whole inside the window and below the top bar.
    const island=page.locator('[data-island]');
    await expect(island).toHaveCount(1);
    await expect(island.getByRole('button',{name:'Reply'})).toBeVisible();
    await expect(island).toContainText('Synthetic colleague wrote in Leadership');
    await page.waitForTimeout(700);
    const box=await island.evaluate(el=>{const rs=[...el.querySelectorAll('*')].map(n=>n.getBoundingClientRect()).filter(r=>r.width&&r.height);
      return {x:Math.min(...rs.map(r=>r.left)),y:Math.min(...rs.map(r=>r.top)),right:Math.max(...rs.map(r=>r.right)),bottom:Math.max(...rs.map(r=>r.bottom))};});
    const head=(await bar.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);expect(box.right).toBeLessThanOrEqual(width+1);
    expect(box.y).toBeGreaterThanOrEqual(head.y+head.height-1);expect(box.bottom).toBeLessThanOrEqual(900+1);
    await mkdir(screenDir,{recursive:true});
    await page.screenshot({path:`${screenDir}/${width}-${theme}-island.png`});
    // Its Reply opens the panel on that card; the reply is sent from the panel without leaving the page.
    await island.getByRole('button',{name:'Reply'}).click();
    const panel=page.getByRole('dialog',{name:'Notifications'});
    await expect(panel).toBeVisible();
    const item=panel.getByRole('listitem').filter({hasText:'Can we review the plan?'});
    await expect(item).toBeVisible();
    // UI-POLISH (R121, intended change): a server without browser push says nothing about it in the bell.
    await expect(panel).not.toContainText('server activation');
    const pbox=(await panel.boundingBox())!;
    expect(pbox.x).toBeGreaterThanOrEqual(0);expect(pbox.x+pbox.width).toBeLessThanOrEqual(width+1);
    if(width<900)expect(pbox.width).toBeGreaterThanOrEqual(width-1);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:`${screenDir}/${width}-${theme}-panel.png`});
    await item.getByRole('button',{name:'Reply'}).click();
    await item.getByRole('textbox',{name:'Reply to Synthetic'}).fill('Synthetic web quick reply');
    await item.getByRole('button',{name:'Send',exact:true}).click();
    await expect(item).toContainText('Sent');
    expect(sent.map(s=>s.body)).toEqual(['Synthetic web quick reply']);
    expect(sent[0].clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(read).toEqual([[channel]]);
    await page.screenshot({path:`${screenDir}/${width}-${theme}-quick-reply.png`});
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(bell).toBeFocused();
    // A second arrival: the count follows, the island shows it, and its line opens the conversation.
    unread=1;rows=[{id:person,title:'A second work update is ready',href,kind:'chat',readAt:null,at:at(),pingAllowed:true}];
    cards=[card(person,'Synthetic colleague wrote in Leadership','A second work update is ready'),...cards];
    await expect(page.getByRole('button',{name:'Notifications, 1 unread'})).toBeVisible();
    const line=island.getByRole('button',{name:/A second work update is ready/});
    await expect(line).toBeVisible();
    await page.screenshot({path:`${screenDir}/${width}-${theme}-second-arrival.png`});
    await line.click();
    await expect(page).toHaveURL(new RegExp(`/chats\\?channel=${channel}`));
    expect(errors).toEqual([]);
  });
}

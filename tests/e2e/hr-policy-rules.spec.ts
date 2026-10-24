import {test,expect} from '@playwright/test';
// Real API/browser on/off activation is covered by test_hr_policy_rules.py + hr-rule-runner.mjs.
// This fixture suite proves that viewing/cancelling the HR confirmation UI never issues activation writes.
test('all proposals are off; opening and cancelling confirmation keeps them off',async({page})=>{
 await page.setExtraHTTPHeaders({'Cf-Access-Authenticated-User-Email':'hr@estateautopilots.com'});
 let writes=0;page.on('request',r=>{if(r.url().endsWith('/hr/rules/confirm')&&r.method()==='POST')writes++;});
 await page.goto('/hr?tab=policies&view=rules');
 await expect(page.getByText('Off — awaiting HR confirmation',{exact:true})).toHaveCount(8);
 const buttons=page.getByRole('button',{name:'Confirm and turn on',exact:true});await expect(buttons).toHaveCount(8);
 for(let i=0;i<8;i++){await buttons.nth(i).click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();}
 expect(writes).toBe(0);await expect(page.getByText('Off — awaiting HR confirmation',{exact:true})).toHaveCount(8);
 await page.setViewportSize({width:390,height:844});
 const overflowing=await page.evaluate(()=>Array.from(document.querySelectorAll('main *')).filter(el=>el.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(el=>({tag:el.tagName,class:el.className,width:el.getBoundingClientRect().width,text:el.textContent?.slice(0,60)})));
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),JSON.stringify(overflowing)).toBe(true);
});

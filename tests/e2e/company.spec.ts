import {expect,test} from '@playwright/test';
test.skip(!process.env.PULSE_REAL_SMOKE,'Uses authorised dev company imports');
test.beforeEach(async({page})=>{await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(process.env.PULSE_BASE_URL!).origin?route.continue({headers:{...route.request().headers(),'cf-access-authenticated-user-email':'admin@estateautopilots.com'}}):route.continue());});
for(const [path,title] of [['/tasks','Work'],['/review-data','Review data'],['/audit','Audit'],['/activity','Activity'],['/notifications','Notifications'],['/chats','Chats'],['/opshub','Ops Hub import'],['/shifts','Shifts']]){
 test(`${title} is available in the workbench`,async({page})=>{await page.goto(path);await expect(page.locator('main').getByRole('heading',{name:title,exact:true}).first()).toBeVisible();});
}
test('Task creation and bulk review drawers are usable without changing live data',async({page})=>{
 await page.goto('/tasks');await expect(async()=>{await page.getByRole('button',{name:'Create a task or a project',exact:true}).first().click();await expect(page.getByRole('dialog',{name:'Create'})).toBeVisible({timeout:1500});}).toPass();await page.getByRole('button',{name:'Task',exact:false}).first().click();await expect(page.getByRole('textbox',{name:'What needs doing'})).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog',{name:'New task'})).toHaveCount(0);
 await page.goto('/review-data?kind=project_pod');await expect(page.getByRole('button',{name:'Confirm all 90%+ pods'})).toBeVisible();await expect(page.getByRole('combobox',{name:'Bulk pod'})).toBeVisible();
});
test('Finance is restricted and flagged writes stay disabled',async({page})=>{
 // Assertions and test artifacts contain no financial source values.
 await page.goto('/money');await expect(page.locator('main').getByRole('heading',{name:'Money',exact:true})).toBeVisible();
 // Email lives in Chats (round 7A2); sending stays off until the Gmail send scope is authorised.
 await page.goto('/inbox');await expect(page).toHaveURL(/source=email/);const inbox=await page.request.get('/api/v0/inbox',{headers:{'cf-access-authenticated-user-email':'admin@estateautopilots.com'}});expect(inbox.ok()).toBe(true);expect((await inbox.json()).sendEnabled).toBe(false);
 await page.goto('/login');await expect(page.getByText('you can continue with it instead',{exact:false})).toBeVisible();
});

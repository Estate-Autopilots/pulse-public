import { expect, test } from '@playwright/test';
test.skip(!process.env.PULSE_REAL_SMOKE, 'Needs the live EA tenant');
test.beforeEach(async ({page}) => {
 await page.setExtraHTTPHeaders({'Cf-Access-Authenticated-User-Email':'admin@estateautopilots.com'});
 await page.setViewportSize({width:1280,height:720});
 test.setTimeout(60000);
});
async function fits(page: import('@playwright/test').Page) {
 await expect.poll(() => page.evaluate(() => {
  const doc=document.scrollingElement!;
  return doc.scrollHeight<=innerHeight+1&&doc.scrollWidth<=innerWidth+1&&[...document.querySelectorAll<HTMLElement>('main [data-pager-view]')].filter(x=>x.getClientRects().length&&!x.closest('[hidden]')).every(x=>x.scrollHeight<=x.clientHeight+3);
 })).toBe(true);
}
test('client cards reach the final record and adapt after sidebar collapse', async ({page})=>{
 await page.goto('/clients');
 const pager=page.locator('main [data-pager]').first();
 const count=pager.locator('[aria-live="polite"]');
 await expect(count).toContainText('of');const first=await count.textContent();
 await pager.getByRole('button',{name:'Next page'}).click();await expect(count).not.toHaveText(first!);
 await pager.getByRole('button',{name:'Next page'}).press('End');await expect(pager.getByRole('button',{name:'Next page'})).toBeDisabled();
 await fits(page);
 // The side panel opens only on very wide windows (round 6); where it is shown, collapsing it must keep the fit.
 const collapse=page.getByRole('button',{name:/Collapse sidebar/});if(await collapse.count()){await collapse.click();await page.waitForTimeout(400);await fits(page);}
 await page.setViewportSize({width:1920,height:1080});await page.waitForTimeout(400);await fits(page);
});
test('team card and list views support keyboard switching and reload', async ({page})=>{
 await page.goto('/people');
 await page.waitForLoadState('networkidle');
 await expect(page.locator('main [data-pager] [aria-live]').first()).toBeVisible({timeout:20000});
 await page.getByRole('button',{name:'Cards',exact:true}).press('ArrowRight');
 await expect(page).toHaveURL(/view=list/);
 await expect(page.getByRole('button',{name:'List',exact:true})).toBeFocused();
 await expect(page.locator('main table')).toBeVisible();await fits(page);
 await page.reload();await expect(page.getByRole('button',{name:'List',exact:true})).toHaveAttribute('aria-pressed','true');await fits(page);
 await page.setViewportSize({width:390,height:844});
 await page.locator('main section:has(table)').evaluate(el=>{el.scrollLeft=el.scrollWidth;});
 await expect(page.locator('main table thead th').last()).toBeInViewport();
 expect(await page.evaluate(()=>document.scrollingElement!.scrollWidth<=innerWidth)).toBe(true);
});
test('contacts fill the window and retain visible rows on the last page',async ({page})=>{
 await page.goto('/contacts');const pager=page.locator('main [data-pager]').first();
 await expect(page.locator('main tbody tr:visible').first()).toBeVisible();
 expect(await pager.locator('[data-pager-view]').evaluate(el=>el.clientHeight)).toBeGreaterThan(300);
 await expect(pager.locator('[aria-live]')).toContainText(/of \d+ contacts/);
 await pager.getByRole('button',{name:'Next page'}).press('End');
 await expect(page.locator('main tbody tr:visible').first()).toBeVisible();await fits(page);
});
test('mobile account header fits a full email identity', async ({page})=>{
 await page.setExtraHTTPHeaders({'Cf-Access-Authenticated-User-Email':'sales@estateautopilots.com'});
 await page.setViewportSize({width:390,height:844});await page.goto('/dashboard');
 await page.waitForLoadState('networkidle');
 await expect(page.getByRole('button',{name:'Open account menu'})).toBeVisible();
 expect(await page.evaluate(()=>document.scrollingElement!.scrollWidth<=innerWidth)).toBe(true);
 await page.goto('/projects');await expect(page.getByRole('heading',{name:'Client projects',exact:true,level:2})).toBeVisible({timeout:20000});
 expect(await page.evaluate(()=>document.scrollingElement!.scrollWidth<=innerWidth)).toBe(true);
});
test('board columns page independently',async ({page})=>{
 await page.goto('/projects');
 const pagers=page.locator('main [data-pager]');await expect(pagers.first().locator('[aria-live]')).toBeVisible({timeout:20000});
 const before=await pagers.locator('[aria-live]').allTextContents();
 await pagers.first().getByRole('button',{name:'Next page'}).click();
 await expect(pagers.first().locator('[aria-live]')).not.toHaveText(before[0]);
 expect((await pagers.locator('[aria-live]').allTextContents()).slice(1)).toEqual(before.slice(1));await fits(page);
});
test('month attendance keeps weekends and all dates while paging people',async ({page,request})=>{
 const data=await(await request.get('/api/v0/hr/attendance',{headers:{'Cf-Access-Authenticated-User-Email':'admin@estateautopilots.com'}})).json();
 await page.goto('/hr?tab=attendance&view=month');
 const matrix=page.locator('main table');await expect(matrix.locator('thead th')).toHaveCount(data.dates.length+1);
 for(const cell of await matrix.locator('thead [data-off]').all())await expect(cell).toBeVisible();
 const pager=page.locator('main [data-pager]').first();await pager.getByRole('button',{name:'Next page'}).click();
 await expect(matrix.locator('thead th')).toHaveCount(data.dates.length+1);await fits(page);
});
test('secondary views support arrows, sharing and reload',async ({page})=>{
 await page.goto('/settings');
 const views=page.getByRole('navigation',{name:'Views',exact:true});
 const selected=views.locator('[aria-current]');await selected.focus();await selected.press('ArrowLeft');
 await expect(page).toHaveURL(/section=/);const url=page.url();
 await expect(selected).toBeFocused();
 const text=await selected.textContent();await page.reload();await expect(page).toHaveURL(url);await expect(views.locator('[aria-current]')).toHaveText(text!);await fits(page);
});
// UX-5A: the one drawer scrolls its grouped sections under a fixed header and a sticky footer (no pages of fields).
test('edit drawers scroll their sections without losing entered values and restore focus',async ({page})=>{
 await page.goto('/people');const add=page.getByRole('button',{name:'Add member'});
 await expect(async()=>{if(!await add.isVisible())await page.getByRole('button',{name:/^More actions \(/}).click({timeout:1000});await add.click({timeout:1000});}).toPass();
 const drawer=page.getByRole('dialog',{name:'Add a team member'});await expect(drawer).toBeVisible();
 await drawer.getByRole('radio',{name:'No',exact:true}).check();
 const field=drawer.getByLabel(/Full name/);await field.fill('Unsubmitted browser check');
 const body=drawer.locator('[data-drawer-body]');
 await body.evaluate(el=>{el.scrollTop=el.scrollHeight;});await expect(drawer.getByRole('button',{name:'Create'})).toBeInViewport();
 await body.evaluate(el=>{el.scrollTop=0;});await expect(field).toHaveValue('Unsubmitted browser check');
 expect(await drawer.locator('section').count()).toBeGreaterThan(1);
 await page.keyboard.press('Escape');await expect(drawer).toHaveCount(0);await expect(add).toBeFocused();
});

// Preview/edit/cancel only on live dev: no salary, policies, budgets or financial rows are saved.
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
const out=process.env.PULSE_VISUAL_OUT;if(!out)throw new Error('Set a private PULSE_VISUAL_OUT');
const browser=await chromium.launch(),context=await browser.newContext({viewport:{width:1440,height:900},extraHTTPHeaders:{'cf-access-authenticated-user-email':'user-668d21b6@estateautopilots.com'}});
const page=await context.newPage(),errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:3200/money');await page.getByRole('button',{name:'Import statement',exact:true}).click();
 let dialog=page.getByRole('dialog',{name:'Import statement'});
 await dialog.locator('input[type=file]').setInputFiles({name:'synthetic-bank.csv',mimeType:'text/csv',buffer:Buffer.from('Date,Description,Debit,Credit,Account Number,Reference\n2026-10-01,Synthetic office supply,125,,123456789012,SYNTHETIC-REFERENCE\n')});
 await dialog.getByRole('button',{name:'Preview import',exact:true}).click();
 await dialog.getByText('Synthetic office supply').waitFor();
 assert.ok(!(await dialog.innerText()).includes('123456789012'));
 await dialog.getByRole('textbox',{name:'Category row 1'}).fill('Office');
 assert.equal(await dialog.getByRole('checkbox',{name:'Import row 1'}).isChecked(),true);
 await dialog.screenshot({path:out+'/statement-preview-synthetic.png'});
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();checks.push('Synthetic statement preview/category edit/cancel');
 await page.goto('http://127.0.0.1:3200/hr?tab=payroll');await page.getByRole('button',{name:'Add salary entry',exact:true}).click();
 dialog=page.getByRole('dialog',{name:'Add a salary entry'});
 assert.ok(await dialog.locator('select[name=personId]').evaluate(e=>e.required&&e.value===''&&e.options.length>1));
 for(const component of ['ctc','fixed','variable','bonus','reimbursements','deductions','effectiveFrom','effectiveTo'])assert.equal(await dialog.locator(`[name=${component}]`).count(),1);
 await dialog.screenshot({path:out+'/salary-components-empty.png'});await dialog.getByRole('button',{name:'Cancel',exact:true}).click();checks.push('Existing employee required + six components and dates');
 await page.goto('http://127.0.0.1:3200/hr?tab=policies');await page.getByRole('button',{name:'Write document',exact:true}).first().click();
 dialog=page.getByRole('dialog');await dialog.getByRole('textbox',{name:'Policy document',exact:true}).fill('Synthetic draft for editor verification only.');
 assert.equal(await dialog.locator('select[name=status]').inputValue(),'draft');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();checks.push('Policy authoring defaults to draft; cancel');
 // A real empty channel makes a screenshot without disclosing employee conversations.
 const response=await context.request.get('http://127.0.0.1:3203/api/v0/chats');const data=await response.json(),empty=data.channels.find(c=>!c.lastAt);
 assert.ok(empty,'A conversation without messages is available');
 await page.goto('http://127.0.0.1:3200/chats?source=team&channel='+empty.id);await page.getByRole('textbox',{name:'Write a message',exact:true}).waitFor();
 await page.waitForTimeout(500);assert.equal(await page.locator('article[id^="message-"]').count(),0);
 await page.screenshot({path:out+'/chats-safe-empty.png'});checks.push('Real empty team channel rendered without private message content');
 assert.deepEqual(errors,[]);await writeFile(out+'/workflow-receipts.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors}));
}finally{await browser.close();}

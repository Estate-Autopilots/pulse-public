import test from 'node:test';
import assert from 'node:assert/strict';
import {passwordError,base32,deviceLabel} from '../dist/auth-policy.js';
import {authMail,testMail} from '../dist/auth-mail.js';
import {googleBridge} from '../dist/google.js';
import {runWithCompany} from '../dist/tenant-context.js';
test('password policy uses UTF-8 bytes and local common list',()=>{
 assert.match(passwordError('1234567890'),/common/);assert.match(passwordError('password123'),/common/);
 // STAFF-UX: the messages name the rule in plain words; the limit is still counted in UTF-8 bytes (19 emoji = 76 bytes).
 assert.match(passwordError('a'.repeat(73)),/at most 72/);assert.match(passwordError('😀'.repeat(19)),/at most 72/);assert.equal(passwordError('Cedar river violet stone! '.repeat(3).slice(0,72)),null);
 assert.match(passwordError('short'),/at least 10/);assert.equal(passwordError('Cedar river violet stone!'),null);
});
test('authenticator base32 and device descriptions',()=>{assert.equal(base32('48656c6c6f'),'JBSWY3DP');assert.equal(deviceLabel('Mozilla/5.0 (iPhone) Safari/1'),'Safari · iOS');});
test('CI cannot send email even with sending enabled',async()=>{
 process.env.PULSE_CI='1';process.env.PULSE_GMAIL_SEND_ENABLED='1';
 assert.equal(await authMail('synthetic@example.test','Test','No production email'),true);
 assert.equal(testMail.at(-1).from,process.env.PULSE_MAIL_FROM?.trim().toLowerCase()||'pulse@mail.invalid');
 assert.equal(testMail.at(-1).to,'synthetic@example.test');assert.equal((await googleBridge('send',{to:'synthetic@example.test'})).id,'test-sink');
 delete process.env.PULSE_CI;
});
test('staging blocks non-HR/admin delivery',async()=>{
 const saved={...process.env};process.env.PULSE_GMAIL_SEND_ENABLED='1';process.env.PULSE_PUBLIC_URL='https://pulse-staging.estateautopilots.com';delete process.env.PULSE_CI;delete process.env.PULSE_AUTH_MAIL_MODE;
 assert.equal(await authMail('synthetic@example.test','Test','No production email'),false);
 assert.equal(await authMail('invalid','Test','x'),false);
 process.env.PULSE_PUBLIC_URL=saved.PULSE_PUBLIC_URL??'';
});
test('tenant hosts cannot use the install mailbox for auth mail, including SMTP',async()=>{
 const company={org:'tenant-org',signIn:'password',status:'active',rehearsal:false};
 const context={host:'tenant.example.test',company};
 const saved={PULSE_MAIL_TRANSPORT:process.env.PULSE_MAIL_TRANSPORT,PULSE_CI:process.env.PULSE_CI,PULSE_AUTH_MAIL_MODE:process.env.PULSE_AUTH_MAIL_MODE};
 process.env.PULSE_MAIL_TRANSPORT='smtp';delete process.env.PULSE_CI;delete process.env.PULSE_AUTH_MAIL_MODE;
 try{
  assert.equal(await runWithCompany(context,()=>authMail('synthetic@example.test','Test','No production email')),false);
  await assert.rejects(()=>runWithCompany(context,()=>googleBridge('send',{to:'synthetic@example.test'})),{statusCode:403});
 }finally{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

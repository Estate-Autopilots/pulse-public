import test from 'node:test';
import assert from 'node:assert/strict';
import {createECDH} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {webPushConfig} from '../dist/web-push-config.js';
test('browser enrolment requires readable matching VAPID keys, and never treats a partial config as ready',async()=>{
 const old={...process.env};const dir=await mkdtemp(join(tmpdir(),'pulse-push-'));
 try{
  delete process.env.PULSE_WEB_PUSH_PUBLIC_KEY;delete process.env.PULSE_WEB_PUSH_PRIVATE_KEY_FILE;
  assert.equal(await webPushConfig(),null);
  const pair=createECDH('prime256v1');pair.generateKeys();
  process.env.PULSE_WEB_PUSH_PUBLIC_KEY=pair.getPublicKey().toString('base64url');
  assert.equal(await webPushConfig(),null);
  process.env.PULSE_WEB_PUSH_PRIVATE_KEY_FILE=join(dir,'key');
  assert.equal(await webPushConfig(),null);
  await writeFile(process.env.PULSE_WEB_PUSH_PRIVATE_KEY_FILE,'bad',{mode:0o600});
  assert.equal(await webPushConfig(),null);
  // getPrivateKey() drops leading zero bytes (about 1 key in 256 is 31 bytes); a stored key is always 32 bytes.
  const raw=pair.getPrivateKey();
  await writeFile(process.env.PULSE_WEB_PUSH_PRIVATE_KEY_FILE,Buffer.concat([Buffer.alloc(32-raw.length),raw]).toString('base64url'));
  assert.equal((await webPushConfig()).publicKey,process.env.PULSE_WEB_PUSH_PUBLIC_KEY);
  const other=createECDH('prime256v1');other.generateKeys();
  process.env.PULSE_WEB_PUSH_PUBLIC_KEY=other.getPublicKey().toString('base64url');
  assert.equal(await webPushConfig(),null);
 }finally{
  for(const key of ['PULSE_WEB_PUSH_PUBLIC_KEY','PULSE_WEB_PUSH_PRIVATE_KEY_FILE']) {
   if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];
  }
  await rm(dir,{recursive:true,force:true});
 }
});

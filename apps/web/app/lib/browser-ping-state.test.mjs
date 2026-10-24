import test from 'node:test';
import assert from 'node:assert/strict';
import {browserPingStatus} from './browser-ping-state.mjs';
test('unsupported desktop webviews explain their capability instead of claiming missing server activation',()=>{
 assert.match(browserPingStatus({supported:false,webPushKey:null}),/does not support/);
 assert.match(browserPingStatus({supported:true,webPushKey:null}),/server activation/);
 assert.match(browserPingStatus({supported:true,webPushKey:'key',permission:'denied'}),/blocked/);
 assert.match(browserPingStatus({supported:true,webPushKey:'key',permission:'default'}),/Enable browser pings/);
 assert.equal(browserPingStatus({supported:true,webPushKey:'key',permission:'granted'}),null);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {chatAdapter} from '../dist/chat-adapters.js';
test('External transports are opt-in and webhook authentication fails closed',()=>{
 assert.equal(chatAdapter('telegram',{}),null);assert.equal(chatAdapter('whatsapp',{}),null);
 const telegram=chatAdapter('telegram',{PULSE_TELEGRAM_CHAT_ENABLED:'1',PULSE_TELEGRAM_WEBHOOK_SECRET:'synthetic-secret'});
 assert.equal(telegram.verify(Buffer.alloc(0),'wrong'),false);assert.equal(telegram.verify(Buffer.alloc(0),'synthetic-secret'),true);
 assert.deepEqual(telegram.messages({edited_message:{message_id:1}}),[]);
 assert.equal(telegram.messages({message:{message_id:1,date:1791200000,chat:{id:12},from:{id:34},text:'Synthetic hello'}})[0].senderRef,'34');
 const whatsapp=chatAdapter('whatsapp',{PULSE_WHATSAPP_CHAT_ENABLED:'1',PULSE_WHATSAPP_APP_SECRET:'synthetic-secret'}),raw=Buffer.from('{"synthetic":true}');
 const signature='sha256='+createHmac('sha256','synthetic-secret').update(raw).digest('hex');
 assert.equal(whatsapp.verify(raw,signature),true);assert.equal(whatsapp.verify(Buffer.from('{}'),signature),false);
 assert.deepEqual(whatsapp.messages({entry:[{changes:[{value:{statuses:[{id:'receipt'}]}}]}]}),[]);
 const messages=whatsapp.messages({entry:[{changes:[{value:{metadata:{phone_number_id:'synthetic-number'},messages:[{id:'message1',from:'synthetic-recipient',timestamp:'1791200000',type:'image',image:{id:'private-media'}}]}}]}]});
 assert.equal(messages[0].kind,'unsupported');assert.equal(JSON.stringify(messages).includes('private-media'),false);
});

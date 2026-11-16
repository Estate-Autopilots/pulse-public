import {createHmac,timingSafeEqual} from 'node:crypto';
// Provider ingress contracts. Registration/persistence requires verified participant mapping.
// No provider payload, token or phone number belongs in a Pulse audit event.
type ObjectValue=Record<string,unknown>;
const object=(x:unknown):ObjectValue=>x&&typeof x==='object'?x as ObjectValue:{};
const list=(x:unknown):unknown[]=>Array.isArray(x)?x:[];
const equal=(a:string,b:string)=>{const left=Buffer.from(a),right=Buffer.from(b);return !!left.length&&left.length===right.length&&timingSafeEqual(left,right);};
export type ExternalMessage={provider:'telegram'|'whatsapp';externalId:string;conversationRef:string;senderRef:string;at:string;text:string;kind:'text'|'unsupported'};
export type ChatAdapter={provider:ExternalMessage['provider'];verify:(raw:Buffer,signature:string)=>boolean;messages:(payload:unknown)=>ExternalMessage[]};
function at(raw:unknown){const n=Number(raw),date=new Date(n*1000);return Number.isFinite(n)&&n>0&&Number.isFinite(date.getTime())?date.toISOString():null;}
export function chatAdapter(provider:ExternalMessage['provider'],env:NodeJS.ProcessEnv=process.env):ChatAdapter|null{
 if(provider==='telegram'){
  if(env.PULSE_TELEGRAM_CHAT_ENABLED!=='1')return null;
  return {provider,verify:(_raw,secret)=>equal(secret,env.PULSE_TELEGRAM_WEBHOOK_SECRET??''),messages:payload=>{
   const update=object(payload),m=object(update.message),chat=object(m.chat),from=object(m.from),date=at(m.date);
   // Edits, bot messages and unsupported updates never invent employee identities.
   if(!date||!m.message_id||!chat.id||!from.id||from.is_bot)return [];
   return [{provider,externalId:String(m.message_id),conversationRef:String(chat.id),senderRef:String(from.id),at:date,text:typeof m.text==='string'?m.text.slice(0,12000):'',kind:typeof m.text==='string'?'text':'unsupported'}];
  }};
 }
 if(env.PULSE_WHATSAPP_CHAT_ENABLED!=='1')return null;
 return {provider,verify:(raw,signature)=>!!env.PULSE_WHATSAPP_APP_SECRET&&equal(signature,'sha256='+createHmac('sha256',env.PULSE_WHATSAPP_APP_SECRET).update(raw).digest('hex')),messages:payload=>{
  const result:ExternalMessage[]=[];
  for(const entry of list(object(payload).entry))for(const change of list(object(entry).changes)){
   const v=object(object(change).value),number=object(v.metadata).phone_number_id;
   for(const item of list(v.messages)){const m=object(item),date=at(m.timestamp),text=object(m.text).body;
    if(!number||!m.id||!m.from||!date)continue;
    result.push({provider,externalId:String(m.id),conversationRef:String(number)+':'+String(m.from),senderRef:String(m.from),at:date,text:m.type==='text'&&typeof text==='string'?text.slice(0,12000):'',kind:m.type==='text'&&typeof text==='string'?'text':'unsupported'});
   }
  }return result;
 }};
}

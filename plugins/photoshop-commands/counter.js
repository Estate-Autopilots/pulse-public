const {action}=require('photoshop');
const map={make:'other_edit',set:'effects_colour',delete:'cut_trim',move:'select_move',transform:'select_move',select:'select_move',undo:'undo_redo',redo:'undo_redo',save:'export_render'};
let counts={},token='',enabled=false,timer,gateTimer,gate={allowed:false,epoch:''};
const status=message=>{document.getElementById('status').textContent=message;};
async function refreshGate(){
 const currentToken=token;
 try{const r=await fetch('http://127.0.0.1:47831/state',{headers:{'X-Pulse-Bridge-Token':currentToken}});if(!r.ok)throw Error('unavailable');const next=await r.json();if(!enabled||token!==currentToken)return;
  if(!next.allowed||next.epoch!==gate.epoch)counts={};gate=next;status(gate.allowed?'Counting named editing events':'Pulse paused or outside tracking scope · no collection');
 }catch{gate={allowed:false,epoch:''};counts={};status('Tracker unavailable · optional counts discarded');}
}
function listener(event){if(enabled&&gate.allowed&&map[event])counts[map[event]]=(counts[map[event]]??0)+1;}
document.getElementById('connect').addEventListener('click',async()=>{
 if(enabled)return;token=document.getElementById('token').value;document.getElementById('token').value='';if(!/^[a-f0-9]{64}$/.test(token))return;
 enabled=true;await refreshGate();await action.addNotificationListener(Object.keys(map),listener);gateTimer=setInterval(refreshGate,10000);
 timer=setInterval(async()=>{
  await refreshGate();if(!enabled||!gate.allowed||!Object.keys(counts).length)return;const sent=counts,epoch=gate.epoch;counts={};
  try{const r=await fetch('http://127.0.0.1:47831/commands',{method:'POST',headers:{'content-type':'application/json','X-Pulse-Bridge-Token':token},body:JSON.stringify({app:'photoshop',epoch,counts:sent})});if(!r.ok)throw Error('rejected');}
  catch{status('Tracker changed or unavailable · optional counts discarded');}
 },3600000);
});
document.getElementById('pause').addEventListener('click',()=>{enabled=false;counts={};gate={allowed:false,epoch:''};token='';clearInterval(timer);clearInterval(gateTimer);action.removeNotificationListener(Object.keys(map),listener);status('Paused');});

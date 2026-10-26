import {PHASES,type Task,type Edge} from './delivery-types.js';
export type Interval={start:string;end:string};
const ms=(s:string)=>{const n=Date.parse(s);if(!/[TZ]/.test(s)||!/(Z|[+-]\d{2}:\d{2})$/.test(s)||!Number.isFinite(n))throw Error('A valid timestamp with timezone is required');return n;};
export function union(intervals:Interval[]):[number,number][]{
 const sorted=intervals.map(i=>[ms(i.start),ms(i.end)] as [number,number]).sort((a,b)=>a[0]-b[0]);if(sorted.some(([s,e])=>e<s))throw Error('Invalid interval');
 const merged:[number,number][]=[];for(const [start,end] of sorted){const prev=merged.at(-1);if(prev&&start<=prev[1])prev[1]=Math.max(end,prev[1]);else merged.push([start,end]);}return merged;
}
export function workClock(calendar:Interval[],blockers:Interval[],from:string,to:string){
 const start=ms(from),end=ms(to);if(end<start)throw Error('Invalid work range');const clip=(i:[number,number])=>[Math.max(start,i[0]),Math.min(end,i[1])] as [number,number];
 const work=union(calendar).map(clip).filter(([s,e])=>e>s),blocked=union(blockers).map(clip).filter(([s,e])=>e>s);
 let scheduled=0,paused=0;for(const [s,e] of work){scheduled+=e-s;for(const [bs,be] of blocked)paused+=Math.max(0,Math.min(e,be)-Math.max(s,bs));}
 return {scheduledMinutes:scheduled/60000,blockedMinutes:paused/60000,workMinutes:(scheduled-paused)/60000,elapsedMinutes:(end-start)/60000};
}
export function validateGraph(tasks:Pick<Task,'id'|'parentId'>[],edges:Edge[]){
 const ids=new Set(tasks.map(t=>t.id));const walk=(relations:{from:string;to:string}[])=>{const visiting=new Set<string>(),done=new Set<string>();function visit(id:string){if(visiting.has(id))throw Error('Cyclic dependency');if(done.has(id))return;visiting.add(id);for(const e of relations.filter(e=>e.from===id)){if(!ids.has(e.to)||e.from===e.to)throw Error('Unavailable dependency');visit(e.to);}visiting.delete(id);done.add(id);}for(const e of relations)if(!ids.has(e.from))throw Error('Unavailable dependency');for(const id of ids)visit(id);};
 walk(edges);walk(tasks.filter(t=>t.parentId).map(t=>({from:t.parentId!,to:t.id})));return true;
}
export function criticalPath(tasks:Task[],edges:Edge[],sourceHealth:string){
 if(sourceHealth!=='available')return {enabled:false,reason:'Forecast disabled: source evidence unavailable',range:null,evidence:[]};validateGraph(tasks,edges);
 const duration=new Map<string,[number,number]>();const path=(id:string):[number,number]=>{if(duration.has(id))return duration.get(id)!;const t=tasks.find(x=>x.id===id)!;let low=0,high=0;for(const e of edges.filter(e=>e.to===id&&e.required)){const r=path(e.from);low=Math.max(low,r[0]);high=Math.max(high,r[1]);}const r:[number,number]=[low+(t.state==='accepted'?0:t.effort[0]),high+(t.state==='accepted'?0:t.effort[1])];duration.set(id,r);return r;};
 let low=0,high=0;for(const t of tasks){const r=path(t.id);low=Math.max(low,r[0]);high=Math.max(high,r[1]);}
 return {enabled:true,reason:'Dependency duration range; convert with the agreed calendar. Uncalibrated planning range, external waits unbounded.',range:[low,high],evidence:tasks.filter(t=>t.state!=='accepted').map(t=>({task:t.id,duration:t.effort,basis:t.confidence,missingInput:t.blockers.filter(b=>!b.end).map(b=>b.evidence)}))};
}
export function planSteps(kind:string){
 if(!['video_only','ads_only','full'].includes(kind))throw Error('Choose a supported package');
 const steps=[{key:'handover',title:'Confirm scope authority and folder access',phase:PHASES[0],parents:[],effort:[1,2]},
 {key:'blueprint',title:'Research personas positioning and approved Blueprint',phase:PHASES[1],parents:['handover'],effort:[7,10]},
 {key:'brand',title:'Parallel access and brand track',phase:PHASES[1],parents:['handover'],effort:[7,15]},
 ...(kind!=='ads_only'?[{key:'shoot',title:'Verify site talent permissions and shoot readiness',phase:PHASES[2],parents:['blueprint'],effort:[1,3]},{key:'footage',title:'Accept footage against shoot evidence',phase:PHASES[2],parents:['shoot'],effort:[1,2]},{key:'edit',title:'Produce exact reviewed video version',phase:PHASES[2],parents:['footage'],effort:[2,4]}]:[]),
 {key:'image',title:'Parallel image asset and design QA',phase:PHASES[2],parents:['blueprint'],effort:[1,3]},
 ...(kind!=='video_only'?[{key:'launch',title:'Campaign CRM media funding and launch handoff',phase:PHASES[3],parents:['image',...(kind==='full'?['edit']:[])],effort:[2,4]}]:[]),
 {key:'sales',title:'Verified buyer objections and bounded sales experiment',phase:PHASES[4],parents:kind==='video_only'?['edit']:['launch'],effort:[2,5]},
 {key:'recurring',title:'New evidence and reviewed scope revision',phase:PHASES[5],parents:['sales'],effort:[1,3]}];return steps;
}
export function relativeWorkingDate(intervals:Interval[],start:string,days:number){if(!Number.isInteger(days)||days<0)throw Error('Working-day count required');const after=ms(start),dates=[...new Set(intervals.filter(i=>ms(i.start)>=after).sort((a,b)=>ms(a.start)-ms(b.start)).map(i=>i.start.slice(0,10)))];return dates[days]??null;}
export function datePreview(tasks:Task[],edges:Edge[],id:string,date:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date)))throw Error('Valid plan date required');const found=new Set([id]);let changed=true;while(changed){changed=false;for(const e of edges.filter(e=>e.required))if(found.has(e.from)&&!found.has(e.to)){found.add(e.to);changed=true;}}return tasks.filter(t=>found.has(t.id)).map(t=>({taskId:t.id,title:t.title,baseline:t.baseline,current:t.due,proposed:t.id===id?date:null,commitment:t.committed,approvalRequired:!!t.committed,reason:t.id===id?'Proposed plan date':'Dependent date must be reviewed with the working calendar'}));}
// Disabled orchestration seam. Imported document text is data, never executable policy/tool authority.
export class AgentContract {
 readonly enabled=false;private leases=new Map<string,{run:string;expires:number;input:string;budget:number;spent:number}>();private receipts=new Map<string,{task:string;input:string;artifact:string}>();
 checkout(task:string,run:string,input:string,budget:number,now:number,allowed:boolean){if(!allowed||budget<=0||!Number.isFinite(budget))throw Error('Project permission and approved model budget required');const lease=this.leases.get(task);if(lease&&lease.expires>now)throw Error('Task already checked out');this.leases.set(task,{run,expires:now+60000,input,budget,spent:0});return {expires:now+60000};}
 draft(task:string,run:string,input:string,artifact:string,cost:number,now:number,allowed:boolean){const replay=this.receipts.get(run);if(!allowed)throw Error('Project permission revoked');if(replay){if(replay.task!==task||replay.input!==input||replay.artifact!==artifact)throw Error('Receipt replay changed');return {draft:true,replayed:true};}const l=this.leases.get(task);if(!l||l.run!==run||l.expires<=now||l.input!==input||!Number.isFinite(cost)||cost<0||l.spent+cost>l.budget)throw Error('Lease input or budget invalid');l.spent+=cost;this.receipts.set(run,{task,input,artifact});this.leases.delete(task);return {draft:true,humanReviewRequired:true};}
 action(action:string){if(!['prepare_checklist','draft_evidence_brief','propose_source_match','inspect_permitted_asset'].includes(action))throw Error('Action is outside approved draft tools');return {draft:true,untrustedDocuments:true};}
}
export function timeReport(tasks:Task[],events:{taskId:string;kind:string;at:string}[],calendar:Interval[]|undefined,operational:{approvedBlockers:{task_id:string;started_at:string;ended_at:string|null}[];policies:{taskId:string;body:{intervals:Interval[]}}[];clientWindows:{taskId:string;start:string;end:string|null}[]},now:string){
 return tasks.map(t=>{const history=events.filter(e=>e.taskId===t.id).sort((a,b)=>ms(a.at)-ms(b.at));let creator=0,review=0;const blockers=operational.approvedBlockers.filter(b=>b.task_id===t.id).map(b=>({start:b.started_at,end:b.ended_at??now}));for(let i=0;i<history.length;i++){const e=history[i],end=history.slice(i+1).find(n=>['ready','in_progress','ready_for_review','accepted','cancelled','client_change'].includes(n.kind))?.at??now;if(e.kind==='in_progress'&&calendar)creator+=workClock(calendar,blockers,e.at,end).workMinutes;if(e.kind==='ready_for_review'){const reviewerCalendar=operational.policies.find(p=>p.taskId===t.id)?.body.intervals;if(reviewerCalendar)review+=workClock(reviewerCalendar,blockers,e.at,end).workMinutes;}}
 const waits=operational.clientWindows.filter(w=>w.taskId===t.id);return {taskId:t.id,creatorWorkMinutes:calendar?creator:null,reviewerWaitMinutes:operational.policies.some(p=>p.taskId===t.id)?review:null,clientWaitElapsedMinutes:waits.reduce((n,w)=>n+(ms(w.end??now)-ms(w.start))/60000,0),overallElapsedMinutes:history.length?(ms(history.at(-1)?.kind==='accepted'?history.at(-1)!.at:now)-ms(history[0].at))/60000:null,basis:'Creator/reviewer use assigned intervals and approved blocker unions. Client wait is elapsed; commitments stay unchanged.'};});
}
export function accountabilityReceipts(events:{id:string;taskId:string;kind:string;at:string;snapshot:Record<string,unknown>}[]){
 const credited=new Set<string>();return events.filter(e=>e.kind==='accepted').map(e=>{const version=String(e.snapshot.version??''),key=e.taskId+':'+version,credit=!!version&&!credited.has(key);if(credit)credited.add(key);return {receiptId:e.id,taskId:e.taskId,versionId:version||null,acceptedAt:e.at,ownerId:e.snapshot.ownerId,assigneeId:e.snapshot.assigneeId,reviewerId:e.snapshot.reviewerId,baseline:e.snapshot.baseline,committed:e.snapshot.committed,due:e.snapshot.due,creditKey:credit?key:null,reason:e.snapshot.reason??null,basis:version?'One task/version credit; collaborators remain role intervals':'Acceptance gate; no deliverable completion credit'};});
}

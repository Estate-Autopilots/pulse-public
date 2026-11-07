export const purposes = ['activity_context','work_evidence','command_counts','work_sites','shoot_presence','declarations'] as const;
export type Purpose = typeof purposes[number];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (x:unknown): x is string => typeof x==='string' && uuid.test(x);
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const exact=(d:Record<string,unknown>,keys:string[])=>Object.keys(d).every(k=>keys.includes(k));
const n=(v:unknown,max:number)=>Number.isInteger(v)&&Number(v)>=0&&Number(v)<=max;
export function validateEvent(raw:unknown): {id:string;deviceId:string;personId:string;purpose:Purpose;kind:string;at:string;projectId:string|null;data:Record<string,unknown>} {
 if(!object(raw)||!exact(raw,['id','deviceId','personId','purpose','kind','at','projectId','data'])||!isId(raw.id)||!isId(raw.deviceId)||!isId(raw.personId)||!purposes.includes(raw.purpose as Purpose)||!object(raw.data))throw Error('Invalid event envelope');
 const at=Date.parse(String(raw.at));if(!Number.isFinite(at)||at>Date.now()+300000||at<Date.now()-7*86400000)throw Error('Events must be within the last seven days');
 if(raw.projectId!==undefined&&raw.projectId!==null&&!isId(raw.projectId))throw Error('Invalid project');
 const d=raw.data;let ok=false;const kind=String(raw.kind);let expected:Purpose='declarations';
 if(kind==='usage'){expected='activity_context';ok=exact(d,['activeSeconds','idleSeconds','tool'])&&n(d.activeSeconds,3600)&&n(d.idleSeconds,3600)&&Number(d.activeSeconds)+Number(d.idleSeconds)<=3600&&['premiere','photoshop','after_effects','resolve','figma','browser','office'].includes(String(d.tool));}
 if(kind==='render'){expected='work_evidence';ok=exact(d,['sha256','md5','bytes','cid'])&&/^[a-f0-9]{64}$/.test(String(d.sha256))&&/^[a-f0-9]{32}$/.test(String(d.md5))&&n(d.bytes,Number.MAX_SAFE_INTEGER)&&(d.cid===null||/^EA\d{4,8}-[A-Z0-9]{2,16}$/.test(String(d.cid)));}
 if(kind==='work_delta'){expected='work_evidence';ok=exact(d,['fingerprint','added','removed','changed','baseline'])&&/^[a-f0-9]{64}$/.test(String(d.fingerprint))&&typeof d.baseline==='boolean'&&['added','removed','changed'].every(k=>object(d[k])&&exact(d[k],['clips','effects','markers','keyframes','sequences'])&&Object.values(d[k]).every(x=>n(x,1000000)));}
 if(kind==='commands'){expected='command_counts';ok=exact(d,['app','counts'])&&['premiere','photoshop','after_effects'].includes(String(d.app))&&object(d.counts)&&exact(d.counts,['cut_trim','select_move','playback_navigate','effects_colour','audio','titles_graphics','markers','undo_redo','export_render','other_edit'])&&Object.values(d.counts).every(x=>n(x,1000000));}
 if(kind==='site'){expected='work_sites';ok=exact(d,['domain','seconds','resource'])&&typeof d.domain==='string'&&/^[a-z0-9.-]{1,253}$/.test(d.domain)&&n(d.seconds,3600)&&(d.resource===null||/^[A-Za-z0-9_-]{1,100}$/.test(String(d.resource)));}
 if(kind==='shoot'){expected='shoot_presence';ok=exact(d,['shootId','inside','method','transition','accuracyClass','confirmed','dwellSeconds'])&&isId(d.shootId)&&['declared','geofence','foreground'].includes(String(d.method))&&(typeof d.inside==='boolean'||d.inside===null)&&(!d.transition||['started','wrapped','presence'].includes(String(d.transition)))&&(d.method!=='foreground'||(d.confirmed===true&&d.inside===true&&d.accuracyClass==='site_precision'&&n(d.dwellSeconds,300)&&Number(d.dwellSeconds)>=30));}
 if(!ok||raw.purpose!==expected)throw Error('Unsupported event fields or consent purpose');
 return {id:raw.id,deviceId:raw.deviceId,personId:raw.personId,purpose:expected,kind,at:new Date(at).toISOString(),projectId:raw.projectId as string??null,data:d};
}

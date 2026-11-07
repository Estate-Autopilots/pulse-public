import {digest} from './intelligence-model.js';
export type Assertion={id:string;entity_type:string;entity_id:string;kind:string;value:string;verified:boolean;shared:boolean;source_scope:string;source_ref:string;source_family:string};
export type Identity={id:string;name:string;kind:string;legalOrgId:string|null;assertions:Assertion[]};
export const normalizeIdentity=(v:string)=>v.normalize('NFKC').toLocaleLowerCase('und').replace(/[^\p{L}\p{M}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
export function compareIdentity(a:Identity,b:Identity) {
 const supporting:string[]=[],conflicting:string[]=[],families=new Set<string>();
 if(a.kind!==b.kind||a.kind==='unknown'||b.kind==='unknown')conflicting.push('Entity kinds must be confirmed and equal.');
 if(a.legalOrgId&&b.legalOrgId&&a.legalOrgId!==b.legalOrgId)conflicting.push('Confirmed legal organisations differ.');
 for(const x of a.assertions.filter(x=>x.verified))for(const y of b.assertions.filter(x=>x.verified)) {
  if(x.kind!==y.kind||x.source_scope!==y.source_scope)continue;
  if(x.kind==='external_id'&&x.value!==y.value)conflicting.push(`Verified ${x.source_scope} identifiers conflict.`);
  if(x.value===y.value&&['external_id','organization','email','phone'].includes(x.kind)) {
   if(x.shared||y.shared){supporting.push(`Shared ${x.kind} is context only; it does not establish identity.`);continue;}
   const family=[x.source_family,y.source_family].sort().join(':');
   if(!families.has(family)){families.add(family);supporting.push(`Verified ${x.kind} agrees within ${x.source_scope}.`);}
  }
 }
 const strong=a.assertions.some(x=>x.verified&&!x.shared&&(x.kind==='external_id'||a.kind==='company'&&x.kind==='organization')&&b.assertions.some(y=>y.verified&&!y.shared&&x.kind===y.kind&&x.source_scope===y.source_scope&&x.value===y.value));
 const contact=a.assertions.some(x=>x.verified&&!x.shared&&['email','phone'].includes(x.kind)&&b.assertions.some(y=>y.verified&&!y.shared&&x.kind===y.kind&&x.source_scope===y.source_scope&&x.value===y.value));
 const sameName=normalizeIdentity(a.name)===normalizeIdentity(b.name),incomplete=[a.name,b.name].some(n=>normalizeIdentity(n).split(' ').length<2);
 const orgContext=a.assertions.some(x=>x.verified&&!x.shared&&x.kind==='organization'&&b.assertions.some(y=>y.verified&&!y.shared&&y.kind===x.kind&&y.source_scope===x.source_scope&&y.value===x.value));
 const candidate=strong||contact||(orgContext&&sameName&&!incomplete);
 return {candidate,mergeBlocked:!!conflicting.length,supporting:[...new Set(supporting)],conflicting:[...new Set(conflicting)],warnings:[...(incomplete?['Single-token name: incomplete identity; never a match by itself.']:[]),...(!candidate?['Name alone is unresolved; obtain a verified identifier or confirmed organisation.']:[]),...(sameName?['Name agreement is context only.']:[])],confidence:'Explainable rule; not a calibrated probability',evidenceVersion:digest([a.kind,b.kind,a.legalOrgId,b.legalOrgId,[...a.assertions,...b.assertions].map(x=>[x.id,x.kind,x.value,x.verified,x.shared,x.source_scope,x.source_family]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))])};
}

/** Selected receipts are pointers, never pasted narrative or executable URLs. */
export function validIdentitySourceRef(ref:string){if(!ref||ref.length>300||/[\s<>]/.test(ref)||ref.startsWith('//'))return false;if(ref.startsWith('/'))return true;try{const u=new URL(ref);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}}

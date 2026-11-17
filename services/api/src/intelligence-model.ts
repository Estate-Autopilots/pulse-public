import { createHash } from 'node:crypto';
export const RULE_VERSION = 'pulse-evidence-1';
export const digest = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export type Fact = { id: string; source_ref: { kind: string; id: string; href: string }; occurred_at: string | null; observed_at: string; subject_ref: string; classification: 'work' | 'identity' | 'hr' | 'finance_metadata'; freshness: 'current' | 'stale' | 'unknown'; override_version: string; statement: string };
export type Insight = { id: string; org_id: string; subject_refs: string[]; audience_scope: string; rule_or_model_version: string; window: { from: string | null; to: string }; as_of: string; facts: Fact[]; headline: string; meaning: string; hypotheses: string[]; next_action: { label: string; href: string; owner: string | null; authority: string; effect: string }; evidence_refs: string[]; sample_n: number; coverage: string; confidence_kind: 'deterministic'; confidence_label: 'Confirmed fact' | 'Interpretation' | 'Hypothesis'; interval: null; expires_at: string; lifecycle: string; supersedes_id: string | null; baseline: string; exclusions: string[]; correction_href: string; cause_key: string; severity: number; urgency: number; actionability: number; evidence_strength: number; surface: string };
export type Candidate = Omit<Insight,'id'|'org_id'|'audience_scope'|'rule_or_model_version'|'evidence_refs'|'as_of'|'expires_at'|'lifecycle'|'supersedes_id'|'window'|'interval'|'confidence_kind'>;
export function makeInsight(org: string, viewer: string, c: Candidate, now: string): Insight {
 // Time of render is not part of receipt identity; evidence versions and typed claims are.
 const id = digest([org,viewer,RULE_VERSION,c.cause_key,c.facts,c.headline,c.meaning,c.hypotheses,c.next_action,c.coverage]);
 return {...c,id,org_id:org,audience_scope:`person:${viewer}`,rule_or_model_version:RULE_VERSION,window:{from:c.facts[0]?.occurred_at??null,to:now},as_of:now,evidence_refs:c.facts.map(f=>f.id),confidence_kind:'deterministic',interval:null,expires_at:new Date(Date.parse(now)+3600000).toISOString(),lifecycle:'active',supersedes_id:null};
}
export function rank(cards: Insight[]) {
 const unique = new Map<string,Insight>();
 for(const c of cards) unique.set(c.cause_key,c);
 const score=(c:Insight)=>c.severity*4+c.actionability*3+c.urgency*2+c.evidence_strength+Math.min(...c.facts.map(f=>f.freshness==='current'?2:f.freshness==='stale'?1:0),2);
 return [...unique.values()].sort((a,b)=>score(b)-score(a)||a.id.localeCompare(b.id));
}
/** Any narrative extension must submit exact authorized claim references. Free-form factual text is rejected.
 * No model is wired in this round. This gate is deliberately narrower than semantic claim matching. */
export function validatedNarrative(card: Insight, proposed: unknown, enabled = false) {
 if(!enabled||!proposed||typeof proposed!=='object') return {headline:card.headline,meaning:card.meaning,renderer:'deterministic'};
 const p=proposed as {headline?:unknown;meaning?:unknown;fact_ids?:unknown};
 const known=new Set(card.facts.map(f=>f.id));
 if(p.headline!==card.headline||p.meaning!==card.meaning||!Array.isArray(p.fact_ids)||p.fact_ids.length!==known.size||new Set(p.fact_ids).size!==known.size||p.fact_ids.some(id=>!known.has(id)))return {headline:card.headline,meaning:card.meaning,renderer:'deterministic'};
 return {headline:card.headline,meaning:card.meaning,renderer:'validated'};
}
export function workingDaysLate(due: string, now: string, timezone: string, days: number[], holidays: string[]) {
 const date=(t:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone}).format(new Date(t));
 const start=date(due),end=date(now); let n=0;
 for(let d=new Date(start+'T12:00:00Z');d.toISOString().slice(0,10)<end;d=new Date(d.getTime()+86400000)) {
  const next=new Date(d.getTime()+86400000),key=next.toISOString().slice(0,10),dow=next.getUTCDay()||7;
  if(days.includes(dow)&&!holidays.includes(key))n++;
 }
 return n;
}
export const SURFACES: Record<string,{ label:string; action:string; href:string; caveat:string; domain:string }> = {
 demo:{label:'Synthetic evidence lab',action:'Inspect the synthetic examples',href:'/insights-demo',caveat:'Wholly synthetic examples demonstrate evidence and reviewed actions; no organisation record changes.',domain:'personal'},
 dashboard:{label:'Today’s handoff',action:'Open assigned work',href:'/tasks?mine=1',caveat:'Launch dependencies and explicit approval agreements are only known when recorded.',domain:'work'},
 projects:{label:'Project readiness',action:'Inspect project inputs',href:'/projects',caveat:'Accepted inputs, phase readiness and client decisions need explicit records.',domain:'work'},
 tasks:{label:'Review commitments',action:'Open review queue',href:'/tasks?status=in_review',caveat:'Imported deadline labels do not establish agreed review deadlines.',domain:'work'},
 clients:{label:'Client identity',action:'Review client master',href:'/clients?tab=master',caveat:'Legal identity, relationship owner and renewal terms need confirmation.',domain:'identity'},
 contacts:{label:'Contact identity',action:'Complete contact identity',href:'/contacts/identity',caveat:'A name alone cannot establish a duplicate identity.',domain:'identity'},
 map:{label:'Location precision',action:'Verify a location',href:'/map',caveat:'Locality and city pins cannot establish shoot-site readiness.',domain:'work'},
 people:{label:'Delivery credit',action:'Inspect credit evidence',href:'/people?tab=tracking',caveat:'Shared logins and missing attribution do not establish individual delivery credit.',domain:'work'},
 me:{label:'Personal capacity',action:'Review availability',href:'/me',caveat:'Capacity requires effective shift and approved leave records; missing check-in is not inactivity.',domain:'personal'},
 hr:{label:'HR decisions',action:'Open approval queue',href:'/hr?tab=leave',caveat:'Missing attendance does not establish an absence.',domain:'hr'},
 'hr-history':{label:'Historical coverage',action:'Inspect coverage',href:'/hr-history',caveat:'Imported date grids are source reports, not inferred daily attendance.',domain:'hr'},
 shifts:{label:'Effective shifts',action:'Review shift assignments',href:'/shifts',caveat:'Capacity cannot be calculated without an effective shift.',domain:'hr'},
 payroll:{label:'Payroll readiness',action:'Inspect salary sources',href:'/hr?tab=payroll',caveat:'Salary sources require a separate grant and audited reads; payroll values stay in payroll.',domain:'payroll'},
 money:{label:'Finance certification',action:'Review reconciliation',href:'/finance',caveat:'Certified revenue and collections are not supplied by receipt funding observations.',domain:'finance'},
 leadership:{label:'Portfolio decisions',action:'Inspect portfolio sources',href:'/leadership',caveat:'A trend alarm requires eight complete comparable weeks and calendar context.',domain:'work'},
 chats:{label:'Linked work',action:'Open linked work',href:'/chats',caveat:'Private message text is excluded. Explicit linked-work intake is not connected yet.',domain:'communication'},
 inbox:{label:'Mailbox next steps',action:'Open own mailbox',href:'/inbox',caveat:'Mail text is excluded from intelligence; only explicit linked work can become a card.',domain:'communication'},
 settings:{label:'Connection coverage',action:'Inspect connected accounts',href:'/settings?tab=connected',caveat:'Connector permission-expiry and device-version events need authorized metadata intake.',domain:'settings'},
 'review-data':{label:'Source ambiguities',action:'Inspect review queue',href:'/review-data',caveat:'Suggestions require an individual authorized decision.',domain:'review'},
 audit:{label:'Recent corrections',action:'Inspect metadata audit',href:'/audit',caveat:'Audit narratives use metadata only; restricted source values are excluded.',domain:'audit'},
 portal:{label:'Client next step',action:'Open released work',href:'/portal',caveat:'A distinct client principal and released-artifact projection are not configured.',domain:'client'},
 briefs:{label:'Role brief',action:'Open in-app brief',href:'/briefs',caveat:'Frozen facts retain their original vintage; current permission is rechecked on open.',domain:'personal'},
 unknown:{label:'No insight yet',action:'Open own desk',href:'/me',caveat:'This surface has no domain provider yet. No performance claim is inferred.',domain:'personal'}
};
export function surfaceFor(path: string, tab?: string|null) {
 const part=path.split('/').filter(Boolean);
 const aliases:Record<string,string>={finance:'money','insights-demo':'demo','my-week':'tasks',activity:'people',deliveries:'projects',notifications:'me',groups:'chats',communication:'chats',opshub:'review-data',attendance:'me',leave:'me',pod:'leadership',pods:'leadership'};
 if(part[0]==='stewardship')return ({client:'clients',contact:'contacts',person:'people',project:'projects'} as Record<string,string>)[part[1]]??'unknown';
 if((part[0]==='hr'||part[0]==='money'||part[0]==='finance')&&tab==='payroll')return 'payroll';
 return part[0] in SURFACES?part[0]:aliases[part[0]]??'unknown';
}

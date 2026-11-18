import test from 'node:test';
import assert from 'node:assert/strict';
import { makeInsight, rank, validatedNarrative, workingDaysLate, surfaceFor } from '../dist/intelligence-model.js';
const c={cause_key:'review:synthetic',facts:[{id:'fact-1',statement:'Review due',override_version:'1'}],headline:'Review due',meaning:'The agreed window passed.',hypotheses:[],next_action:{label:'Review',href:'/tasks'},coverage:'1 agreement',severity:3,urgency:3,actionability:3,evidence_strength:3};
test('replay identity is stable, revised evidence creates a new receipt',()=>{
 const a=makeInsight('org','viewer',c,'2026-10-06T00:00:00Z'),b=makeInsight('org','viewer',c,'2026-10-06T01:00:00Z');assert.equal(a.id,b.id);assert.equal(rank([a,b]).length,1);
 assert.notEqual(a.id,makeInsight('org','viewer',{...c,facts:[{...c.facts[0],override_version:'2'}]},a.as_of).id);
 assert.notEqual(a.id,makeInsight('org','other',c,a.as_of).id);
});
test('unsupported model facts fall back, including fabricated causes and numeric confidence',()=>{
 const a=makeInsight('org','viewer',c,'2026-10-06T00:00:00Z');
 assert.equal(validatedNarrative(a,{headline:'Employee inactive',meaning:'90% likely',fact_ids:['fact-1']},true).renderer,'deterministic');
 assert.equal(validatedNarrative(a,{headline:c.headline,meaning:c.meaning,fact_ids:['private']},true).renderer,'deterministic');
 assert.equal(validatedNarrative(a,{headline:c.headline,meaning:c.meaning,fact_ids:['fact-1']},true).renderer,'validated');
 assert.equal(validatedNarrative(a,{headline:c.headline,meaning:c.meaning,fact_ids:['fact-1']}).renderer,'deterministic');
});
test('agreed working-day deadline respects holidays and non-working days',()=>{
 assert.equal(workingDaysLate('2026-10-02T12:00:00Z','2026-10-06T12:00:00Z','Asia/Kolkata',[1,2,3,4,5],['2026-10-05']),1);
});
test('routes register truthful providers, including profile and future route fallback',()=>{
 for(const path of ['/insights-demo','/dashboard','/projects/x','/tasks','/clients/x','/contacts/x','/map','/people/x','/me','/hr','/hr-history','/shifts','/money','/leadership','/chats','/inbox','/settings','/review-data','/audit','/portal','/briefs'])assert.notEqual(surfaceFor(path),'unknown',path);
 assert.equal(surfaceFor('/hr','payroll'),'payroll');assert.equal(surfaceFor('/new-route'),'unknown');
});

test('equal actionable candidates rank current evidence above unknown coverage',()=>{const a=makeInsight('org','viewer',{...c,cause_key:'fresh',facts:[{...c.facts[0],freshness:'current'}]},'2026-10-06T09:00:00Z'),b=makeInsight('org','viewer',{...c,cause_key:'unknown',facts:[{...c.facts[0],freshness:'unknown'}]},a.as_of);assert.equal(rank([b,a])[0].id,a.id);});

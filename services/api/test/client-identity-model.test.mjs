import test from 'node:test';import assert from 'node:assert/strict';
import {compareIdentity,normalizeIdentity,validIdentitySourceRef} from '../dist/client-identity-model.js';
const entity=(id,name,kind='person',assertions=[],legalOrgId=null)=>({id,name,kind,assertions,legalOrgId});
const crm=(id,value,extra={})=>({id,entity_id:id,entity_type:'client',kind:'external_id',value,verified:true,shared:false,source_scope:'synthetic.crm.tenant',source_family:'synthetic.crm',source_ref:'/synthetic',...extra});
test('name alone unresolved; matching scoped CRM identity is review evidence',()=>{
 const a=entity('a','Contact A'),b=entity('b','Contact A Full');assert.equal(compareIdentity(a,b).candidate,false);
 a.assertions=[crm('a','42')];b.assertions=[crm('b','42')];const p=compareIdentity(a,b);assert.equal(p.candidate,true);assert.equal(p.mergeBlocked,false);assert.equal(p.supporting.length,1);
});
test('shared representative, distinct firms, and incompatible kinds cannot collapse',()=>{
 const rep=crm('rep','shared@example.test',{kind:'email',shared:true});assert.equal(compareIdentity(entity('a','Firm A','company',[rep],'org-a'),entity('b','Firm B','company',[rep],'org-b')).candidate,false);
 assert.equal(compareIdentity(entity('a','Person','person',[crm('a','42')]),entity('b','Company','company',[crm('b','42')])).mergeBlocked,true);
 assert.equal(compareIdentity(entity('a','Person','person',[crm('a','41')]),entity('b','Person','person',[crm('b','42')])).mergeBlocked,true);
});
test('Unicode scripts and single-token ambiguity survive normalization',()=>{
 assert.equal(normalizeIdentity('  अनिल  शर्मा '),'अनिल शर्मा');assert.equal(normalizeIdentity('ＡＣＭＥ'),'acme');
 assert.ok(compareIdentity(entity('a','अनिल'),entity('b','अनिल')).warnings.some(w=>w.includes('Single-token')));
});
test('correlated copies count once; other-tenant identifiers do not block candidates',()=>{
 const a=entity('a','Name','person',[crm('a','42'),crm('copy','42')]),b=entity('b','Name','person',[crm('b','42')]);assert.equal(compareIdentity(a,b).supporting.length,1);
 assert.equal(compareIdentity(a,entity('b','Name','person',[crm('b','42',{source_scope:'different.crm'})])).candidate,false);
});

test('same organisation alone does not merge its different representatives',()=>{const organization=id=>crm(id,'org-42',{kind:'organization'});assert.equal(compareIdentity(entity('a','Anil Soniba','person',[organization('a')]),entity('b','Mira Soniba','person',[organization('b')])).candidate,false);});
test('receipt references accept scoped paths and secure links; reject pasted text and scripts',()=>{for(const ref of ['/clients/42','https://crm.example/receipt/42'])assert.equal(validIdentitySourceRef(ref),true);for(const ref of ['private text here','javascript:alert(1)','//other.example','https://user:password@example.test/'])assert.equal(validIdentitySourceRef(ref),false);});

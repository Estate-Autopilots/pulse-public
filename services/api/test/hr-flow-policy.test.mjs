import test from 'node:test';
import assert from 'node:assert/strict';
import {leaveNeedsHr} from '../dist/hr-flow-policy.js';
const base={days:3,paid:true,available:4,pending:1,buffer:0,threshold:3,special:false,compOff:false};
test('exact day and reserved-balance thresholds stay within policy',()=>assert.deepEqual(leaveNeedsHr(base),[]));
test('half-day beyond remaining allowance needs HR',()=>assert.deepEqual(leaveNeedsHr({...base,days:3.5}),['long leave','beyond balance']));
test('unpaid and special requests require HR even with allowance',()=>assert.deepEqual(leaveNeedsHr({...base,paid:false,special:true}),['unpaid leave','special or emergency leave']));
test('a no-allowance paid type is decided by its approver without an invented balance',()=>assert.deepEqual(leaveNeedsHr({...base,available:null}),[]));
test('the explicit balance buffer includes its boundary but not the next half day',()=>{
 assert.deepEqual(leaveNeedsHr({...base,days:3.5,threshold:5,buffer:.5}),[]);
 assert.deepEqual(leaveNeedsHr({...base,days:4,threshold:5,buffer:.5}),['beyond balance']);
});
test('comp-off availability is enforced separately and cannot become extra leave',()=>assert.deepEqual(leaveNeedsHr({...base,days:1,available:0,compOff:true}),[]));

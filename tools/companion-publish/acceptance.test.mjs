import test from 'node:test';
import assert from 'node:assert/strict';
import {verifySimulatorAcceptance, simulatorBuiltButScreenTestFailed, simulatorUIJobFailed} from './acceptance.mjs';
const expected = {runId:'123',commit:'a'.repeat(40),archiveSha256:'b'.repeat(64)};
const proof = {...expected,buildRun:'123',buildCommit:expected.commit,artifactName:`companion-ios-simulator-${expected.commit}`,signatureUnchanged:true,screens:['start','out','in','break','done','in-dark'],checks:['native Pip colors verified in Dynamic Island'],activityScreens:['ios-island.png','ios-lock-screen.png']};
test('acceptance pins the exact source, build, artifact and unchanged archive', () => {
  verifySimulatorAcceptance(proof,expected);
  for (const changed of [{buildRun:'124'},{buildCommit:'c'.repeat(40)},{artifactName:'another-app'},{archiveSha256:'d'.repeat(64)},{signatureUnchanged:false},{screens:['start','in']},{checks:[]},{activityScreens:['ios-island.png']}]) {
    assert.throws(() => verifySimulatorAcceptance({...proof,...changed},expected));
  }
});
test('UI acceptance cannot rescue a native compile failure or another failed step', () => {
  const job={name:'ios-simulator',conclusion:'failure',steps:[{name:'Build the app scheme (not the first CocoaPods library scheme)',conclusion:'success'},{name:'Run actions/upload-artifact@v7',conclusion:'success'},{name:'Install the app and capture the four attendance states',conclusion:'failure'}]};
  assert.equal(simulatorBuiltButScreenTestFailed(job),true);
  assert.equal(simulatorBuiltButScreenTestFailed({...job,name:'android'}),false);
  assert.equal(simulatorBuiltButScreenTestFailed({...job,conclusion:'cancelled'}),false);
  assert.equal(simulatorBuiltButScreenTestFailed({...job,steps:[{...job.steps[0],conclusion:'failure'},...job.steps.slice(1)]}),false);
  assert.equal(simulatorBuiltButScreenTestFailed({...job,steps:[...job.steps,{name:'another check',conclusion:'failure'}]}),false);
});

test('separate acceptance can replace only the reusable UI check, never artifact retrieval',()=>{
 const job={name:'ios-screens / simulator',conclusion:'failure',steps:[{name:'Run actions/download-artifact@v7',conclusion:'success'},{name:'Verify the unchanged app and all attendance screens',conclusion:'failure'}]};
 assert.equal(simulatorUIJobFailed(job),true);
 assert.equal(simulatorUIJobFailed({...job,name:'ios-device'}),false);
 assert.equal(simulatorUIJobFailed({...job,steps:[{...job.steps[0],conclusion:'failure'},job.steps[1]]}),false);
});

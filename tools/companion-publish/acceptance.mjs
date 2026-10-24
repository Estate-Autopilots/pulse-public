import assert from 'node:assert/strict';

/** A separate UI run may accept only the exact, unchanged archive that already compiled. */
export function verifySimulatorAcceptance(proof, { runId, commit, archiveSha256 }) {
  assert.equal(proof.buildRun, String(runId), 'Acceptance belongs to another build run');
  assert.equal(proof.buildCommit, commit, 'Acceptance belongs to another client source');
  assert.equal(proof.artifactName, `companion-ios-simulator-${commit}`, 'Wrong accepted artifact');
  assert.match(archiveSha256, /^[a-f0-9]{64}$/);
  assert.equal(proof.archiveSha256, archiveSha256, 'Accepted archive checksum differs');
  assert.equal(proof.signatureUnchanged, true, 'Acceptance must not modify the app signature');
  assert.ok(proof.checks?.includes('native Pip colors verified in Dynamic Island'), 'Native Pip placeholder check must pass');
  for (const name of ['ios-island.png','ios-lock-screen.png']) assert.ok(proof.activityScreens?.includes(name), 'Missing Live Activity capture');
  for (const state of ['start', 'out', 'in', 'break', 'done', 'in-dark']) {
    assert.ok(proof.screens?.includes(state), `Missing accepted screen: ${state}`);
  }
}

export function simulatorBuiltButScreenTestFailed(job) {
  return job?.name === 'ios-simulator' && job.conclusion === 'failure'
    && job.steps?.some(s => s.name.startsWith('Build the app scheme') && s.conclusion === 'success')
    && job.steps.some(s => s.name === 'Run actions/upload-artifact@v7' && s.conclusion === 'success')
    && job.steps.filter(s => s.conclusion === 'failure').length === 1
    && job.steps.some(s => s.name === 'Install the app and capture the four attendance states' && s.conclusion === 'failure');
}

/** The required reusable UI job can be retried against the same already-built archive. */
export function simulatorUIJobFailed(job) {
  return job?.name === 'ios-screens / simulator' && job.conclusion === 'failure'
    && job.steps?.some(s => s.name === 'Run actions/download-artifact@v7' && s.conclusion === 'success')
    && job.steps.filter(s => s.conclusion === 'failure').length === 1
    && job.steps.some(s => s.name === 'Verify the unchanged app and all attendance screens' && s.conclusion === 'failure');
}

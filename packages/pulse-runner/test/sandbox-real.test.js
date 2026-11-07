// Exercises real bubblewrap. Skipped, visibly, on a machine without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTmp } from './helpers.js';
import { pathsFor } from '../src/paths.js';
import { ensureStateDirs, saveCredential } from '../src/store.js';
import { Isolation, findOnPath } from '../src/sandbox.js';

const hasBwrap = Boolean(findOnPath('bwrap'));
const skip = hasBwrap ? false : 'bubblewrap is not installed on this machine';

function prepare(t) {
  const paths = pathsFor(path.join(makeTmp(t), 'state'));
  ensureStateDirs(paths);
  saveCredential(paths, { runnerId: 'r', orgId: 'o', credential: 'prc_realsandboxtest' });
  const jobDir = path.join(paths.jobsDir, 'job1');
  const work = path.join(jobDir, 'work');
  fs.mkdirSync(work, { recursive: true });
  return { paths, jobDir, work };
}

test('real bwrap: the self-test passes', { skip }, async (t) => {
  const { paths } = prepare(t);
  const status = await new Isolation({ mode: 'bwrap', paths }).probe();
  assert.equal(status.verified, true, status.reason);
});

test('real bwrap: a job cannot read the credential, by path or through /proc', { skip }, async (t) => {
  const { paths, jobDir, work } = prepare(t);
  const isolation = new Isolation({ mode: 'bwrap', paths });
  const script = `cat "${paths.credentialFile}" 2>/dev/null; cat /proc/${process.pid}/environ 2>/dev/null; ls -la "${paths.configDir}" 2>/dev/null; echo done > "${work}/written"; echo FINISHED`;
  const wrapped = isolation.wrap({ cmd: '/bin/sh', args: ['-c', script], cwd: work, jobDir });
  const result = spawnSync(wrapped.cmd, wrapped.args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.match(result.stdout, /FINISHED/, result.stderr);
  assert.ok(!result.stdout.includes('prc_realsandboxtest'));
  assert.ok(!result.stdout.includes('credential.json'));
  assert.ok(fs.existsSync(path.join(work, 'written')), 'the job can write to its workdir');
});

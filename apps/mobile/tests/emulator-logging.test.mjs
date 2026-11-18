import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('hosted emulator logging preserves arguments, both output streams and the exit code', () => {
  const root = mkdtempSync(join(tmpdir(), 'pulse-emulator-logging-'));
  try {
    const sdk = join(root, 'sdk'), workspace = join(root, 'workspace');
    mkdirSync(join(sdk, 'emulator'), { recursive: true });
    mkdirSync(workspace);
    const emulator = join(sdk, 'emulator/emulator');
    writeFileSync(emulator, '#!/bin/sh\nprintf "arg:%s\\n" "$@"\nprintf "native diagnostic\\n" >&2\nexit 3\n', { mode: 0o755 });
    const env = { ...process.env, ANDROID_HOME: sdk, GITHUB_WORKSPACE: workspace };
    const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/log-emulator.sh');
    assert.equal(spawnSync('bash', [script], { env }).status, 0);
    const run = spawnSync(emulator, ['-avd', 'Test phone'], { env, encoding: 'utf8' });
    assert.equal(run.status, 3);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, '');
    assert.equal(readFileSync(join(workspace, 'screens/emulator-host.log'), 'utf8'), 'arg:-avd\narg:Test phone\nnative diagnostic\nPulse emulator exit status: 3\n');
    const second = spawnSync(emulator, ['-help-gpu'], { env, encoding: 'utf8' });
    assert.equal(second.status, 3);
    assert.equal(readFileSync(join(workspace, 'screens/emulator-host.log'), 'utf8'), 'arg:-avd\narg:Test phone\nnative diagnostic\nPulse emulator exit status: 3\narg:-help-gpu\nnative diagnostic\nPulse emulator exit status: 3\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

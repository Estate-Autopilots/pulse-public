// AI-FIX (19 Nov 2026, BUG-CENSUS BC-006): "Sign in with a subscription" answered 500 in 5 ms on production: the image's
// user may not write its home (/app), so the private folder failed first; and the image has no Claude Code or Codex.
// The private folder falls back to one this user owns in the system temp folder, and the sign-in is offered only where
// its CLI is on the path; otherwise POST /api/v0/ai/signin is refused in words (409) with what to do instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onCliPath, privateStateDir, SIGNIN_ELSEWHERE } from '../dist/connect-ai.js';

test('a CLI counts only when an executable of that name is on the path', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'aifix-bin-'));
  try {
    await writeFile(join(bin, 'claude'), '#!/bin/sh\n'); await chmod(join(bin, 'claude'), 0o755);
    await writeFile(join(bin, 'codex'), 'not executable'); await chmod(join(bin, 'codex'), 0o644);
    assert.equal(await onCliPath('claude', `/nonexistent:${bin}`), true);
    assert.equal(await onCliPath('codex', bin), false, 'present but not executable');
    assert.equal(await onCliPath('script', bin), false);
  } finally { await rm(bin, { recursive: true, force: true }); }
});

test('the private folder: the configured one, else the home\'s, else one of this user\'s own in the temp folder', { skip: process.getuid?.() === 0 && 'root writes anywhere' }, async () => {
  const saved = { home: process.env.HOME, dir: process.env.PULSE_AI_STATE_DIR };
  const mine = await mkdtemp(join(tmpdir(), 'aifix-state-'));
  try {
    process.env.PULSE_AI_STATE_DIR = join(mine, 'set');
    assert.equal(await privateStateDir(), join(mine, 'set'));
    delete process.env.PULSE_AI_STATE_DIR;
    const home = join(mine, 'home'); await mkdir(home); await chmod(home, 0o555);   // a home this user may not write (production's /app)
    process.env.HOME = home;
    const d = await privateStateDir();
    await chmod(home, 0o755);
    assert.ok(d && d.startsWith(tmpdir()) && d.endsWith(`pulse-ai-${process.getuid()}`), String(d));
  } finally {
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    if (saved.dir === undefined) delete process.env.PULSE_AI_STATE_DIR; else process.env.PULSE_AI_STATE_DIR = saved.dir;
    await rm(mine, { recursive: true, force: true });
  }
});

test('the refusal says what to do instead', () => {
  assert.match(SIGNIN_ELSEWHERE.claude, /claude setup-token/);
  assert.match(SIGNIN_ELSEWHERE.codex, /workspace server|API key/);
});

#!/usr/bin/env python3
"""Run a release job's script from the exact shipped release checkout, never from an installed copy (POLISH-2).

OPS-DATA found the installed copy of the finance sync runner (~/.local/lib/pulse-release/finance-sync-run.py) still
the old one after a release changed it: every runner the timers start was copied there by hand, and a release that
changed one did not update the copy. This launcher is the only file installed; it is small and does not change with
the jobs. Each run it finds the checkout of the release recorded in train.json and executes that checkout's own
tools/<script>, so the script always matches the code it runs.

    release-run.py finance-sync-run.py [args...]

Only the scripts in RUNNERS can be started. Nothing runs when no healthy shipped checkout is found (the runner itself
then cannot pin one either); the error is printed and the exit code is non-zero, as the runner's own would be.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

RUNNERS = {'finance-sync-run.py', 'drive-refresh-run.py', 'hr-notifications-run.py'}
STATE = Path(os.environ.get('PULSE_RELEASE_STATE', str(Path.home() / '.local/state/pulse-release')))
WORKSPACE = Path(os.environ.get('PULSE_RELEASE_WORKSPACE', str(Path.home() / 'work/pulse')))


def release_checkout(state, workspace):
    """The newest release-train-* checkout at the recorded release, clean, with its virtualenv."""
    sha = state.get('release_sha')
    if not sha:
        return None
    for path in sorted(workspace.glob('release-train-*'), reverse=True):
        head = subprocess.run(['git', '-C', str(path), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=False)
        if head.returncode or head.stdout.strip() != sha or not (path / '.venv/bin/python').is_file():
            continue
        if subprocess.run(['git', '-C', str(path), 'diff', '--quiet', 'HEAD'], check=False).returncode:
            continue
        return path
    return None


def main(argv):
    if len(argv) < 2 or argv[1] not in RUNNERS:
        print('usage: release-run.py {' + ','.join(sorted(RUNNERS)) + '} [args...]', file=sys.stderr)
        return 2
    try:
        state = json.loads((STATE / 'train.json').read_text())
    except (OSError, ValueError):
        print('release-run: no release recorded (train.json)', file=sys.stderr)
        return 1
    checkout = release_checkout(state, WORKSPACE)
    script = checkout / 'tools' / argv[1] if checkout else None
    if not script or not script.is_file():
        print('release-run: the shipped release checkout (or its ' + argv[1] + ') is unavailable', file=sys.stderr)
        return 1
    # The runner pins the same checkout again under the release lock; it knows it was started from a release.
    os.environ['PULSE_RELEASE_RUNNER'] = str(checkout)
    os.execv(sys.executable, [sys.executable, str(script), *argv[2:]])
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))

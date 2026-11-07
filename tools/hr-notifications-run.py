#!/usr/bin/env python3
"""Deliver HR notifications with the exact shipped release's worker, never the workbench."""
import json
import os
import subprocess
from pathlib import Path


def release_checkout(state, workspace):
    sha = state.get('release_sha')
    if not sha:
        return None
    for path in sorted(workspace.glob('release-train-*'), reverse=True):
        result = subprocess.run(['git', '-C', str(path), 'rev-parse', 'HEAD'], capture_output=True, text=True)
        if result.returncode == 0 and result.stdout.strip() == sha and (path / '.venv/bin/python').is_file():
            return path
    return None


def main():
    state_path = Path.home() / '.local/state/pulse-release/train.json'
    if not state_path.is_file():
        return
    checkout = release_checkout(json.loads(state_path.read_text()), Path.home() / 'work/pulse')
    if not checkout:
        raise SystemExit('Shipped worker checkout unavailable')
    os.chdir(checkout)
    os.execv(str(checkout / '.venv/bin/python'), [str(checkout / '.venv/bin/python'), '-m', 'pulse_workers.notifications'])


if __name__ == '__main__':
    main()

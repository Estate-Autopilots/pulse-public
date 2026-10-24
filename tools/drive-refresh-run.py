#!/usr/bin/env python3
"""Six-hour production import, pinned to the healthy shipped release, with a private receipt and failure alert."""
import fcntl
import json
import os
import shlex
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def load_index_env(env, path):
    for line in path.read_text().splitlines():
        if line.startswith('DATABASE_URL='):
            env['EA_INDEX_DATABASE_URL'] = shlex.split(line.split('=', 1)[1])[0]
    if not env.get('EA_INDEX_DATABASE_URL'):
        raise RuntimeError('EA_INDEX_DATABASE_URL is missing')


def shipped_checkout(state, workspace):
    sha = state['release_sha']
    deployed = json.loads(Path('/var/lib/ea-watchdog/deploy-production.json').read_text())
    if deployed.get('sha') != sha or not deployed.get('healthy'):
        raise RuntimeError('Production release is not healthy')
    for path in sorted(workspace.glob('release-train-*'), reverse=True):
        result = subprocess.run(['git', '-C', str(path), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True)
        if result.stdout.strip() == sha and (path / '.venv/bin/python').is_file():
            clean = subprocess.run(['git', '-C', str(path), 'diff', '--quiet', 'HEAD'], check=False)
            if clean.returncode:
                raise RuntimeError('Shipped importer has local edits')
            return path
    raise RuntimeError('Shipped importer checkout unavailable')


def main():
    os.umask(0o077)
    state = Path.home() / '.local/state/pulse-release'
    receipts = state / 'drive-refresh'
    receipts.mkdir(parents=True, exist_ok=True)
    receipt = {'started_at': datetime.now(timezone.utc).isoformat(), 'ok': False}
    path = receipts / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ') + '.json')
    path.write_text(json.dumps(receipt, indent=2) + '\n')  # A killed or interrupted attempt still has a receipt.
    # Acquire the release lock before requesting a CPU slot: the train also takes locks in this order.
    with (state / 'release.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            release = json.loads((state / 'train.json').read_text())
            checkout = shipped_checkout(release, Path.home() / 'work/pulse')
            receipt['release_sha'] = release['release_sha']
            env = {k: v for k, v in os.environ.items() if k not in {
                'PULSE_DATABASE_URL_MIGRATE', 'MIGRATE_DATABASE_URL', 'PULSE_DATABASE_URL_API',
                'PULSE_DATABASE_URL_PRIVACY', 'PULSE_DATABASE_URL_INGEST'}}
            env['PULSE_REPO_ROOT'] = str(checkout)
            load_index_env(env, Path('/etc/estate-autopilots/db/ea_index.env'))
            result = subprocess.run(['/usr/local/bin/ea-heavy', str(checkout / '.venv/bin/python'),
                                     '-m', 'pulse_gdrive_snapshot.refresh'], cwd=checkout, env=env,
                                    capture_output=True, text=True, check=False)
            receipt['exit_code'] = result.returncode
            # Retain only the module's structured count receipt, never raw subprocess diagnostics.
            for line in reversed(result.stdout.splitlines()):
                try:
                    output = json.loads(line)
                    if isinstance(output, dict):
                        receipt['import'] = output
                        break
                except ValueError:
                    pass
            receipt['ok'] = result.returncode == 0 and 'run_id' in receipt.get('import', {})
        except Exception as exc:
            receipt['error'] = type(exc).__name__
        finally:
            receipt['finished_at'] = datetime.now(timezone.utc).isoformat()
            path.write_text(json.dumps(receipt, indent=2) + '\n')
    if not receipt['ok']:
        subprocess.run(['ea-notify', '-l', 'important', '-t', 'Pulse Drive import failed',
                        'Production data refresh failed. Inspect the private receipt: ' + str(path)], check=False)
    print(json.dumps({'ok': receipt['ok'], 'receipt': str(path)}), flush=True)
    return 0 if receipt['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

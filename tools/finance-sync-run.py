#!/usr/bin/env python3
"""Six-hour live finance sync (FIN-LIVE), pinned to the healthy shipped release, with a private receipt and alert.

Reads EA's finance sheets and finance mail read-only, files invoice PDFs in the EA Finance Shared Drive and refreshes
Pulse's live finance tables for the EA tenant. CPU work runs through ea-heavy (one shared slot, nice 19).

POLISH-2: this script runs from the shipped release checkout itself (tools/release-run.py starts it there). Started
from anywhere else (an installed copy, or the previous release when a release finished while it waited for the lock),
it hands over to the pinned release's own runner, so the runner always matches the code it runs.

The pinned release is the commit production runs (deploy-production.json, healthy), not train.json: production is
also shipped directly with pulse_local_deploy.py, which leaves train.json behind (FIN-LIVE failed from 1 Nov 2026 on).
tools/shipped_release.py finds or creates the clean checkout of that commit.
"""
import fcntl
import json
import os
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import shipped_release  # noqa: E402  (tools/shipped_release.py beside this runner)

EA_ORG = '6f1a455d-ced2-504d-b8d5-5ae0efbe7c75'


def load_index_env(env, path):
    for line in path.read_text().splitlines():
        if line.startswith('DATABASE_URL='):
            env['EA_INDEX_DATABASE_URL'] = shlex.split(line.split('=', 1)[1])[0]
    if not env.get('EA_INDEX_DATABASE_URL'):
        raise RuntimeError('EA_INDEX_DATABASE_URL is missing')


def shipped_checkout(workspace):
    """(checkout, sha) of the healthy production commit (deploy-production.json), created when missing."""
    return shipped_release.shipped_checkout(workspace, 'finance sync')


def last_json(text):
    """The last structured line a worker printed (its count receipt); raw diagnostics are never kept."""
    for line in reversed(text.splitlines()):
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            return {k: v for k, v in value.items() if k in ('counts', 'dryRun', 'stored')}
    return None


def main():
    os.umask(0o077)
    state = Path.home() / '.local/state/pulse-release'
    receipts = state / 'finance-sync'
    receipts.mkdir(parents=True, exist_ok=True)
    receipt = {'started_at': datetime.now(timezone.utc).isoformat(), 'ok': False}
    path = receipts / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ') + '.json')
    path.write_text(json.dumps(receipt, indent=2) + '\n')  # A killed or interrupted attempt still has a receipt.
    # Acquire the release lock before requesting a CPU slot: the train takes locks in this order too.
    with (state / 'release.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            checkout, sha = shipped_checkout(Path.home() / 'work/pulse')
            runner = checkout / 'tools/finance-sync-run.py'
            if Path(__file__).resolve() != runner.resolve() and runner.is_file() and not os.environ.get('PULSE_RELEASE_HANDOVER'):
                # Not the release's own runner: the release's runner takes over (and writes its own receipt). The lock
                # file is not inherited (Python opens it close-on-exec), so it is free again for that runner.
                path.unlink(missing_ok=True)
                os.environ['PULSE_RELEASE_HANDOVER'] = str(checkout)
                os.execv(sys.executable, [sys.executable, str(runner), *sys.argv[1:]])
            receipt['runner'] = 'release' if Path(__file__).resolve() == runner.resolve() else 'copy'
            receipt['release_sha'] = sha
            env = {k: v for k, v in os.environ.items() if k not in {
                'PULSE_DATABASE_URL_MIGRATE', 'MIGRATE_DATABASE_URL', 'PULSE_DATABASE_URL_API',
                'PULSE_DATABASE_URL_PRIVACY', 'PULSE_DATABASE_URL_INGEST'}}
            env['PULSE_REPO_ROOT'] = str(checkout)
            load_index_env(env, Path('/etc/estate-autopilots/db/ea_index.env'))
            result = subprocess.run(['/usr/local/bin/ea-heavy', str(checkout / '.venv/bin/python'), '-m', 'pulse_workers.finance_live',
                                     'sync', '--org', os.environ.get('PULSE_FINANCE_ORG', EA_ORG)],
                                    cwd=checkout, env=env, capture_output=True, text=True, check=False)
            receipt['exit_code'] = result.returncode
            # Retain only the module's structured count receipt, never raw subprocess diagnostics.
            for line in reversed(result.stdout.splitlines()):
                try:
                    output = json.loads(line)
                    if isinstance(output, dict):
                        receipt['sync'] = output
                        break
                except ValueError:
                    pass
            receipt['ok'] = result.returncode == 0 and receipt.get('sync', {}).get('ok') is True
            # R55: the talent index (shoot sheets, read-only) and the place index (prices and invoice parties in project
            # documents) refresh the map's money, prices and geocode suggestions from the same sources. Their counts
            # are kept in the receipt; a failure there is noted and never fails the finance sync.
            if receipt['ok']:
                for key, module in (('talent', 'pulse_workers.talent_index'), ('places', 'pulse_workers.place_index')):
                    step = subprocess.run(['/usr/local/bin/ea-heavy', str(checkout / '.venv/bin/python'), '-m', module,
                                           '--org', os.environ.get('PULSE_FINANCE_ORG', EA_ORG)],
                                          cwd=checkout, env=env, capture_output=True, text=True, check=False)
                    receipt[key] = last_json(step.stdout) or {'exit_code': step.returncode}
                    receipt[key]['ok'] = step.returncode == 0
        except Exception as exc:
            receipt['error'] = type(exc).__name__
            receipt['error_message'] = shipped_release.error_text(exc)  # 120 characters, URLs and credentials removed
        finally:
            receipt['finished_at'] = datetime.now(timezone.utc).isoformat()
            path.write_text(json.dumps(receipt, indent=2) + '\n')
    if not receipt['ok']:
        subprocess.run(['ea-notify', '-l', 'important', '-t', 'Pulse finance sync failed',
                        'The six-hour live finance sync failed. Inspect the private receipt: ' + str(path)], check=False)
    print(json.dumps({'ok': receipt['ok'], 'receipt': str(path)}), flush=True)
    return 0 if receipt['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

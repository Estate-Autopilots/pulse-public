#!/usr/bin/env python3
"""Run a release job's script from the exact shipped release checkout, never from an installed copy (POLISH-2).

OPS-DATA found the installed copy of the finance sync runner (~/.local/lib/pulse-release/finance-sync-run.py) still
the old one after a release changed it: every runner the timers start was copied there by hand, and a release that
changed one did not update the copy. This launcher (with tools/shipped_release.py beside it) is all that is
installed; it is small and does not change with the jobs. Each run it finds the checkout of the shipped release and
executes that checkout's own tools/<script>, so the script always matches the code it runs.

    release-run.py finance-sync-run.py [args...]

Only the scripts in RUNNERS can be started. Nothing runs when no healthy shipped checkout is found (the runner itself
then cannot pin one either); the error is printed and the exit code is non-zero, as the runner's own would be.

The shipped release is the commit production runs (deploy-production.json, healthy), not train.json, which a direct
ship with pulse_local_deploy.py leaves behind. tools/shipped_release.py, installed beside this launcher, finds the
clean checkout of that commit or creates ~/work/pulse/shipped-<sha12> with its virtualenv.
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import shipped_release  # noqa: E402  (installed beside this launcher, as in tools/)

RUNNERS = {'finance-sync-run.py', 'drive-refresh-run.py', 'hr-notifications-run.py'}
STATE = Path(os.environ.get('PULSE_RELEASE_STATE', str(Path.home() / '.local/state/pulse-release')))
WORKSPACE = Path(os.environ.get('PULSE_RELEASE_WORKSPACE', str(Path.home() / 'work/pulse')))
# Overridable for tests only; the units set none of these.
DEPLOY_STATE = Path(os.environ.get('PULSE_RELEASE_DEPLOY_STATE', str(shipped_release.DEPLOY_STATE)))
ORIGIN = Path(os.environ.get('PULSE_RELEASE_ORIGIN', str(shipped_release.ORIGIN)))
STRIKE = Path(os.environ.get('PULSE_RELEASE_STRIKE', str(shipped_release.STRIKE)))


def release_checkout():
    """The clean checkout of the healthy production commit, with its virtualenv (created when missing)."""
    checkout, _ = shipped_release.shipped_checkout(WORKSPACE, 'release job', deploy_state=DEPLOY_STATE, origin=ORIGIN,
                                                   strike=STRIKE, state=STATE)
    return checkout


def main(argv):
    if len(argv) < 2 or argv[1] not in RUNNERS:
        print('usage: release-run.py {' + ','.join(sorted(RUNNERS)) + '} [args...]', file=sys.stderr)
        return 2
    try:
        checkout = release_checkout()
    except RuntimeError as error:
        print('release-run: ' + shipped_release.error_text(error), file=sys.stderr)
        return 1
    script = checkout / 'tools' / argv[1]
    if not script.is_file():
        print('release-run: the shipped release checkout has no ' + argv[1], file=sys.stderr)
        return 1
    # The runner pins the same checkout again under the release lock; it knows it was started from a release.
    os.environ['PULSE_RELEASE_RUNNER'] = str(checkout)
    os.execv(sys.executable, [sys.executable, str(script), *argv[2:]])
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))

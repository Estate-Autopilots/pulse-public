"""The shipped production checkout the release jobs run from (FIN-LIVE fix, Nov 2026).

Production is the commit /var/lib/ea-watchdog/deploy-production.json records as deployed and healthy. train.json is
not consulted: a direct ship with pulse_local_deploy.py moves production without the release train, so train.json
(and the train's release-train-* checkouts) can lag behind it, and every job pinned to train.json then failed.

shipped_checkout() returns a clean checkout at the deployed commit with its virtualenv:
  1. the newest release-train-<stamp> checkout at that commit (the train built its .venv), when it has no local edits;
  2. otherwise ~/work/pulse/shipped-<sha12>, created on demand: a detached `git worktree add` of the commit from the
     bare repository (or strike when the bare repository lacks it), its .venv built the way the train builds one
     (`ea-heavy uv sync --locked --all-packages`), then marked ready. Older shipped-* checkouts are pruned, keeping
     the last two (the current one and the one before it, which a long job may still be running from).
A checkout with local edits is never used. Python 3 standard library only: the installed launcher imports it too.
"""
import fcntl
import json
import os
import re
import subprocess
from pathlib import Path

DEPLOY_STATE = Path('/var/lib/ea-watchdog/deploy-production.json')
ORIGIN = Path('/home/eadev/git/pulse.git')
STRIKE = Path('/home/eadev/work/pulse/strike')
STATE = Path.home() / '.local/state/pulse-release'
EA_HEAVY = '/usr/local/bin/ea-heavy'
PREFIX = 'shipped-'
READY = '.venv/.pulse-shipped-ready'  # written only after the virtualenv built completely
KEEP = 2
BUILD_PATH = '/home/eadev/.cargo/bin:/home/eadev/.local/opt/node/bin:/home/eadev/.local/bin:/usr/local/bin:/usr/bin:/bin'
SHA = re.compile(r'^[0-9a-f]{40}$')


def deployed_sha(deploy_state=DEPLOY_STATE):
    """The commit production runs, only when the deployer recorded it healthy."""
    try:
        deployed = json.loads(Path(deploy_state).read_text())
    except (OSError, ValueError):
        raise RuntimeError('Production deploy state unreadable') from None
    sha = deployed.get('sha') if isinstance(deployed, dict) else None
    if not deployed.get('healthy') or not isinstance(sha, str) or not SHA.match(sha):
        raise RuntimeError('Production release is not healthy')
    return sha


def _git(*args):
    return subprocess.run(['git', *args], capture_output=True, text=True, check=False)


def _head(path):
    result = _git('-C', str(path), 'rev-parse', 'HEAD')
    return result.stdout.strip() if result.returncode == 0 else None


def _clean(path):
    """No edits to tracked files (the check the runners always made)."""
    return _git('-C', str(path), 'diff', '--quiet', 'HEAD').returncode == 0


def _where(repo):
    """git options naming a repository: the bare one by its directory, strike by its work tree."""
    return ['-C', str(repo)] if (Path(repo) / '.git').exists() else ['--git-dir', str(repo)]


def _has_commit(repo, sha):
    return Path(repo).is_dir() and _git(*_where(repo), 'cat-file', '-e', sha + '^{commit}').returncode == 0


def build_venv(checkout):
    """Build the checkout's .venv as the release train does: uv sync of the locked workspace, under ea-heavy."""
    env = {k: v for k, v in os.environ.items()
           if k in ('HOME', 'LANG', 'LC_ALL', 'USER', 'LOGNAME') or (k.startswith('UV_') and k != 'UV_PROJECT_ENVIRONMENT')}
    env['PATH'] = BUILD_PATH
    result = subprocess.run([EA_HEAVY, 'uv', 'sync', '--locked', '--all-packages'], cwd=checkout, env=env,
                            capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError('Shipped checkout virtualenv build failed (uv exit %d)' % result.returncode)


def _add_worktree(target, sha, origin, strike, label):
    for repo in (origin, strike):
        if not _has_commit(repo, sha):
            continue
        where = _where(repo)
        result = _git(*where, 'worktree', 'add', '--detach', str(target), sha)
        if result.returncode == 0:
            return
        _git(*where, 'worktree', 'remove', '--force', str(target))  # a half-made checkout is not left behind
        raise RuntimeError('Shipped %s checkout could not be created' % label)
    raise RuntimeError('Shipped %s commit %s is not in the repository' % (label, sha[:12]))


def prune(workspace, current, keep=KEEP):
    """Remove shipped-* checkouts beyond the newest `keep` (counting `current`). Never one with any change."""
    others = []
    for path in Path(workspace).glob(PREFIX + '*'):
        if path.resolve() != Path(current).resolve() and (path / '.git').is_file():
            others.append(path)
    others.sort(key=lambda p: (p / '.git').stat().st_mtime, reverse=True)
    removed = []
    for path in others[max(keep - 1, 0):]:
        status = _git('-C', str(path), 'status', '--porcelain')
        common = _git('-C', str(path), 'rev-parse', '--path-format=absolute', '--git-common-dir')
        if status.returncode or status.stdout.strip() or common.returncode:
            continue  # local edits or untracked files: a person's work, left alone
        if _git('--git-dir', common.stdout.strip(), 'worktree', 'remove', '--force', str(path)).returncode == 0:
            removed.append(path.name)
    return removed


def shipped_checkout(workspace, label, deploy_state=DEPLOY_STATE, origin=ORIGIN, strike=STRIKE, state=None,
                     build=build_venv):
    """(checkout, sha): a clean checkout of the healthy production commit with a virtualenv, created when missing."""
    workspace = Path(workspace)
    sha = deployed_sha(deploy_state)
    for path in sorted(workspace.glob('release-train-*'), reverse=True):
        if _head(path) == sha and (path / '.venv/bin/python').is_file() and _clean(path):
            return path, sha
    target = workspace / (PREFIX + sha[:12])
    state = Path(state) if state else STATE
    state.mkdir(parents=True, exist_ok=True)
    # One job creates the checkout; another started meanwhile waits here and then finds it ready.
    with (state / 'shipped-checkout.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if target.exists():
            if _head(target) != sha:
                raise RuntimeError('Shipped %s checkout %s is not at the production commit' % (label, target.name))
        else:
            _add_worktree(target, sha, origin, strike, label)
        if not _clean(target):
            raise RuntimeError('Shipped %s has local edits' % label)
        if not ((target / READY).is_file() and (target / '.venv/bin/python').is_file()):
            build(target)
            if not (target / '.venv/bin/python').is_file():
                raise RuntimeError('Shipped %s virtualenv is missing its python' % label)
            (target / READY).write_text(sha + '\n')
        try:
            prune(workspace, target)
        except OSError:
            pass  # retention never fails the job
    return target, sha


_URL = re.compile(r'\b[a-zA-Z][a-zA-Z0-9+.-]*://\S+')
_ASSIGN = re.compile(r'(?i)\b([a-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|authorization|credential|dsn)'
                     r'[a-z0-9_]*)\b(\s*[=:]\s*)\S+')
_OPAQUE = re.compile(r'\b(?=[A-Za-z0-9_\-+/=]*[A-Z])(?=[A-Za-z0-9_\-+/=]*[a-z])(?=[A-Za-z0-9_\-+/=]*\d)'
                     r'[A-Za-z0-9_\-+/=]{24,}')


def error_text(exc, limit=120):
    """The first `limit` characters of an exception's first line, with URLs, credentials and opaque tokens removed."""
    text = str(exc).strip().splitlines()[0] if str(exc).strip() else ''
    text = _URL.sub('<url>', text)
    text = _ASSIGN.sub(lambda m: m.group(1) + m.group(2) + '<redacted>', text)
    text = _OPAQUE.sub('<redacted>', text)
    return text[:limit]
